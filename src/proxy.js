import {
  requireModelId,
  buildModelsListResponse,
  modelIdsFromSession,
  agentIdForModel,
  agentFallbackForModel,
} from './model.js'
import {
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
  safeText,
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
  coerceUser,
  saveAccountUser,
  deleteAccountUser,
} from './auth-store.js'
import {
  ensureFreebuffSystemMessages,
  ensureFreebuffToolSignature,
  normalizeReasoningFields,
  normalizeOutputBudget,
} from './free-mode.js'
import { applyMinimalRouting, applyStandardRouting } from './routing.js'
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
  const { config, runtimes, userStore, settingsStore } = ctx
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

    if (method === 'POST' && path === '/v1/freebuff/accounts/import') {
      await handleAccountsImport(req, res)
      return
    }

    if (method === 'DELETE' && path === '/v1/freebuff/accounts') {
      await handleAccountsDelete(req, res)
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

  /**
   * POST /v1/freebuff/accounts/import — 开放 API 导入账号（Bearer API Key 鉴权）。
   * body 支持三种形态：
   *   {"email":"..","authToken":"..","id?":"..","name?":".."}      单个账号
   *   {"json":"<stringified 账号>"}                                 兼容 Web 端导入格式
   *   {"accounts":[{...},{...}]}                                    批量导入
   */
  async function handleAccountsImport(req, res) {
    let rawBuf
    try {
      rawBuf = await readRequestBody(req)
    } catch (err) {
      sendJson(res, 400, {
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: 'invalid_request_error',
          code: 'bad_request_body',
        },
      })
      return
    }
    let body
    try {
      body = JSON.parse(rawBuf.toString('utf8'))
    } catch {
      sendJson(res, 400, {
        error: {
          message: '请求体不是合法 JSON',
          type: 'invalid_request_error',
          code: 'invalid_json',
        },
      })
      return
    }

    /** @type {unknown[]} */
    let rawList = []
    if (Array.isArray(body)) {
      rawList = body
    } else if (Array.isArray(body.accounts)) {
      rawList = body.accounts
    } else if (typeof body.json === 'string') {
      try {
        const parsed = JSON.parse(body.json)
        rawList = Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        sendJson(res, 400, {
          error: {
            message: 'json 字段不是合法 JSON',
            type: 'invalid_request_error',
            code: 'invalid_json',
          },
        })
        return
      }
    } else if (body && typeof body === 'object') {
      rawList = [body]
    } else {
      sendJson(res, 400, {
        error: {
          message: '无法识别的导入结构：需为账号对象、账号数组、{accounts:[...]} 或 {json:"..."}',
          type: 'invalid_request_error',
          code: 'invalid_import_format',
        },
      })
      return
    }

    if (rawList.length === 0) {
      sendJson(res, 400, {
        error: {
          message: '导入列表为空',
          type: 'invalid_request_error',
          code: 'empty_import',
        },
      })
      return
    }
    if (rawList.length > 200) {
      sendJson(res, 400, {
        error: {
          message: '单次最多导入 200 个账号',
          type: 'invalid_request_error',
          code: 'too_many_accounts',
        },
      })
      return
    }

    const imported = []
    const failures = []
    for (const raw of rawList) {
      const u = coerceUser(raw)
      if (!u) {
        failures.push({
          email: raw && typeof raw === 'object' ? raw.email || null : null,
          error: '缺少 email / authToken（或格式不对）',
        })
        continue
      }
      try {
        const saved = saveAccountUser(runtimes.dir, u)
        await runtimes.invalidate(saved.key).catch(() => {})
        // 只读探测预热：导入后立即刷新 session/额度缓存（不占额度）
        try {
          const rt = runtimes.get(saved.key)
          await rt.sessions.refresh()
        } catch {
          // ignore — 探测失败不影响导入
        }
        imported.push({
          key: saved.key,
          email: saved.user.email,
          id: saved.user.id || null,
        })
      } catch (err) {
        failures.push({
          email: u.email,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    sendJson(res, 200, {
      ok: true,
      object: 'import',
      imported,
      failures,
      total: rawList.length,
    })
  }

  /**
   * DELETE /v1/freebuff/accounts — 开放 API 删除账号。
   * body（可选）: {"email":".."} / {"key":".."} / {"id":".."}；空 body 或全部则清空所有账号。
   */
  async function handleAccountsDelete(req, res) {
    let body = null
    try {
      const rawBuf = await readRequestBody(req)
      if (rawBuf.length > 0) body = JSON.parse(rawBuf.toString('utf8'))
    } catch {
      body = null // 空 body / 非 JSON → 全部删除
    }
    const target = body && typeof body === 'object'
      ? body.email || body.key || body.id || null
      : null
    const dir = runtimes.dir
    if (target) {
      try {
        const deleted = deleteAccountUser(dir, String(target))
        await runtimes.invalidate(String(target)).catch(() => {})
        sendJson(res, 200, {
          ok: true,
          deleted: target,
          existed: !!deleted,
        })
      } catch (err) {
        sendJson(res, 500, {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: 'proxy_error',
            code: 'delete_failed',
          },
        })
      }
      return
    }
    // 空 body → 全部删除（先释放 session 再删凭据文件）
    const rows = runtimes.list()
    const removed = []
    for (const row of rows) {
      try {
        const rt = runtimes.get(row.key)
        await rt.sessions.release().catch(() => {})
      } catch {
        // ignore
      }
      deleteAccountUser(dir, row.key)
      await runtimes.invalidate(row.key).catch(() => {})
      removed.push(row.key)
    }
    sendJson(res, 200, { ok: true, object: 'delete', removed, total: removed.length })
  }

  async function handleStatus(res) {    const accounts = runtimes.list()
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
    /** 当前持锁账号 runtime（账号级串行化：一个账号同一时间只处理一个 chat）。 */
    let heldRt = null
    /** 当前持有的账号 chat 锁释放函数。 */
    let releaseChat = null

    /** 释放当前账号的串行化锁与在途标记（换号/请求结束时调用）。 */
    function dropChatHold() {
      if (releaseChat) {
        releaseChat()
        releaseChat = null
      }
      if (heldRt) {
        heldRt.sessions.endRequest()
        heldRt = null
      }
    }

    /**
     * 账号锁等待时长：
     * - 热 session（同模型可直接复用）：等一个完整 idle 超时周期。上游卡死也会在
     *   streamIdleTimeoutSec 后被掐断释放锁，所以热会话优先排队复用而不是新建 session。
     * - 冷账号/换模型：只等固定窗口，超时即换下一个账号。
     */
    function chatWaitMs(rt) {
      if (rt.sessions.isUsableForModel(upstreamModel)) {
        return ((config.limits.streamIdleTimeoutSec || 120) * 1000) + 15_000
      }
      return config.limits.accountChatWaitMs || 60_000
    }

    // Session-first scheduling: reuse a live same-model slot, serialized per
    // account (one account handles one chat at a time). The upstream is
    // stateless because clients send the full history.
    // 故障转移：除了 4xx 客户端错误，任何上游失败（session/run/chat/网络超时）都
    // 冷却当前账号并继续轮询下一个，只有试完所有账号才把错误返回给用户。
    try {
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
            // 已经换到不同账号 → 重置同账号 gate 计数，并释放上一账号的串行化锁
            sameAccountGateRetries = 0
            dropChatHold()
          }
          lastKey = rt.key

          // 账号级串行化：同一账号同一时间只处理一个 chat（热会话排队复用，
          // 超时兜底换号）。**任何一次获取都必须有界**：兜底阶段虽然预算已
          // 耗尽（不会再换号），但若持锁者因网络波动卡死（幽灵连接），无限
          // 等待会让本请求永久挂起、所有后续请求排队超时——必须像前面的
          // acquire 一样设上界，超时把 account_busy 返回给客户端（可重试），
          // 绝不无限等待。
          if (!heldRt) {
            try {
              releaseChat = await runtimes.acquireChat(rt.key, chatWaitMs(rt))
            } catch (lockErr) {
              if (lockErr?.code === 'account_busy' && attempt < maxAttempts) {
                logger.warn('account busy; trying next account', {
                  key: rt.key,
                  email: rt.email,
                  model: upstreamModel,
                  attempt,
                })
                pendingGateCode = 'account_busy'
                pendingSwitchAccount = true
                pendingNoCooldown = true
                continue
              }
              logger.warn('account busy; final bounded wait for chat slot', {
                key: rt.key,
                email: rt.email,
                model: upstreamModel,
                attempt,
                waitMs: chatWaitMs(rt),
              })
              releaseChat = await runtimes.acquireChat(rt.key, chatWaitMs(rt))
            }
            // 切换竞态：等待 chat 锁期间可能发生了代理/账号切换（本 runtime
            // 已被顶替，旧 session 正在被优雅释放）。此时不能继续用旧 runtime
            // ——它的 session 可能马上被 DELETE，硬用会让请求撞上已失效会话而
            // 卡死。释放锁、无冷却重新选号（新 runtime 走新出口、新 session）。
            if (!runtimes.isCurrentRuntime(rt)) {
              logger.warn(
                'runtime superseded while waiting for chat slot; re-selecting',
                {
                  key: rt.key,
                  email: rt.email,
                  model: upstreamModel,
                  attempt,
                },
              )
              releaseChat()
              releaseChat = null
              pendingGateCode = 'runtime_superseded'
              pendingSwitchAccount = true
              pendingNoCooldown = true
              continue
            }
            heldRt = rt
            // 在途标记：锁内唯一请求；轮询 GET 会跳过该账号，避免干扰活跃会话。
            heldRt.sessions.beginRequest()
          }

          let result
          let runId
          {
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

            // agent 选择：主 agent 被上游以 free_mode_invalid_agent_model 拒绝时
            // （上游按用途/推理任务可能只接受特定 agent，且部分 agent 带单次
            // output 限制会截断长思考链），回退 base3 孪生 agent 再试一次。
            const agentId = agentIdForModel(upstreamModel)
            try {
              runId = await rt.upstream.startAgentRun({ agentId })
            } catch (agentErr) {
              if (
                agentErr instanceof UpstreamError &&
                (agentErr.code === 'start_agent_run_failed' ||
                  agentErr.code === 'free_mode_invalid_agent_model') &&
                agentErr.status === 403
              ) {
                const fbAgentId = agentFallbackForModel(upstreamModel)
                if (fbAgentId !== agentId) {
                  logger.warn('primary agent rejected; falling back', {
                    agentId,
                    fbAgentId,
                    model: upstreamModel,
                    key: rt.key,
                  })
                  runId = await rt.upstream.startAgentRun({ agentId: fbAgentId })
                } else {
                  throw agentErr
                }
              } else {
                throw agentErr
              }
            }
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
            result = await forwardCompletions({
              req,
              res,
              forwardBody,
              stream,
              upstream: rt.upstream,
              // 会话剩余时间：用于把流 idle 超时收敛到会话过期附近，过期即掐
              sessionRemainingMs: snap.remainingMs,
            })
          }

          // Best-effort close the run registry row
          if (runId) {
            void rt.upstream.finishAgentRun({
              runId,
              status: result.ok ? 'completed' : 'failed',
              errorMessage: result.ok
                ? undefined
                : result.gateCode || 'completions_failed',
            })
          }

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
    } finally {
      // 请求结束（成功/失败/预算耗尽）：释放账号串行化锁，恢复该账号轮询
      dropChatHold()
    }
  }

  function buildForwardBody(clientBody, upstreamModel, instanceId, runId) {
    const { clientId } = newIds()
    let body = { ...clientBody, model: upstreamModel }
    // One reasoning field only — avoids Freebuff default + client dual fields.
    body = normalizeReasoningFields(body)
    // 输出预算治理：客户端偏小的 max_tokens/max_completion_tokens 会把思考链
    // （reasoning token 计入该预算）提前掐断（finish_reason=length）——参考
    // freebuff2api-wokers#8「DS4 思考链稍长即截断」。转发上游前抬到 floor。
    body = normalizeOutputBudget(body)
    // 极简路由（路由模式）：代理侧注入 persona + 首轮核心工具面 + 近距离引导。
    // 参考 dsh-routing-suite（dsh-router-standard）的请求协议——当客户端侧的
    // 路由注入经过翻译/反向代理链被改写或丢弃时，由代理兜底保证路由生效。
    // 改写后的第一条 system 消息以 free-mode 门禁标记开头，后续
    // ensureFreebuffSystemMessages 不会再重复加前缀。
    // 实现风格：standard（默认，flash 恒走 weak 内路由 + 深度引导静态并入
    // persona，多轮稳定；参考 v4-flash-godmode） / minimal（按任务分类三带）。
    if (settingsStore?.get().minimalRoutingEnabled === true) {
      const routingStyle = settingsStore?.get().minimalRoutingStyle ?? 'standard'
      body =
        routingStyle === 'minimal'
          ? applyMinimalRouting(body, upstreamModel, {
              modeOverride: settingsStore?.get().minimalRoutingMode ?? 'auto',
            })
          : applyStandardRouting(body, upstreamModel)
    }
    // Free mode requires a system message opening with the Freebuff CLI marker
    // ("You are Buffy, the strategic coding assistant."). Without it the
    // upstream returns free_mode_cli_required.
    body.messages = ensureFreebuffSystemMessages(body.messages)
    const freeToolSignatureEnabled =
      settingsStore?.get().freeToolSignatureEnabled !== false
    body.tools = ensureFreebuffToolSignature(
      body.tools,
      freeToolSignatureEnabled,
    )

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

  /**
   * 流式 idle 超时：默认取 limits.streamIdleTimeoutSec；若会话剩余时间已知，
   * 在其基础上加一个 lead 宽限并封顶，会话过期后上游若不再吐数据（幽灵卡死）
   * 会更快被掐断，避免"会话快过期时响应卡住"。带下限 30s，避免误伤慢首包。
   */
  function effectiveStreamIdleMs(sessionRemainingMs) {
    const base = (config.limits.streamIdleTimeoutSec || 0) * 1000
    if (!(base > 0) || !Number.isFinite(sessionRemainingMs)) return base
    const lead = 20_000
    return Math.min(
      base,
      Math.max(30_000, Math.max(0, sessionRemainingMs) + lead),
    )
  }

  /**
   * chat/completions 响应头等待上限（毫秒）：与 body idle 同量级并带 30s 下限，
   * 且不超过全局 upstreamTimeoutSec。上游 chat 是流式接口，正常秒级出响应头；
   * 网络波动（TCP 黑洞/代理挂起）时等 upstreamTimeoutSec（默认 600s）才 abort，
   * 账号 chat 锁会被占死 10 分钟、所有新请求超时——必须尽快释放。
   */
  function chatHeaderTimeoutMs() {
    const idleSec = config.limits.streamIdleTimeoutSec
    const idleMs = (Number.isFinite(idleSec) && idleSec > 0 ? idleSec : 120) * 1000
    const bound = Math.max(30_000, idleMs)
    const cap = (config.limits.upstreamTimeoutSec || 600) * 1000
    return Math.min(cap, bound)
  }

  async function forwardCompletions({
    req,
    res,
    forwardBody,
    stream,
    upstream,
    sessionRemainingMs,
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

    const abortCtrl = reqToAbortSignal(req)
    let upstreamRes
    try {
      upstreamRes = await upstream.raw('/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(forwardBody),
        signal: abortCtrl.signal,
        // 响应头等待上限收紧到 body idle 同量级（默认 120s，带 30s 下限）：
        // chat 是流式接口，正常秒级出响应头；网络波动（TCP 黑洞）时若等
        // upstreamTimeoutSec（默认 600s）才 abort，账号 chat 锁会被占死
        // 10 分钟，期间所有新请求超时——与幽灵连接同源，必须尽快释放。
        timeoutMs: chatHeaderTimeoutMs(),
      })
    } finally {
      // 响应头已到/上游已失败：后续由 pipe 的 socket 监听接管，移除本监听器
      abortCtrl.cleanup()
    }

    const status = upstreamRes.status
    const respHeaders = filterResponseHeaders(upstreamRes.headers)

    if (!upstreamRes.ok) {
      const text = await safeText(upstreamRes)
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
      // 实测同一账号同一 session 立即重试即恢复（flash 尤其常见）。
      // 优先复用当前热 session 重试，但绝不冷却账号，避免为瞬时容量
      // 无谓开启另一个计费 session；若账号另有故障，外层仍会正常切号。
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
    try {
      await pipeWebStreamToNode(upstreamRes.body, res, req, {
        idleTimeoutMs: effectiveStreamIdleMs(sessionRemainingMs),
      })
      return { ok: true, wrote: true }
    } catch (err) {
      return handleStreamPipeFailure(err, req, res)
    }
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
      const abortCtrl = reqToAbortSignal(req)
      try {
        upstreamRes = await rt.upstream.raw(upstreamPath, {
          method: req.method || 'GET',
          headers,
          body: rawBuf?.length ? rawBuf : undefined,
          signal: abortCtrl.signal,
        })
      } finally {
        abortCtrl.cleanup()
      }
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
    try {
      await pipeWebStreamToNode(upstreamRes.body, res, req, {
        idleTimeoutMs: (config.limits.streamIdleTimeoutSec || 0) * 1000,
      })
    } catch (err) {
      // 上游卡死/客户端断开：透传没有换号语义，直接掐断连接（客户端自行重试）
      if (!res.destroyed) {
        try {
          res.destroy()
        } catch {
          // ignore
        }
      }
      logger.warn('passthrough stream failed', {
        path: upstreamPath,
        error: err instanceof Error ? err.message : String(err),
        stalled: Boolean(err?.stalled),
      })
    }
  }

  return { handle }
}

/**
 * 上游流式 body 透传失败的处理（幽灵连接/客户端断开）：
 * - 上游卡死（idle 超时）→ 200 响应头已提交（writeHead 在 pipe 之前），无法整体
 *   重试；直接销毁连接，让客户端感知截断后自行重试。不冷却账号（session 可能
 *   正常，只是那次传输卡了），下一请求仍可复用该 session。
 * - 客户端主动断开 → 静默终止：不重试、不冷却、不写错误。
 */
function handleStreamPipeFailure(err, req, res) {
  const stalled = Boolean(err?.stalled || err?.code === 'stream_idle_timeout')
  if (stalled) {
    return {
      ok: false,
      wrote: true,
      recoverable: false,
      switchAccount: false,
      gateCode: 'stream_idle_timeout',
      status: 504,
      body: {
        error: {
          message: 'upstream stream idle timeout',
          type: 'upstream_error',
          code: 'stream_idle_timeout',
        },
      },
      headers: {},
    }
  }
  // 客户端主动断开（pipe 内 res.destroy 是我们自己触发的，不能用来判断客户端状态）
  if (req.destroyed || err?.name === 'AbortError' || err?.code === 'client_gone') {
    return {
      ok: false,
      wrote: true,
      recoverable: false,
      switchAccount: false,
      gateCode: 'client_disconnected',
      status: 499,
    }
  }
  throw err
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

/**
 * 客户端断开的 abort 信号。**必须监听底层 socket 关闭**：node 的
 * IncomingMessage 'close' 是「请求体读完」事件（body 读完即触发，早于我们注册
 * 监听器的时机），监听它既收不到真正的断开、又会在 body 一读完就 abort 掉上游。
 * 客户端断开（含 keep-alive 下断开）只会体现在 socket close 上。若这里不 abort，
 * 上游 fetch 会一直挂着（最长等 upstreamTimeoutSec=600s），账号 chat 锁被占死，
 * 后续所有请求排队超时（实测 inFlight 卡满、客户端 headers 超时）。
 */
function reqToAbortSignal(req) {
  const controller = new AbortController()
  const onClose = () => controller.abort()
  // once + 用后 removeListener：keep-alive 连接被多个请求共享，不清理会累积监听器
  req.socket?.once('close', onClose)
  return {
    signal: controller.signal,
    cleanup() {
      req.socket?.removeListener('close', onClose)
    },
  }
}

/**
 * 把上游响应体透传给下游，带 idle 超时兜底：
 * 上游流式响应“发了一半不再吐数据、也不断开”（幽灵连接）时，超过
 * idleTimeoutMs 没有新数据块 → 取消上游读取、销毁下游连接，并抛出带
 * stalled 标记的错误（err.wroteBytes 记录已下发的字节数），
 * 由调用方决定换号重试还是直接断开。
 *
 * 客户端断开也必须立即中断：实测 reader.cancel()/fetch abort 都不能让挂起的
 * reader.read() 拒绝（会一直挂到 idle 超时），账号 chat 锁被占死。因此把
 * 「客户端连接关闭」显式加进 race，断开瞬间 reject 并释放锁。
 */
async function pipeWebStreamToNode(
  webBody,
  nodeRes,
  nodeReq,
  { idleTimeoutMs = 0 } = {},
) {
  const reader = webBody.getReader()
  let wroteBytes = 0
  /** 确定性 stall 标志：不依赖 race 谁先拒绝（reader.cancel 的拒绝原因各实现不同）。 */
  let stalled = false
  /** 确定性 client-gone 标志（同上：不依赖底层取消的拒绝原因）。 */
  let clientGone = false
  let timer = null
  let rejectStall = null
  let rejectGone = null
  let stallPromise = null
  let gonePromise = null

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
    rejectStall = null
    stallPromise = null
  }
  const armTimer = () => {
    clearTimer()
    if (!(idleTimeoutMs > 0)) return
    stallPromise = new Promise((_, reject) => {
      rejectStall = reject
    })
    stallPromise.catch(() => {}) // 防迟到拒绝变 unhandledRejection
    timer = setTimeout(() => {
      stalled = true
      reader.cancel().catch(() => {})
      if (rejectStall) rejectStall(new StreamStallError(idleTimeoutMs))
    }, idleTimeoutMs)
    if (timer.unref) timer.unref()
  }
  const armGone = () => {
    if (gonePromise) return
    gonePromise = new Promise((_, reject) => {
      rejectGone = reject
    })
    gonePromise.catch(() => {}) // 防迟到拒绝变 unhandledRejection
  }
  const stallGuard = (promise) =>
    Promise.race([promise, stallPromise, gonePromise].filter(Boolean))

  // 客户端断开只能靠底层 socket close 感知（req 'close' 是 body 读完事件，
  // 在管道注册前就已触发）；迟到触发的拒绝需要兜底 catch 防 unhandledRejection。
  const socket = nodeReq.socket
  const onSocketClose = () => {
    clientGone = true
    reader.cancel().catch(() => {})
    if (rejectGone) rejectGone(new ClientGoneError())
  }
  if (socket) socket.once('close', onSocketClose)

  armTimer()
  armGone()
  try {
    while (true) {
      const { done, value } = await stallGuard(reader.read())
      if (stalled) throw new StreamStallError(idleTimeoutMs)
      if (clientGone) throw new ClientGoneError()
      if (done) break
      if (value) {
        clearTimer()
        const buf = Buffer.from(value)
        wroteBytes += buf.length
        const ok = nodeRes.write(buf)
        if (!ok) {
          // 下游背压：客户端 TCP 窗口满，等待 drain。clearTimer 已在 write 前
          // 执行，若客户端"活着但不再读"（网络波动/卡顿，不关连接也不消费），
          // onceDrain 永不触发 → 账号 chat 锁被永久占死、后续请求全部超时
          // （与上游幽灵连接同源）。等待 drain 前必须重新武装 idle 定时器，
          // drain 后 armTimer() 会再重置计时。
          armTimer()
          await stallGuard(onceDrain(nodeRes))
          if (stalled) throw new StreamStallError(idleTimeoutMs)
          if (clientGone) throw new ClientGoneError()
        }
        armTimer()
      }
    }
    clearTimer()
    nodeRes.end()
    return { wroteBytes }
  } catch (err) {
    clearTimer()
    if (stalled && !(err instanceof StreamStallError)) {
      err = new StreamStallError(idleTimeoutMs)
    }
    if (clientGone && !(err instanceof ClientGoneError)) {
      err = new ClientGoneError()
    }
    if (err && typeof err === 'object' && err.wroteBytes == null) {
      err.wroteBytes = wroteBytes
    }
    try {
      nodeRes.destroy(err instanceof Error ? err : undefined)
    } catch {
      // ignore
    }
    throw err
  } finally {
    if (socket) socket.removeListener('close', onSocketClose)
  }
}

class ClientGoneError extends Error {
  constructor() {
    super('client disconnected while streaming upstream response')
    this.name = 'ClientGoneError'
    this.code = 'client_gone'
  }
}

class StreamStallError extends Error {
  constructor(idleTimeoutMs) {
    super(
      `upstream stream idle for ${idleTimeoutMs}ms without data; terminating`,
    )
    this.name = 'StreamStallError'
    this.code = 'stream_idle_timeout'
    this.stalled = true
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
