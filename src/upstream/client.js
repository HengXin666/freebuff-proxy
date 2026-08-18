import { freebuffAuthHeaders } from '../auth-store.js'
import { logger } from '../util/log.js'
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici'

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
 * 带单次超时的 undici fetch：超时主动 abort 本次尝试。用独立的子 AbortController
 * 级联父 signal——单次尝试超时只拆掉这一次请求（回落池内下一个），不会把整个
 * 请求/其他代理尝试一起 abort；父 signal（客户端断开 / 全局超时）abort 时本次
 * 尝试立即随之失败。
 * @param {string} url
 * @param {{ signal?: AbortSignal, [k: string]: any }} init
 * @param {number} timeoutMs
 */
async function fetchWithAttemptTimeout(url, init, timeoutMs) {
  if (!(timeoutMs > 0)) return undiciFetch(url, init)
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (init.signal?.aborted) {
    // 父 signal 已中止（客户端断开/全局超时已发生）：本次尝试立即失败，
    // 不要等 20s 超时——否则池内每个代理都要空等一轮。
    controller.abort()
  } else {
    init.signal?.addEventListener('abort', onParentAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (timer.unref) timer.unref()
  try {
    return await undiciFetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onParentAbort)
  }
}


/**
 * 解析出网代理配置，返回统一结构：
 *   { kind: 'none', agent: null, url: null }
 *   { kind: 'single', agent: ProxyAgent|EnvHttpProxyAgent, url: string }
 *   { kind: 'pool', agents: ProxyAgent[], urls: string[], indexFor(key) }   // 全局代理池
 * 优先级：账号显式 proxy > upstream.proxies（全局池） > upstream.proxy > HTTP(S)_PROXY env。
 */
function resolveProxy(config, accountProxy, accountId) {
  const explicit = accountProxy || config?.upstream?.proxy
  if (explicit) {
    return {
      kind: 'single',
      url: explicit,
      agent: new ProxyAgent({ uri: explicit }),
      indexFor: () => 0,
    }
  }
  const pool = (config?.upstream?.proxies || []).filter(Boolean)
  if (pool.length) {
    return {
      kind: 'pool',
      urls: pool,
      agents: pool.map((u) => new ProxyAgent({ uri: u })),
      /** 稳定哈希：同一账号始终落到同一代理（保持 session IP 稳定） */
      indexFor: (key) => hashIndex(key, pool.length),
    }
  }
  const envSet = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some(
    (k) => Boolean(process.env[k]),
  )
  if (envSet) {
    return {
      kind: 'single',
      url: '(env HTTP(S)_PROXY)',
      agent: new EnvHttpProxyAgent(),
      indexFor: () => 0,
    }
  }
  return { kind: 'none', agent: null, url: null, indexFor: () => 0 }
}

function hashIndex(key, n) {
  let h = 5381
  for (const ch of String(key || '')) {
    h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  }
  return (h >>> 0) % n
}

/**
 * @param {import('../config.js').ProxyConfig} config
 * @param {string} token
 * @param {{ proxy?: string | null, accountId?: string }} [opts]
 *   proxy: 账号显式代理覆盖；accountId: 用于全局代理池的稳定分配（如账号邮箱）
 */
export function createUpstreamClient(config, token, opts = {}) {

  const apiBase = config.upstream.apiBase
  const loginBase = config.upstream.loginBase
  const proxyRes = resolveProxy(config, opts.proxy, opts.accountId)
  const poolIndex = proxyRes.kind === 'pool'
    ? proxyRes.indexFor(opts.accountId || token)
    : 0
  /** 该账号实际生效的代理 URL（用于控制台展示） */
  const proxyUrl =
    proxyRes.kind === 'pool' ? proxyRes.urls[poolIndex] : proxyRes.url

  /**
   * 带代理池的 fetch：
   *  - 无代理 / 单代理 / env：直接走对应 dispatcher
   *  - 全局池：优先本账号分配的代理，连接级失败（fetch 抛错）时依次回落到池内下一个；
   *    单次尝试带超时（`fetchWithAttemptTimeout`）——代理"连接成功但永不响应"
   *    （网络波动/黑洞）也会被视为失败并回落下一个，而不是干等到全局 timeoutMs。
   */
  async function fetchWithProxy(url, init) {
    if (proxyRes.kind !== 'pool' || proxyRes.agents.length <= 1) {
      const agent = proxyRes.agent
      return (agent ? undiciFetch : globalThis.fetch)(url, {
        ...init,
        ...(agent ? { dispatcher: agent } : {}),
      })
    }
    // 单代理尝试超时：取调用方超时与 20s 的较小值（代理 CONNECT + TLS + 响应头
    // 正常数秒内完成，20s 足够；整体请求的超时仍由 apiFetch 的 signal 兜底）。
    const callerMs =
      Number.isFinite(init.timeoutMs) && init.timeoutMs > 0 ? init.timeoutMs : 30_000
    const attemptMs = Math.min(callerMs, 20_000)
    let lastErr
    for (let i = 0; i < proxyRes.agents.length; i++) {
      const idx = (poolIndex + i) % proxyRes.agents.length
      try {
        return await fetchWithAttemptTimeout(
          url,
          { ...init, dispatcher: proxyRes.agents[idx] },
          attemptMs,
        )
      } catch (err) {
        lastErr = err
        logger.warn('proxy failed; trying next in pool', {
          proxy: proxyRes.urls[idx],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    throw lastErr
  }

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
      const res = await fetchWithProxy(url, {
        method: init.method || 'GET',
        headers,
        body: init.body,
        signal: controller.signal,
        timeoutMs,
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
    proxyUrl,

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
      const res = await fetchWithProxy(`${loginBase}/api/auth/cli/code`, {
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
      const res = await fetchWithProxy(`${loginBase}/api/auth/cli/status?${qs}`, {
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
          body.status === 'ip_capped' ||
          body.status === 'free_mode_rate_limited')
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

/**
 * 读取上游响应 body 文本，带超时兜底：上游发完响应头后 body 迟迟不来
 * （幽灵连接）时取消 body 读取，避免控制面请求永远挂起。
 * @param {Response} res
 * @param {number} [timeoutMs]
 */
export async function safeText(res, timeoutMs = 10_000) {
  if (!res || !res.body) return ''
  try {
    return await Promise.race([
      res.text(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          res.body?.cancel().catch(() => {})
          reject(new Error('upstream body read timeout'))
        }, timeoutMs)
        if (timer.unref) timer.unref()
      }),
    ])
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

/**
 * chat/completions 返回的账号级限流/配额错误：当前账号被上游限流，
 * 换一个账号重试可能成功（free_mode_rate_limited = 免费模式 30 分钟窗口限流，
 * 例如 "Free mode rate limit exceeded (30 minutes limit). Try again in 1 minute."）。
 */
const RATE_LIMIT_CODES = new Set([
  'free_mode_rate_limited',
  'rate_limited',
  'spend_limited',
  'ip_capped',
])

/**
 * 从 chat/completions 错误响应里提取"应换号重试"的限流 code。
 * 兼容多种返回形态：{ error: 'free_mode_rate_limited' } /
 * { error: { code: 'rate_limited' } } / { code: ... } / { status: ... }。
 * @param {any} body
 * @param {number} [status]
 * @returns {string | null}
 */
export function extractRateLimitError(body, status) {
  if (!body || typeof body !== 'object') return null
  const nested =
    body.error && typeof body.error === 'object' && !Array.isArray(body.error)
      ? body.error
      : null
  const code = nested?.code || body.error || body.code || body.status
  if (typeof code !== 'string') return null
  if (RATE_LIMIT_CODES.has(code)) return code
  return null
}

export function extractGateError(body, status) {
  if (!body || typeof body !== 'object') return null
  const nested =
    body.error && typeof body.error === 'object' && !Array.isArray(body.error)
      ? body.error
      : null
  const code =
    nested?.code ||
    (typeof body.error === 'string' ? body.error : null) ||
    body.code ||
    body.status
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
