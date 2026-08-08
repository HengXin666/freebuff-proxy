import {
  requireModelId,
  buildModelsListResponse,
  modelIdsFromSession,
  agentIdForModel,
} from './model.js'
import {
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
  UpstreamError,
} from './upstream/client.js'
import { timingSafeEqual } from 'node:crypto'
import {
  filterRequestHeaders,
  filterResponseHeaders,
  newIds,
  readBearer,
  readRequestBody,
  sendJson,
} from './util/http.js'
import { freebuffAuthHeaders } from './auth-store.js'
import {
  ensureFreebuffSystemMessages,
  normalizeReasoningFields,
} from './free-mode.js'
import { logger } from './util/log.js'

/**
 * OpenAI-compatible surface under /v1 only.
 * Freebuff upstream calls are internal (/api/v1/...).
 *
 * @param {object} ctx
 * @param {import('./config.js').ProxyConfig} ctx.config
 * @param {import('./app-context.js').AccountRuntimes} ctx.runtimes
 */
export function createProxyHandler(ctx) {
  const { config, runtimes, userStore } = ctx
  if (!runtimes) {
    throw new Error('createProxyHandler requires ctx.runtimes (AccountRuntimes)')
  }

  /**
   * Compute sticky context for a chat request (会话级负载均衡):
   *  - 同一会话ID（conversation_id / thread_id / 常见会话头）固定同一账号
   *    （热 session 复用、避免 superseded）；不用恒定的 client_id / user 作为会话 key；
   *  - 不同会话按「轮询 + 最少会话数」摊到不同账号，避免所有请求压在一个账号上被风控；
   *  - `x-sticky-account` 头显式指定账号，优先级最高；
   *  - Web 用户 pin 模式固定到 pinnedEmail；
   *  - none 模式 / 无会话ID：纯池子选号（轮询 + 配额感知）。
   */
  function resolveSticky(req, body, model) {
    const token = readBearer(req) || ''
    const key = token || (req.headers['x-sticky-account'] ? `hdr:${req.headers['x-sticky-account']}` : '')
    const headerPin =
      typeof req.headers['x-sticky-account'] === 'string'
        ? req.headers['x-sticky-account'].trim()
        : null
    const username = userStore ? userByKey.get(token) : null
    const user = username ? userStore.getByUsername(username) : null
    const convKey = extractConversationKey(body, req.headers)

    let preferredEmail = null
    /** @type {((email: string) => void) | null} */
    let onSuccess = null

    if (headerPin) {
      // 显式指定：只作用于本次请求，不写入会话粘性。
      preferredEmail = headerPin
    } else if (user) {
      if (user.stickyMode === 'pin' && user.pinnedEmail) {
        preferredEmail = user.pinnedEmail
      } else if (user.stickyMode !== 'none') {
        // auto（默认）：会话级粘性 + 哈希摊分
        preferredEmail = runtimes.conversationPreferredEmail(convKey, model)
        onSuccess = (email) => {
          if (convKey) runtimes.recordConversation(convKey, email)
          userStore.recordStickySuccess(user.username, email)
        }
      }
    } else if (key) {
      // 超级 Key / 匿名：会话级粘性 + 哈希摊分
      preferredEmail = runtimes.conversationPreferredEmail(convKey, model)
      onSuccess = (email) => {
        if (convKey) runtimes.recordConversation(convKey, email)
      }
    }

    return {
      key: key || 'anon',
      convKey,
      preferredEmail,
      onSuccess,
    }
  }
  /** @type {Map<string, string>} api-key → username (resolved at auth time) */
  const userByKey = new Map()

  function authorize(req, res) {
    const keys = config.server.apiKeys || []
    if (keys.length === 0 && !userStore) return true
    const token = readBearer(req)
    if (keys.length > 0 && token && apiKeyMatches(token, keys)) {
      userByKey.set(token, null) // super key, not a web user
      return true
    }
    if (userStore) {
      const user = token ? userStore.getByApiKey(token) : null
      if (user) {
        userByKey.set(token, user.username)
        return true
      }
    }
    sendJson(res, 401, {
      error: {
        message: 'Invalid proxy API key',
        type: 'auth_error',
        code: 'invalid_api_key',
      },
    })
    return false
  }

  async function handle(req, res) {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    )
    const path = url.pathname
    const method = (req.method || 'GET').toUpperCase()

    if (method === 'GET' && (path === '/healthz' || path === '/health')) {
      sendJson(res, 200, { status: 'ok' })
      return
    }

    if (!authorize(req, res)) return

    if (method === 'GET' && path === '/v1/models') {
      await handleModels(res)
      return
    }

    if (method === 'GET' && path === '/v1/freebuff/status') {
      await handleStatus(res)
      return
    }

    if (method === 'GET' && path === '/v1/freebuff/accounts') {
      sendJson(res, 200, { object: 'list', data: runtimes.list() })
      return
    }

    if (method === 'POST' && path === '/v1/freebuff/session/end') {
      // End sessions on all cached runtimes (best-effort)
      const accounts = []
      for (const row of runtimes.list()) {
        try {
          const rt = runtimes.get(row.email)
          await rt.sessions.release()
          accounts.push({ email: row.email, ok: true })
        } catch (err) {
          accounts.push({
            email: row.email,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      sendJson(res, 200, { ok: true, accounts })
      return
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      await handleChatCompletions(req, res)
      return
    }

    // Auth-injected passthrough for other OpenAI-shaped /v1 routes only.
    // Chat completions are NOT handled here.
    if (path.startsWith('/v1/')) {
      await handleGenericPassthrough(req, res, url)
      return
    }

    sendJson(res, 404, {
      error: {
        message: `No route for ${method} ${path}. Public API is under /v1.`,
        type: 'invalid_request_error',
        code: 'not_found',
      },
    })
  }

  async function handleModels(res) {
    let accessTier = null
    /** @type {string[]} */
    let extraIds = []
    try {
      const rt = runtimes.getAny()
      const session = await rt.upstream.freebuffSession('GET')
      if (session && typeof session === 'object') {
        if (session.accessTier === 'full' || session.accessTier === 'limited') {
          accessTier = session.accessTier
        }
        extraIds = modelIdsFromSession(session)
      }
    } catch (err) {
      logger.warn('models: session probe failed; returning static catalog', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    sendJson(
      res,
      200,
      buildModelsListResponse({
        accessTier,
        extraIds,
        includeAllCatalog: true,
      }),
    )
  }

  async function handleStatus(res) {
    const accounts = runtimes.list()
    let me = null
    let session = null
    let account = null
    if (accounts.length) {
      const rt = runtimes.getAny()
      account = rt.email
      try {
        me = await rt.upstream.me(['id', 'email'])
      } catch (err) {
        me = { error: err instanceof Error ? err.message : String(err) }
      }
      session = rt.sessions.getSnapshot()
    }
    sendJson(res, 200, {
      upstream: {
        apiBase: config.upstream.apiBase,
        loginBase: config.upstream.loginBase,
      },
      account,
      accounts,
      user: me,
      session,
    })
  }

  async function handleChatCompletions(req, res) {
    const releaseSlot = await acquireRequestSlot(config.limits.maxConcurrentRequests)
    try {
      await handleChatCompletionsInner(req, res)
    } finally {
      releaseSlot()
    }
  }

  async function handleChatCompletionsInner(req, res) {
    let rawBuf
    try {
      rawBuf = await readRequestBody(req)
    } catch (err) {
      if (err && err.statusCode === 413) {
        sendJson(res, 413, {
          error: {
            message: 'Request body too large',
            type: 'invalid_request_error',
            code: 'body_too_large',
          },
        })
        return
      }
      throw err
    }
    let body
    try {
      body = JSON.parse(rawBuf.toString('utf8') || '{}')
    } catch {
      sendJson(res, 400, {
        error: {
          message: 'Invalid JSON body',
          type: 'invalid_request_error',
          code: 'invalid_json',
        },
      })
      return
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, {
        error: {
          message: 'Body must be a JSON object',
          type: 'invalid_request_error',
        },
      })
      return
    }

    const upstreamModel = requireModelId(body.model)
    if (!upstreamModel) {
      sendJson(res, 400, {
        error: {
          message:
            'model is required. This proxy does not select a default model; pass the Freebuff model id chosen by your Agent.',
          type: 'invalid_request_error',
          code: 'model_required',
        },
      })
      return
    }

    const stream = Boolean(body.stream)
    let attempt = 0
    const maxRetry = config.limits.maxAutoRetryOnSessionError ?? 1
    /** @type {string | null} */
    let lastEmail = null
    /** @type {string | null} */
    let pendingGateCode = null
    /** @type {number | null} */
    let pendingRetryAfterMs = null

    // 会话级粘性：同一会话固定同一账号（热 session 复用），
    // 不同会话按轮询 + 最少会话数摊开（不用哈希，账号少时哈希易碰撞到同一账号）。
    const sticky = resolveSticky(req, body, upstreamModel)

    while (attempt <= maxRetry) {
      attempt++
      try {
        // Single reacquire path: first attempt acquires; retries use gate from previous failure.
        const rt =
          attempt === 1
            ? await runtimes.acquireForModel(upstreamModel, {
                preferredEmail: sticky.preferredEmail,
                convKey: sticky.convKey,
              })
            : await runtimes.reacquireAfterGate(upstreamModel, {
                preferredEmail: lastEmail,
                gateCode: pendingGateCode,
                retryAfterMs: pendingRetryAfterMs,
              })
        // 首次成功记录会话粘性；gate/限流重试后账号可能已切换，同样立即更新，
        // 避免同一会话下次又先去试旧账号。
        sticky.onSuccess?.(rt.email)
        sticky.preferredEmail = rt.email
        pendingGateCode = null
        pendingRetryAfterMs = null
        lastEmail = rt.email

        // 可观测性：响应头标明本次实际使用的账号与会话 key。
        res.setHeader('x-freebuff-proxy-account', rt.email)
        if (sticky.convKey) {
          res.setHeader('x-freebuff-proxy-conv-key', String(sticky.convKey))
        }

        const snap = rt.sessions.getSnapshot()
        if (!snap.live || !snap.instanceId) {
          throw new UpstreamError(
            'No live freebuff session after admit.',
            { status: 503, code: 'no_session' },
          )
        }

        const agentId = agentIdForModel(upstreamModel)
        const runId = await rt.upstream.startAgentRun({ agentId })
        logger.info('started agent run', {
          runId,
          agentId,
          model: upstreamModel,
          account: rt.email,
        })

        const forwardBody = buildForwardBody(
          body,
          upstreamModel,
          snap.instanceId,
          runId,
        )
        const result = await forwardCompletions({
          req,
          res,
          forwardBody,
          stream,
          upstream: rt.upstream,
        })

        // Best-effort close the run registry row
        void rt.upstream.finishAgentRun({
          runId,
          status: result.ok ? 'completed' : 'failed',
          errorMessage: result.ok
            ? undefined
            : result.gateCode || 'completions_failed',
        })

        if (result.ok) return

        if (result.recoverable && attempt <= maxRetry) {
          logger.warn('session error; will re-acquire once', {
            code: result.gateCode,
            attempt,
            model: upstreamModel,
            account: lastEmail,
            retryAfterMs: result.retryAfterMs ?? null,
          })
          pendingGateCode = result.gateCode
          pendingRetryAfterMs = result.retryAfterMs ?? null
          continue
        }

        if (!result.wrote) {
          await writeUpstreamError(
            res,
            result.status,
            result.body,
            result.headers,
          )
        }
        return
      } catch (err) {
        if (err instanceof UpstreamError) {
          if (
            isSessionRecoverableGate(err.code) &&
            attempt <= maxRetry
          ) {
            logger.warn('recoverable session error; will re-acquire once', {
              code: err.code,
              attempt,
              account: lastEmail,
            })
            pendingGateCode = err.code
            continue
          }
          mapAndSendError(res, err)
          return
        }
        logger.error('chat completions failed', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: 'proxy_error',
            },
          })
        } else {
          res.end()
        }
        return
      }
    }
  }

  function buildForwardBody(clientBody, upstreamModel, instanceId, runId) {
    const { clientId } = newIds()
    let body = { ...clientBody, model: upstreamModel }
    // One reasoning field only — avoids Freebuff default + client dual fields.
    body = normalizeReasoningFields(body)
    // Free mode requires a system message opening with the Freebuff CLI marker
    // ("You are Buffy, the strategic coding assistant."). Without it the
    // upstream returns free_mode_cli_required.
    body.messages = ensureFreebuffSystemMessages(body.messages)

    const existingMeta =
      body.codebuff_metadata && typeof body.codebuff_metadata === 'object'
        ? { ...body.codebuff_metadata }
        : {}
    // run_id MUST be server-issued via POST /api/v1/agent-runs (START).
    body.codebuff_metadata = {
      ...existingMeta,
      run_id: runId,
      client_id: existingMeta.client_id || clientId,
      cost_mode: 'free',
      freebuff_instance_id: instanceId,
    }
    if (body.provider && typeof body.provider === 'object') {
      body.provider = { ...body.provider }
    }
    return body
  }

  async function forwardCompletions({
    req,
    res,
    forwardBody,
    stream,
    upstream,
  }) {
    const headers = {
      ...filterRequestHeaders(req.headers),
      'content-type': 'application/json',
      accept:
        stream
          ? 'text/event-stream'
          : req.headers.accept || 'application/json',
      // Match Codebuff/Freebuff SDK UA used on the official free path.
      'user-agent': 'ai-sdk/openai-compatible/freebuff-proxy/codebuff',
      ...freebuffAuthHeaders(upstream.token),
    }

    const upstreamRes = await upstream.raw('/api/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(forwardBody),
      signal: reqToAbortSignal(req),
      timeoutMs: config.limits.upstreamTimeoutSec * 1000,
    })

    const status = upstreamRes.status
    const respHeaders = filterResponseHeaders(upstreamRes.headers)

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text()
      let parsed = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      const retryAfterMs = parseRetryAfterMsHeader(respHeaders['retry-after'])
      // 账号级限流（free_mode_rate_limited / rate_limited / spend_limited /
      // ip_capped）：冷却当前账号并换号重试一次，而不是把 429 直接甩给用户。
      const rateCode = extractRateLimitError(parsed, status)
      if (rateCode) {
        return {
          ok: false,
          wrote: false,
          recoverable: true,
          gateCode: rateCode,
          retryAfterMs,
          status,
          body: parsed || { error: { message: text, type: 'upstream_error' } },
          headers: respHeaders,
        }
      }
      const gateCode = extractGateError(parsed, status)
      if (gateCode && isSessionRecoverableGate(gateCode)) {
        return {
          ok: false,
          wrote: false,
          recoverable: true,
          gateCode,
          retryAfterMs,
          status,
          body: parsed || { error: { message: text, type: 'upstream_error' } },
          headers: respHeaders,
        }
      }
      return {
        ok: false,
        wrote: false,
        recoverable: false,
        gateCode,
        status,
        body: parsed || text,
        headers: respHeaders,
      }
    }

    res.writeHead(status, respHeaders)
    if (!upstreamRes.body) {
      res.end()
      return { ok: true, wrote: true }
    }
    await pipeWebStreamToNode(upstreamRes.body, res, req)
    return { ok: true, wrote: true }
  }

  /**
   * Non-chat /v1/* → upstream /api/v1/* with Freebuff auth only.
   * No session admit (chat has its own handler).
   */
  async function handleGenericPassthrough(req, res, url) {
    if (
      url.pathname === '/v1/chat/completions' ||
      url.pathname.startsWith('/v1/chat/completions/')
    ) {
      sendJson(res, 404, {
        error: {
          message: 'Use POST /v1/chat/completions',
          type: 'invalid_request_error',
          code: 'not_found',
        },
      })
      return
    }

    const rt = runtimes.getAny()
    const upstreamPath = `/api/v1${url.pathname.slice('/v1'.length)}${url.search}`
    const rawBuf = methodHasBody(req.method)
      ? await readRequestBody(req)
      : null

    const headers = {
      ...filterRequestHeaders(req.headers),
      ...freebuffAuthHeaders(rt.upstream.token),
    }
    if (rawBuf?.length && !headers['content-type']) {
      headers['content-type'] = 'application/json'
    }

    let upstreamRes
    try {
      upstreamRes = await rt.upstream.raw(upstreamPath, {
        method: req.method || 'GET',
        headers,
        body: rawBuf?.length ? rawBuf : undefined,
        signal: reqToAbortSignal(req),
      })
    } catch (err) {
      mapAndSendError(res, err)
      return
    }

    const respHeaders = filterResponseHeaders(upstreamRes.headers)
    res.writeHead(upstreamRes.status, respHeaders)
    if (!upstreamRes.body) {
      res.end()
      return
    }
    await pipeWebStreamToNode(upstreamRes.body, res, req)
  }

  return { handle }
}

/**
 * 从 chat 请求提取会话标识（会话级负载均衡的 key）。
 * 只用"会话级"标识：codebuff_metadata.conversation_id / thread_id、
 * 显式会话字段（conversation_id / threadId / session_id）、常见会话头。
 * 不用 codebuff_metadata.client_id（安装 ID 恒定）和 body.user
 * （sub2api 等转换层常传固定 user）——它们对同一客户端恒定，会让所有会话
 * 共享同一个 key、永远分到同一个账号。
 * 拿不到返回 null（该请求走池子轮询选号，不做会话粘性，按账号轮流分配）。
 *
 * @param {any} body
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {string | null}
 */
export function extractConversationKey(body, headers) {
  const meta =
    body?.codebuff_metadata && typeof body.codebuff_metadata === 'object'
      ? body.codebuff_metadata
      : null
  const h = headers || {}
  const candidates = [
    meta?.conversation_id,
    meta?.thread_id,
    body?.conversation_id,
    body?.conversationId,
    body?.thread_id,
    body?.threadId,
    body?.session_id,
    h['x-conversation-id'],
    h['x-conversation_id'],
    h['x-thread-id'],
    h['x-session-id'],
  ]
  for (const v of candidates) {
    if (typeof v === 'string') {
      const t = v.trim()
      if (t) return t
    }
  }
  return null
}

function methodHasBody(method) {
  const m = (method || 'GET').toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}

/** Parse Retry-After header (seconds or HTTP-date) into ms, or null. */
function parseRetryAfterMsHeader(value) {
  if (!value) return null
  const secs = Number(value)
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000)
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.max(0, ms - Date.now()) : null
}

/** Constant-time-ish compare against configured proxy keys. */
function apiKeyMatches(token, keys) {
  const a = Buffer.from(String(token))
  for (const key of keys) {
    const b = Buffer.from(String(key))
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

/** Simple in-process semaphore for chat completions. */
let _inFlight = 0
/** @type {Array<() => void>} */
const _waitQueue = []

/**
 * @param {number} max
 * @returns {Promise<() => void>}
 */
function acquireRequestSlot(max) {
  const limit = Number.isFinite(max) && max > 0 ? max : 32
  if (_inFlight < limit) {
    _inFlight++
    return Promise.resolve(releaseRequestSlot)
  }
  return new Promise((resolve) => {
    _waitQueue.push(() => {
      _inFlight++
      resolve(releaseRequestSlot)
    })
  })
}

function releaseRequestSlot() {
  _inFlight = Math.max(0, _inFlight - 1)
  const next = _waitQueue.shift()
  if (next) next()
}

function reqToAbortSignal(req) {
  const controller = new AbortController()
  req.on('close', () => {
    if (!req.complete) controller.abort()
  })
  return controller.signal
}

async function pipeWebStreamToNode(webBody, nodeRes, nodeReq) {
  const reader = webBody.getReader()
  nodeReq.on('close', () => {
    reader.cancel().catch(() => {})
  })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        const ok = nodeRes.write(Buffer.from(value))
        if (!ok) await onceDrain(nodeRes)
      }
    }
    nodeRes.end()
  } catch (err) {
    try {
      nodeRes.destroy(err instanceof Error ? err : undefined)
    } catch {
      // ignore
    }
  }
}

function onceDrain(res) {
  return new Promise((resolve) => res.once('drain', resolve))
}

async function writeUpstreamError(res, status, body, headers = {}) {
  if (res.headersSent) {
    res.end()
    return
  }
  if (body && typeof body === 'object') {
    sendJson(res, status || 502, body, headers)
    return
  }
  sendJson(res, status || 502, {
    error: {
      message: typeof body === 'string' ? body : 'Upstream error',
      type: 'upstream_error',
    },
  })
}

function mapAndSendError(res, err) {
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      // ignore
    }
    return
  }
  if (err instanceof UpstreamError) {
    const status = err.status || 502
    const body =
      err.body && typeof err.body === 'object'
        ? err.body.error
          ? err.body
          : {
              error: {
                message: err.message,
                type: 'freebuff_error',
                code: err.code,
                details: err.body,
              },
            }
        : {
            error: {
              message: err.message,
              type: 'freebuff_error',
              code: err.code,
            },
          }
    const headers = {}
    if (err.retryAfterMs != null) {
      headers['retry-after'] = String(Math.ceil(err.retryAfterMs / 1000))
    }
    sendJson(res, status, body, headers)
    return
  }
  sendJson(res, 500, {
    error: {
      message: err instanceof Error ? err.message : String(err),
      type: 'proxy_error',
    },
  })
}
