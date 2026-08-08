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

  function authorize(req, res) {
    const keys = config.server.apiKeys || []
    if (keys.length === 0 && !userStore) return true
    const token = readBearer(req)
    if (keys.length > 0 && token && apiKeyMatches(token, keys)) {
      return true
    }
    if (userStore) {
      const user = token ? userStore.getByApiKey(token) : null
      if (user) return true
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
          const rt = runtimes.get(row.key)
          await rt.sessions.release()
          accounts.push({ key: row.key, email: row.email, ok: true })
        } catch (err) {
          accounts.push({
            key: row.key,
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
    // 换号重试预算：账号数 +1（封顶 5 次）——多出的一次用于同账号 gate 重试
    // （session 失效等先同号 re-admit 一次，再失败才升级换号），保证一波限流/5xx
    // 时能换到可用账号，试完所有账号才把错误返回给用户。
    const maxAttempts = Math.max(
      maxRetry + 1,
      Math.min((runtimes.allKeys().length || 1) + 1, 5),
    )
    /** @type {string | null} */
    let lastKey = null
    /** @type {string | null} */
    let pendingGateCode = null
    /** @type {number | null} */
    let pendingRetryAfterMs = null
    /** @type {boolean} */
    let pendingSwitchAccount = false
    /** @type {boolean} */
    let pendingNoCooldown = false
    /** 同一账号连续 gate 失败计数：gate 已同号 re-admit 重试过一次仍失败 → 升级为换号。 */
    let sameAccountGateRetries = 0

    // 强制轮询：每个请求按账号轮流分配，不做会话粘性/分组。
    // 上游无状态（客户端每次请求携带全量历史），所以无需为"同一会话"固定账号。
    // 故障转移：除了 4xx 客户端错误，任何上游失败（session/run/chat/网络超时）都
    // 冷却当前账号并继续轮询下一个，只有试完所有账号才把错误返回给用户。
    while (attempt < maxAttempts) {
      attempt++
      try {
        // Single reacquire path: first attempt acquires; retries use gate from previous failure.
        const rt =
          attempt === 1
            ? await runtimes.acquireForModel(upstreamModel)
            : await runtimes.reacquireAfterGate(upstreamModel, {
                preferredKey: lastKey,
                gateCode: pendingGateCode,
                retryAfterMs: pendingRetryAfterMs,
                switchAccount: pendingSwitchAccount,
                noCooldown: pendingNoCooldown,
              })
        pendingGateCode = null
        pendingRetryAfterMs = null
        pendingSwitchAccount = false
        pendingNoCooldown = false
        if (lastKey && rt.key !== lastKey) {
          // 已经换到不同账号 → 重置同账号 gate 计数
          sameAccountGateRetries = 0
        }
        lastKey = rt.key

        // 可观测性：响应头标明本次实际使用的账号。
        res.setHeader('x-freebuff-proxy-account', rt.email)
        res.setHeader('x-freebuff-proxy-account-id', rt.key)

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
          key: rt.key,
          email: rt.email,
        })

        const forwardBody = buildForwardBody(
          body,
          upstreamModel,
          snap.instanceId,
          runId,
        )
        // 在途计数：轮询 GET 跳过该账号，避免干扰正在进行的 chat 会话
        rt.sessions.beginRequest()
        let result
        try {
          result = await forwardCompletions({
            req,
            res,
            forwardBody,
            stream,
            upstream: rt.upstream,
          })
        } finally {
          rt.sessions.endRequest()
        }

        // Best-effort close the run registry row
        void rt.upstream.finishAgentRun({
          runId,
          status: result.ok ? 'completed' : 'failed',
          errorMessage: result.ok
            ? undefined
            : result.gateCode || 'completions_failed',
        })

        if (result.ok) return

        if (result.recoverable && attempt < maxAttempts) {
          if (result.switchAccount) {
            sameAccountGateRetries = 0
          } else {
            // 同账号 gate 重试计数：连续两次 gate 失败 → 升级为换号
            sameAccountGateRetries += 1
          }
          logger.warn('session error; will re-acquire', {
            code: result.gateCode,
            attempt,
            budget: maxAttempts,
            model: upstreamModel,
            key: lastKey,
            switchAccount:
              result.switchAccount === true || sameAccountGateRetries >= 2,
            noCooldown: result.noCooldown === true,
            retryAfterMs: result.retryAfterMs ?? null,
          })
          pendingGateCode = result.gateCode
          pendingRetryAfterMs = result.retryAfterMs ?? null
          pendingSwitchAccount =
            result.switchAccount === true || sameAccountGateRetries >= 2
          pendingNoCooldown = result.noCooldown === true
          continue
        }

        // 最后一次尝试也失败：把当前账号标记冷却（gate 瞬时问题 noCooldown 除外），
        // 避免下一个请求立刻又撞上同一个故障账号。
        if (result.switchAccount && !result.noCooldown) {
          runtimes.markCooldown(
            lastKey,
            new UpstreamError(result.gateCode || 'upstream_error', {
              code: result.gateCode || 'upstream_error',
              status: result.status,
              retryAfterMs: result.retryAfterMs ?? undefined,
            }),
            upstreamModel,
          )
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
          if (isSessionRecoverableGate(err.code) && attempt < maxAttempts) {
            logger.warn('recoverable session error; will re-acquire', {
              code: err.code,
              attempt,
              key: lastKey,
            })
            pendingGateCode = err.code
            pendingSwitchAccount = false
            pendingNoCooldown = false
            continue
          }
          // 其他上游错误（startAgentRun 失败 / no_session / admit 后异常等）：
          // 只要还有重试预算，就冷却当前账号换下一个，而不是直接把错误甩给用户。
          const isTerminal =
            err.code === 'no_available_account' ||
            err.code === 'model_required' ||
            err.code === 'upstream_auth_missing'
          if (
            !isTerminal &&
            attempt < maxAttempts &&
            shouldSwitchAccountOnError(err.status, err.code)
          ) {
            logger.warn('upstream error; switching account', {
              code: err.code,
              status: err.status,
              attempt,
              key: lastKey,
              model: upstreamModel,
            })
            pendingGateCode = err.code || `http_${err.status || 502}`
            pendingRetryAfterMs = err.retryAfterMs ?? null
            pendingSwitchAccount = true
            pendingNoCooldown = false
            continue
          }
          mapAndSendError(res, err)
          return
        }
        // 非 UpstreamError：网络错误 / 上游超时（socket 断开、代理不可达等）。
        // 只要还有重试预算就冷却当前账号换下一个；客户端是否已断开无法可靠区分
        // （req.destroyed 在请求体读完后就为 true），多试一轮最多浪费一次上游调用。
        if (attempt < maxAttempts) {
          logger.warn('upstream network error; switching account', {
            error: err instanceof Error ? err.message : String(err),
            attempt,
            key: lastKey,
            model: upstreamModel,
          })
          pendingGateCode = 'upstream_network_error'
          pendingRetryAfterMs = null
          pendingSwitchAccount = true
          pendingNoCooldown = false
          continue
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
      const errCode =
        (parsed &&
        typeof parsed === 'object' &&
        (parsed.error?.code || parsed.error || parsed.code || parsed.status)) ||
        null
      const gateCode = extractGateError(parsed, status)
      const parsedBody = parsed || {
        error: { message: text, type: 'upstream_error' },
      }

      // free_mode_capacity_deferred：免费模式瞬时容量排队（上游原话
      // "your request will be retried automatically"）。不是账号级故障——
      // 实测同一账号同一 session 立即重试即恢复（不限量模型 flash 尤其常见）。
      // 换下一个账号继续轮询，但绝不冷却当前账号，避免把可用账号白白钉死。
      if (
        errCode === 'free_mode_capacity_deferred' ||
        gateCode === 'free_mode_capacity_deferred'
      ) {
        return {
          ok: false,
          wrote: false,
          recoverable: true,
          switchAccount: true,
          noCooldown: true,
          gateCode: 'free_mode_capacity_deferred',
          retryAfterMs,
          status,
          body: parsedBody,
          headers: respHeaders,
        }
      }
      // 可恢复 gate（session_expired/superseded/waiting_room 等）：
      // 同账号 re-admit 一次即可恢复，不属于账号级故障，不冷却不换号。
      if (gateCode && isSessionRecoverableGate(gateCode)) {
        return {
          ok: false,
          wrote: false,
          recoverable: true,
          switchAccount: false,
          gateCode,
          retryAfterMs,
          status,
          body: parsedBody,
          headers: respHeaders,
        }
      }
      // 账号侧故障（429 限流 / 5xx / 403 账号级封禁）：冷却当前账号并换号重试，
      // 而不是把错误直接甩给用户。4xx 客户端错误（400/401/404/422 等）不换号。
      const switchAccount = shouldSwitchAccountOnError(status, errCode)
      if (switchAccount) {
        return {
          ok: false,
          wrote: false,
          recoverable: true,
          switchAccount: true,
          gateCode: typeof errCode === 'string' ? errCode : `http_${status}`,
          retryAfterMs,
          status,
          body: parsedBody,
          headers: respHeaders,
        }
      }
      return {
        ok: false,
        wrote: false,
        recoverable: false,
        switchAccount: false,
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

function methodHasBody(method) {
  const m = (method || 'GET').toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}

/**
 * 上游 chat/completions 报错时是否应冷却当前账号并换号重试：
 * 429（限流/配额）、5xx（服务端故障）、403 账号级封禁（banned/country_blocked/ip_capped）
 * 以及 free_mode_rate_limited 等账号级限流 code。4xx 客户端错误不换号。
 * @param {number} status
 * @param {unknown} code
 * @returns {boolean}
 */
function shouldSwitchAccountOnError(status, code) {
  if (status >= 500) return true
  if (status === 429) return true
  if (
    status === 403 &&
    ['banned', 'country_blocked', 'ip_capped'].includes(String(code))
  ) {
    return true
  }
  return extractRateLimitError({ error: code }) !== null
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
