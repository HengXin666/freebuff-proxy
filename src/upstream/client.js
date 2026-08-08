import { freebuffAuthHeaders } from '../auth-store.js'
import { logger } from '../util/log.js'

export const FREEBUFF_INSTANCE_HEADER = 'x-freebuff-instance-id'
export const FREEBUFF_MODEL_HEADER = 'x-freebuff-model'
export const FREEBUFF_COMPACT_SESSION_HEADER = 'x-freebuff-compact-session'

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, body?: any, retryAfterMs?: number }} [extra]
   */
  constructor(message, extra = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = extra.status
    this.code = extra.code
    this.body = extra.body
    this.retryAfterMs = extra.retryAfterMs
  }
}

function parseRetryAfterMs(value) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined
}

/**
 * @param {import('../config.js').ProxyConfig} config
 * @param {string} token
 */
export function createUpstreamClient(config, token) {
  const apiBase = config.upstream.apiBase
  const loginBase = config.upstream.loginBase

  async function apiFetch(path, init = {}) {
    const url = path.startsWith('http') ? path : `${apiBase}${path}`
    const headers = {
      ...(init.headers || {}),
    }
    // Login-issued tokens require x-codebuff-api-key (Bearer alone → 401).
    if (token && init.includeAuth !== false) {
      Object.assign(headers, freebuffAuthHeaders(token))
    }
    const controller = new AbortController()
    const timeoutMs = init.timeoutMs ?? config.limits.upstreamTimeoutSec * 1000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (init.signal) {
      if (init.signal.aborted) controller.abort()
      else {
        init.signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        })
      }
    }
    try {
      const res = await fetch(url, {
        method: init.method || 'GET',
        headers,
        body: init.body,
        signal: controller.signal,
        duplex: init.body && typeof init.body !== 'string' ? 'half' : undefined,
      })
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    apiBase,
    loginBase,
    token,

    async me(fields = ['id', 'email']) {
      const res = await apiFetch(`/api/v1/me?fields=${fields.join(',')}`, {
        method: 'GET',
        timeoutMs: 15_000,
      })
      if (!res.ok) {
        throw new UpstreamError(`GET /api/v1/me failed: ${res.status}`, {
          status: res.status,
          body: await safeText(res),
        })
      }
      return res.json()
    },

    async loginCode(fingerprintId) {
      const res = await fetch(`${loginBase}/api/auth/cli/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprintId }),
      })
      if (!res.ok) {
        throw new UpstreamError(`login code failed: ${res.status}`, {
          status: res.status,
          body: await safeText(res),
        })
      }
      return res.json()
    },

    async loginStatus({ fingerprintId, fingerprintHash, expiresAt }) {
      const qs = new URLSearchParams({
        fingerprintId,
        fingerprintHash,
        expiresAt,
      })
      const res = await fetch(`${loginBase}/api/auth/cli/status?${qs}`, {
        method: 'GET',
      })
      if (res.status === 401) return { pending: true }
      if (!res.ok) {
        throw new UpstreamError(`login status failed: ${res.status}`, {
          status: res.status,
          body: await safeText(res),
        })
      }
      return res.json()
    },

    /**
     * @param {'GET'|'POST'|'DELETE'} method
     * @param {{ model?: string, instanceId?: string, compact?: boolean, signal?: AbortSignal }} [opts]
     */
    async freebuffSession(method, opts = {}) {
      /** @type {Record<string, string>} */
      const headers = {
        ...freebuffAuthHeaders(token),
      }
      if (method === 'POST' && opts.model) {
        headers[FREEBUFF_MODEL_HEADER] = opts.model
      }
      if (method === 'GET' && opts.instanceId) {
        headers[FREEBUFF_INSTANCE_HEADER] = opts.instanceId
      }
      if (method === 'GET' && opts.compact) {
        headers[FREEBUFF_COMPACT_SESSION_HEADER] = '1'
      }

      const res = await apiFetch('/api/v1/freebuff/session', {
        method,
        headers,
        signal: opts.signal,
        timeoutMs: config.session.admitTimeoutMs,
        includeAuth: false, // already set
      })

      if (res.status === 404) {
        return { status: 'none' }
      }

      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
      const text = await res.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = { raw: text }
      }

      if (
        res.status === 403 &&
        body &&
        (body.status === 'country_blocked' || body.status === 'banned')
      ) {
        return body
      }
      if (
        res.status === 409 &&
        body &&
        (body.status === 'model_locked' || body.status === 'model_unavailable')
      ) {
        return body
      }
      if (
        res.status === 429 &&
        body &&
        (body.status === 'rate_limited' ||
          body.status === 'spend_limited' ||
          body.status === 'ip_capped')
      ) {
        return body
      }

      if (!res.ok) {
        throw new UpstreamError(
          `freebuff session ${method} failed: ${res.status}`,
          {
            status: res.status,
            code: body?.error || body?.status,
            body,
            retryAfterMs,
          },
        )
      }

      return body
    },

    /**
     * Register an agent run; returns server-issued runId required by chat/completions.
     * @param {{ agentId: string, ancestorRunIds?: string[] }} params
     */
    async startAgentRun(params) {
      const res = await apiFetch('/api/v1/agent-runs', {
        method: 'POST',
        headers: {
          ...freebuffAuthHeaders(token),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'START',
          agentId: params.agentId,
          ancestorRunIds: params.ancestorRunIds ?? [],
        }),
        includeAuth: false,
        timeoutMs: 30_000,
      })
      const text = await res.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = { raw: text }
      }
      if (!res.ok) {
        throw new UpstreamError(
          `startAgentRun failed: ${res.status} ${text.slice(0, 200)}`,
          { status: res.status, code: 'start_agent_run_failed', body },
        )
      }
      const runId = body?.runId
      if (!runId || typeof runId !== 'string') {
        throw new UpstreamError('startAgentRun response missing runId', {
          status: 502,
          code: 'start_agent_run_failed',
          body,
        })
      }
      return runId
    },

    /**
     * Best-effort finish so the run does not linger server-side.
     * @param {{ runId: string, status?: string, errorMessage?: string }} params
     */
    async finishAgentRun(params) {
      try {
        await apiFetch('/api/v1/agent-runs', {
          method: 'POST',
          headers: {
            ...freebuffAuthHeaders(token),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            action: 'FINISH',
            runId: params.runId,
            status: params.status || 'completed',
            totalSteps: 1,
            directCredits: 0,
            totalCredits: 0,
            errorMessage: params.errorMessage,
            steps: [],
          }),
          includeAuth: false,
          timeoutMs: 15_000,
        })
      } catch (err) {
        logger.warn('finishAgentRun failed', {
          runId: params.runId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },

    /**
     * Low-level passthrough to upstream API path.
     * @param {string} upstreamPath e.g. /api/v1/chat/completions
     * @param {{ method: string, headers?: Record<string,string>, body?: any, signal?: AbortSignal, timeoutMs?: number }} init
     */
    async raw(upstreamPath, init) {
      const headers = {
        ...(init.headers || {}),
        ...freebuffAuthHeaders(token),
      }
      return apiFetch(upstreamPath, {
        method: init.method,
        headers,
        body: init.body,
        signal: init.signal,
        timeoutMs: init.timeoutMs,
        includeAuth: false,
      })
    },
  }
}

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

const GATE_CODES = new Set([
  'waiting_room_required',
  'waiting_room_queued',
  'session_superseded',
  'session_model_mismatch',
  'session_expired',
  'free_mode_capacity_deferred',
])

export function extractGateError(body, status) {
  if (!body || typeof body !== 'object') return null
  const code = body.error || body.code
  if (typeof code !== 'string') return null
  // Status may vary; code is the source of truth.
  if (GATE_CODES.has(code)) return code
  return null
}

/** Gates where re-admit (same or next account) can recover the request. */
export function isSessionRecoverableGate(code) {
  return (
    code === 'waiting_room_required' ||
    code === 'waiting_room_queued' ||
    code === 'session_expired' ||
    code === 'session_model_mismatch' ||
    code === 'session_superseded' ||
    code === 'free_mode_capacity_deferred'
  )
}
