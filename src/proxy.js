import {
  requireModelId,
  buildModelsListResponse,
  modelIdsFromSession,
  agentIdForModel,
  agentFallbackForModel,
  isModelAllowed,
} from './model.js'
import {
  extractAccountBanError,
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
  safeText,
  UpstreamError,
} from './upstream/client.js'
import { randomUUID, timingSafeEqual } from 'node:crypto'
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
  getCliVersion,
  officialChatHeaders,
} from './upstream/official-fingerprint.js'
import {
  coerceUser,
  saveAccountUser,
  deleteAccountUser,
} from './auth-store.js'
import {
  ensureFreebuffSystemMessages,
  ensureFreebuffToolSignature,
  hasClientTools,
  normalizeReasoningFields,
  normalizeOutputBudget,
  stripClientTools,
  stripFreebuffConversationState,
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
  const { config, runtimes, userStore, settingsStore } = ctx
  if (!runtimes) {
    throw new Error('createProxyHandler requires ctx.runtimes (AccountRuntimes)')
  }

  /** 前端「模型管理」配置的自定义模型（覆盖内置目录），实时生效。 */
  function customModels() {
    return typeof ctx.modelStore?.list === 'function' ? ctx.modelStore.list() : []
  }

  /** 前端「模型管理」删除（隐藏）的模型 id，实时生效。 */
  function hiddenModels() {
    return typeof ctx.modelStore?.hidden === 'function'
      ? ctx.modelStore.hidden()
      : []
  }

  /**
   * 上游会话探测的轻量缓存（60s）：白名单校验用它判断"上游会话实际出现过
   * 哪些模型"，避免每次 chat 请求都实时打上游。探测失败不影响主流程。
   * @type {{ ids: string[], model: string | null, at: number } | null}
   */
  let sessionProbeCache = null
  const SESSION_PROBE_CACHE_MS = 60_000

  async function probeUpstreamSessionCached() {
    const now = Date.now()
    if (
      sessionProbeCache &&
      now - sessionProbeCache.at < SESSION_PROBE_CACHE_MS
    ) {
      return sessionProbeCache
    }
    try {
      const rt = runtimes.getAny()
      const session = await rt.upstream.freebuffSession('GET')
      sessionProbeCache = {
        ids: modelIdsFromSession(session),
        model:
          session && typeof session === 'object' && typeof session.model === 'string'
            ? session.model
            : null,
        at: now,
      }
    } catch {
      sessionProbeCache = { ids: [], model: null, at: now }
    }
    return sessionProbeCache
  }

  /** 上游会话出现过/限流表里的模型 id（白名单校验用）。 */
  function upstreamSessionModelIds() {
    return sessionProbeCache?.ids || []
  }

  /** 上游会话当前模型（白名单校验用）。 */
  function upstreamSessionModel() {
    return sessionProbeCache?.model ?? null
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
    const route = url.pathname
    const method = (req.method || 'GET').toUpperCase()

    if (method === 'GET' && (route === '/healthz' || route === '/health')) {
      sendJson(res, 200, { status: 'ok' })
      return
    }

    if (!authorize(req, res)) return

    if (method === 'GET' && route === '/v1/models') {
      await handleModels(res)
      return
    }

    if (method === 'GET' && route === '/v1/freebuff/status') {
      await handleStatus(res)
      return
    }

    if (method === 'GET' && route === '/v1/freebuff/accounts') {
      sendJson(res, 200, { object: 'list', data: runtimes.list() })
      return
    }

    if (method === 'POST' && route === '/v1/freebuff/accounts/import') {
      await handleAccountsImport(req, res)
      return
    }

    if (method === 'DELETE' && route === '/v1/freebuff/accounts') {
      await handleAccountsDelete(req, res)
      return
    }

    if (method === 'POST' && route === '/v1/freebuff/session/end') {
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

    if (method === 'POST' && route === '/v1/chat/completions') {
      await handleChatCompletions(req, res)
      return
    }

    // Auth-injected passthrough for other OpenAI-shaped /v1 routes only.
    // Chat completions are NOT handled here.
    if (route.startsWith('/v1/')) {
      await handleGenericPassthrough(req, res, url)
      return
    }

    sendJson(res, 404, {
      error: {
        message: `No route for ${method} ${route}. Public API is under /v1.`,
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
        customModels: customModels(),
        hiddenModels: hiddenModels(),
        blockPremium: blockPremiumModels(),
      }),
    )
  }

  /** 一键屏蔽收费模型开关（前端「模型管理」，实时生效）。 */
  function blockPremiumModels() {
    return settingsStore?.get()?.blockPremiumModels === true
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
        // 凭证更新时间落盘（前端「更新」列的数据源）。
        runtimes.markCredentialUpdated(saved.key)
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
    // 有界排队：闸门排满时最多等 slotWaitMs，超时以 429 server_busy 拒绝
    // （客户端可重试），绝不无界排队把整个服务静默钉死。
    let releaseSlot
    // 客户端在排队期间断开：立即放弃等待（否则这个"已死"的请求会一直占着
    // 它稍后拿到的槽位，直到走完整个上游流程）。
    const slotGone = clientGoneSignal(req)
    try {
      releaseSlot = await slotGone.race(
        acquireRequestSlot(config.limits.maxConcurrentRequests, slotWaitMs()),
      )
    } catch (err) {
      // client_gone：连接已没了，安静收场（无法再写响应）。
      if (err?.code !== 'client_gone') mapAndSendError(res, err)
      return
    } finally {
      slotGone.cleanup()
    }
    try {
      await handleChatCompletionsInner(req, res)
    } finally {
      releaseSlot()
    }
  }

  async function handleChatCompletionsInner(req, res) {
    let rawBuf
    try {
      rawBuf = await readRequestBody(req, undefined, bodyReadTimeoutMs())
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
      // 客户端在读 body 途中断开：连接已经没了，安静收场即可。
      if (err && err.code === 'client_aborted') return
      // 408 body_read_timeout：客户端声明了体积却没发完。绝不能让它继续
      // 占着全局槽位——明确拒绝并归还名额。
      if (err && err.statusCode === 408) {
        sendJson(res, 408, {
          error: {
            message: 'Timed out reading request body',
            type: 'invalid_request_error',
            code: 'body_read_timeout',
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

    // 模型白名单校验：未隐藏 + catalog/自定义/上游会话出现过才放行。
    // 避免把"APP 里没有的模型"探测请求盲发上游（上游会标记异常行为，是免费
    // 反代被封号的主要诱因）。未知模型不拦截免费用户（保守：catalog 更新有
    // 滞后，硬拒绝会误伤合法新模型），只对上游明确说"没有"的模型硬拒绝。
    //
    // 顺序很重要（性能）：**先**用本地三张表（catalog / 前端自定义 / 隐藏）
    // 判定——它们覆盖绝大多数请求，命中时完全不需要为了白名单等一次上游往返
    // （实测 580ms，见 test/repro-firstbyte.mjs）。只有"本地三张表都不认识"
    // 的模型才值得去问上游一次（60s 缓存、只读 GET、不占额度），此时才预热。
    const modelAllowOpts = {
      customModels: customModels(),
      hiddenModels: hiddenModels(),
      blockPremium: blockPremiumModels(),
    }
    let allowed = isModelAllowed(upstreamModel, modelAllowOpts)
    if (allowed) {
      // 命中本地表：后台预热会话缓存（/v1/models 与后续未知模型校验要用），
      // 但**不阻塞**本次请求。
      void probeUpstreamSessionCached().catch(() => {})
    } else {
      // 本地不认识：问一次上游（60s 缓存），再按上游是否见过决定放行/拒绝。
      await probeUpstreamSessionCached().catch(() => {})
      allowed = isModelAllowed(upstreamModel, {
        ...modelAllowOpts,
        sessionModelIds: upstreamSessionModelIds(),
        sessionModel: upstreamSessionModel(),
      })
    }
    if (!allowed) {
      logger.warn('model not allowed; rejecting before upstream', {
        model: upstreamModel,
      })
      sendJson(res, 400, {
        error: {
          message: `Model '${upstreamModel}' is not in this proxy's model list. ` +
            'Check the model id against GET /v1/models (or the web console「模型管理」). ' +
            'Unknown/retired ids are rejected to protect the account from upstream anomaly flags.',
          type: 'invalid_request_error',
          code: 'model_not_allowed',
          model: upstreamModel,
        },
      })
      return
    }

    const stream = Boolean(body.stream)
    /**
     * 「首字节之前」的总预算起点：全局槽位/账号锁/上游首字节这些静默等待
     * 全部计入。超预算即快速失败（429 scheduling_timeout），而不是让客户端
     * 对着一个一直转圈的连接等到自己超时（上游前面是 Cloudflare，100s 524）。
     */
    const schedulingDeadline = Date.now() + schedulingBudgetMs()
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
    /** 同一账号连续重试计数：同号重试过一次仍失败 → 升级为换号。 */
    let sameAccountRetries = 0
    /**
     * 本次请求已经"满员排队超时"过的账号：粘性调度会优先继续用已用账号
     * （甚至排队等它），若不在选号里排除，超时后会再次选中同一个账号反复等。
     */
    const skipKeys = new Set()
    /**
     * 本次下游请求允许新建的上游会话数（Freebucks 计费单位）。
     * 上游按整小时单价预扣、早退按实际占用退还（见 docs/account-scheduling-and-refund.md §3），
     * 旧行为在报错时把「账号数+1」个账号挨个 admit 一遍，一次故障就买断好几条整小时
     * （issue #7）。复用已有热 session 不消耗预算。
     */
    const budgetSetting = settingsStore?.get?.()?.maxNewSessionsPerRequest
    const sessionBudget = {
      remaining: Math.max(
        0,
        Math.floor(
          Number.isFinite(budgetSetting)
            ? budgetSetting
            : (config.limits.maxNewSessionsPerRequest ?? 2),
        ),
      ),
    }
    /** 当前持锁账号 runtime（账号级串行化：一个账号同一时间只处理一个 chat）。 */
    let heldRt = null
    /** 当前持有的账号 chat 锁释放函数。 */
    let releaseChat = null
    /**
     * 选号阶段占用的「槽位预留」释放函数（见 AccountRuntimes.reserveSlot）。
     * spread（并发优先）排序靠它看见"刚被选中、正在拿锁"的请求——否则 N 个并发
     * 请求会同时看到空账号、全部选中同一个号。拿到 chat 锁后立即交还。
     */
    let releaseReserved = null
    /**
     * 客户端断开信号（整个请求共用；finally 里 cleanup）。账号锁等待是
     * "首字节前静默等待"里最长的一段（热 75s / 冷 120s），客户端早就断了却
     * 还在闷等，且拿到锁后会继续跑完上游流程——死请求钉死账号并发。
     */
    const chatGone = clientGoneSignal(req)
    /** 是否已完整等待过账号锁（account_busy 超时一次后，再等只给短窗，避免 5 次重试 × 长等待）。 */
    let chatWaited = false
    /**
     * agent 覆盖（本次请求内贯穿重试）：startAgentRun 被上游以
     * free_mode_invalid_agent_model 拒绝时回退 base3 孪生（通用模型兜底）。
     * 注意：luna 系不经过这里——agentIdForModel 已强制 base3，永不尝试 base2。
     * @type {string | null}
     */
    let agentOverride = null

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
      // 预留槽位（选号时占用）必须**无论如何**交还：它是 spread 排序看见
      // "这个账号马上要满了"的唯一依据，泄漏一次就会让账号被误判为满员。
      if (releaseReserved) {
        releaseReserved()
        releaseReserved = null
      }
    }

    /**
     * 账号锁等待时长（仅在所有可用账号都满员时排队才生效；有账号空闲时
     * 选号阶段就已换号，不会走到这里）：
     * - 热 session（同模型可直接复用）：等一个完整 idle 超时周期。上游卡死也会在
     *   streamIdleTimeoutSec 后被掐断释放锁，所以热会话优先排队复用而不是新建 session。
     * - 冷账号/换模型：只等固定窗口，超时即换下一个账号。
     */
    function chatWaitMs(rt) {
      // spread 模式：并发优先——账号满员就是"该换号了"，只给一个短窗
      // （accountOverflowWaitMs，默认 15s）就溢出到下一个账号，绝不把并发
      // 钉死在一个账号上干等。sticky（默认）保留大等待：宁可排队也不换号，
      // 因为换号 = 新买一条 Freebucks 计费会话。
      if (runtimes.schedulingMode() === 'spread') {
        const overflow = settingsStore?.get?.()?.accountOverflowWaitMs
        const ms = Number.isFinite(overflow) ? overflow : 15_000
        return Math.max(0, Math.min(ms, 60_000))
      }
      if (rt.sessions.isUsableForModel(upstreamModel)) {
        return ((config.limits.streamIdleTimeoutSec || 120) * 1000) + 15_000
      }
      return config.limits.accountChatWaitMs || 60_000
    }

    // Session-first scheduling: reuse a live same-model slot, serialized per
    // account (one account handles at most `accountMaxConcurrency` chats at a
    // time). The upstream is stateless because clients send the full history.
    // 账号并发上限即"满了换号"的阈值：在途已满的账号排最后，新请求优先去
    // 有空闲槽位的账号；所有账号都满员时才排队（有界等待，超时 account_busy）。
    // 故障转移：除了 4xx 客户端错误，任何上游失败（session/run/chat/网络超时）都
    // 冷却当前账号并继续轮询下一个，只有试完所有账号才把错误返回给用户。
    try {
      while (attempt < maxAttempts) {
        attempt++
        try {
          // Single reacquire path: first attempt acquires; retries use gate from previous failure.
          const rt =
            attempt === 1
              ? await runtimes.acquireForModel(upstreamModel, {
                  sessionBudget,
                  skipKeys,
                })
              : await runtimes.reacquireAfterGate(upstreamModel, {
                  preferredKey: lastKey,
                  gateCode: pendingGateCode,
                  retryAfterMs: pendingRetryAfterMs,
                  switchAccount: pendingSwitchAccount,
                  noCooldown: pendingNoCooldown,
                  sessionBudget,
                  skipKeys,
                })
          pendingGateCode = null
          pendingRetryAfterMs = null
          pendingSwitchAccount = false
          pendingNoCooldown = false
          // 本轮选号占用的槽位预留：换号时必须先交还上一个账号的预留
          // （它已经不在本次请求的候选里了），再接管新账号的预留。
          if (releaseReserved) {
            releaseReserved()
            releaseReserved = null
          }
          releaseReserved =
            typeof rt.releaseReservedSlot === 'function'
              ? rt.releaseReservedSlot
              : null
          if (lastKey && rt.key !== lastKey) {
            // 已经换到不同账号 → 重置同账号重试计数，并释放上一账号的串行化锁
            sameAccountRetries = 0
            dropChatHold()
            // agentOverride 是针对上一账号的 agent 覆盖（free_mode_invalid_agent_model
            // 等按该账号+agent 组合判定）。换到新账号后必须清空，让新账号从它自己的
            // 主 agent 重新尝试——否则上一账号被拒的 agent 覆盖会泄漏到新账号上，
            // 使新账号跳过主 agent、直接用孪生/兜底（偏离其应有主 agent）。
            if (agentOverride !== null) {
              logger.warn('reset agent override on account switch', {
                fromKey: lastKey,
                toKey: rt.key,
                model: upstreamModel,
                wasAgentOverride: agentOverride,
              })
              agentOverride = null
            }
          }
          lastKey = rt.key

          // 账号并发上限：同一账号同时在途流数不超过上限（热会话优先复用，
          // 选号阶段已把满员账号排后；只有所有账号都满员时才排队复用，
          // 超时兜底换号）。**任何一次获取都必须有界**：兜底阶段虽然预算已
          // 耗尽（不会再换号），但若持锁者因网络波动卡死（幽灵连接），无限
          // 等待会让本请求永久挂起、所有后续请求排队超时——必须像前面的
          // acquire 一样设上界，超时把 account_busy 返回给客户端（可重试），
          // 绝不无限等待。
          if (!heldRt) {
            // 已在上一轮完整等待过账号锁（account_busy）→ 本轮只给短窗
            // （账号并发上限即"满了换号"阈值：所有账号都满员时才排队复用热
            // 会话，但排队只等一次完整 idle 周期，之后必须尽快换下一个账号，
            // 而不是在满员账号上反复长等把并发全部钉死）。
            // 夹到剩余调度预算：账号锁是本阶段最长的一段（热 75s / 冷 120s），
            // 不能让它单独把整个请求拖过客户端耐心与 Cloudflare 100s 悬崖。
            const budgetLeft = schedulingDeadline - Date.now()
            if (budgetLeft <= 0) {
              throw new UpstreamError(
                'scheduling budget exhausted before a chat slot was free',
                { status: 429, code: 'scheduling_timeout' },
              )
            }
            const waitMs = Math.max(
              1,
              Math.min(
                chatWaited ? Math.min(chatWaitMs(rt), 5_000) : chatWaitMs(rt),
                budgetLeft,
              ),
            )
            try {
              releaseChat = await chatGone.race(
                runtimes.acquireChat(rt.key, waitMs),
              )
            } catch (lockErr) {
              if (lockErr?.code === 'client_gone') throw lockErr
              if (lockErr?.code === 'account_busy' && attempt < maxAttempts) {
                logger.warn('account busy; trying next account', {
                  key: rt.key,
                  email: rt.email,
                  model: upstreamModel,
                  attempt,
                  waitedMs: waitMs,
                })
                chatWaited = true
                // 满员排队超时：把该账号从本次请求的候选中排除，下一轮才
                // 真正换到别的账号（否则粘性排序会再次选中它反复等）。
                skipKeys.add(rt.key)
                pendingGateCode = 'account_busy'
                pendingSwitchAccount = true
                pendingNoCooldown = true
                continue
              }
              const finalWaitMs = Math.max(
                1,
                Math.min(chatWaitMs(rt), schedulingDeadline - Date.now()),
              )
              logger.warn('account busy; final bounded wait for chat slot', {
                key: rt.key,
                email: rt.email,
                model: upstreamModel,
                attempt,
                waitMs: finalWaitMs,
              })
              releaseChat = await chatGone.race(
                runtimes.acquireChat(rt.key, finalWaitMs),
              )
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
            // 已经拿到真实槽位 —— 预留完成使命，立刻交还（此后由
            // chatLock.inFlight 承担"这个账号有多满"的事实来源）。
            if (releaseReserved) {
              releaseReserved()
              releaseReserved = null
            }
          }

          let result
          let runId
          /** 本 run 的 client_id（对齐 trefeon：每个 run 一个 client_id，
           * 整个 run 的所有 chat 调用复用——client_id 绑定 run 生命周期，
           * 绝不在同一 run 的多次 chat 间 fanout（free_mode_run_fanout）。 */
          let clientId
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
            // agentOverride：本请求上一次尝试因 free_mode_legacy_luna_agent 失败
            // 后置为 base3 孪生（上游退役旧 agent 时换 session 没用，必须换 agent）。
            const agentId = agentOverride || agentIdForModel(upstreamModel, customModels())
            try {
              runId = await rt.upstream.startAgentRun({ agentId })
              clientId = newIds().clientId
            } catch (agentErr) {
              if (
                agentErr instanceof UpstreamError &&
                (agentErr.code === 'start_agent_run_failed' ||
                  agentErr.code === 'free_mode_invalid_agent_model') &&
                agentErr.status === 403
              ) {
                const fbAgentId = agentFallbackForModel(
                  upstreamModel,
                  customModels(),
                )
                if (fbAgentId !== agentId) {
                  logger.warn('primary agent rejected; falling back', {
                    agentId,
                    fbAgentId,
                    model: upstreamModel,
                    key: rt.key,
                  })
                  agentOverride = fbAgentId
                  runId = await rt.upstream.startAgentRun({ agentId: fbAgentId })
                  clientId = newIds().clientId
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
              agentId,
              clientId,
            )
            result = await forwardCompletions({
              req,
              res,
              forwardBody,
              stream,
              upstream: rt.upstream,
              // 会话剩余时间：用于把流 idle 超时收敛到会话过期附近，过期即掐
              sessionRemainingMs: snap.remainingMs,
              schedulingDeadline,
              upstreamModel,
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

          // 幽灵连接（流 idle 超时被掐断）：响应头已提交、无法整体重试，但
          // 该账号刚被掐断过一条卡死的链路——上游/网络对该会话不稳定。给账号
          // 一个短暂冷却（stallCooldownSec，默认 30s），让后续新请求优先去别的
          // 账号，避免反复撞上同一条卡死链路；不冷却会导致卡死的账号继续吸收
          // 新流量（用户实测：一个账号 3/3 满了还在持续接收请求）。
          if (
            result.gateCode === 'stream_idle_timeout' &&
            !result.ok &&
            config.limits.stallCooldownSec > 0
          ) {
            runtimes.markCooldown(
              lastKey,
              new UpstreamError('stream_idle_timeout', {
                code: 'stream_idle_timeout',
                status: 504,
                retryAfterMs: config.limits.stallCooldownSec * 1000,
              }),
              upstreamModel,
            )
            logger.warn('stream stall; cooling account briefly', {
              key: lastKey,
              email: rt?.email,
              model: upstreamModel,
              cooldownSec: config.limits.stallCooldownSec,
            })
          }

          if (result.recoverable && attempt < maxAttempts) {
            // 先判定是否换号，再累加同号重试计数（顺序不能反：反了会让
            // 第一次同号重试就被判成"该换号"）。
            const willSwitch =
              result.switchAccount === true || sameAccountRetries >= 1
            sameAccountRetries = willSwitch ? 0 : sameAccountRetries + 1
            // free_mode_legacy_luna_agent：上游退役旧 Luna agent。agentIdForModel
            // 已对 luna 系强制 base3（见 model.js），重试换 session 即用新 agent，
            // 不再需要额外的 agentOverride——任何 base2 尝试都不会发生。
            logger.warn('session error; will re-acquire', {
              code: result.gateCode,
              attempt,
              budget: maxAttempts,
              model: upstreamModel,
              key: lastKey,
              switchAccount: willSwitch,
              noCooldown: result.noCooldown === true,
              retryAfterMs: result.retryAfterMs ?? null,
            })
            pendingGateCode = result.gateCode
            pendingRetryAfterMs = result.retryAfterMs ?? null
            pendingSwitchAccount = willSwitch
            pendingNoCooldown = result.noCooldown === true
            // 换号前把失败账号的会话早退 DELETE：它已经在冷却，没人会再用它，
            // 留着只会白占一个上游会话槽位（该账号再也 admit 不了别的模型）。
            if (willSwitch && lastKey) runtimes.releaseSession(lastKey)
            continue
          }

          // 最后一次尝试也失败：把当前账号标记冷却（gate 瞬时问题 noCooldown 除外），
          // 避免下一个请求立刻又撞上同一个故障账号。
          //
          // 同时**必须把该账号的会话早退 DELETE 掉**：请求已经不会再用这条
          // 会话了，留着只会白占上游会话槽位（一个账号同时只有一条 session 且
          // 绑定模型），换模型时会被它挡住。一次 admit 买断一小时，付费时段内
          // 换模型才需要早退腾槽位（那一小时已付款，闲置不额外花钱）。
          // 释放失败也不丢句柄（SessionManager
          // 会保留 instanceId 并重试，sessions.json 里还有一份）。
          if (lastKey) {
            const st = result.status
            const clientError =
              typeof st === 'number' &&
              st >= 400 &&
              st < 500 &&
              st !== 429 &&
              result.noCooldown !== true
            if (!clientError || result.gateCode === 'stream_idle_timeout') {
              logger.info('final attempt failed; releasing session to free the slot', {
                key: lastKey,
                model: upstreamModel,
                gateCode: result.gateCode,
                status: st,
              })
              runtimes.releaseSession(lastKey)
            }
          }
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
            // 终态错误：没有可用账号 / 参数缺失，直接返回。
            const isTerminal =
              err.code === 'no_available_account' ||
              err.code === 'model_required' ||
              err.code === 'upstream_auth_missing' ||
              // 客户端已断开：换号只会再买一条 Freebucks 计费会话给一个
              // 没人接收的响应，必须立刻收场（连接已死，写不出去也不报错）。
              err.code === 'client_gone' ||
              // 调度预算已耗尽：预算是整个请求一份，后续每轮都会立即再超，
              // 重试只会白烧 maxAttempts 次循环，直接快速失败让客户端重试。
              err.code === 'scheduling_timeout'
            if (isTerminal) {
              if (err.code !== 'client_gone') mapAndSendError(res, err)
              return
            }
            if (attempt < maxAttempts) {
              if (isSessionRecoverableGate(err.code)) {
                logger.warn('recoverable session error; will re-acquire', {
                  code: err.code,
                  attempt,
                  key: lastKey,
                })
                // 同号 re-admit 一次；再失败即换号（见下方 sameAccountRetries）。
                const willSwitch = sameAccountRetries >= 1
                sameAccountRetries += 1
                pendingGateCode = err.code
                pendingSwitchAccount = willSwitch
                pendingNoCooldown = false
                if (willSwitch && lastKey) runtimes.releaseSession(lastKey)
                continue
              }
              // 上游错误（startAgentRun 失败 / no_session / 5xx 等）：
              // - 账号级故障（限流/封禁/配额）→ 冷却换号；
              // - 其他（5xx/网络/上游瞬时故障）→ 先在同一账号上重试一次：
              //   复用热 session，不新建计费会话；同号再失败才换号。
              const accountSpecific = shouldSwitchAccountOnError(
                err.status,
                err.code,
              )
              const willSwitch = accountSpecific || sameAccountRetries >= 1
              logger.warn(
                willSwitch
                  ? 'upstream error; switching account'
                  : 'upstream error; retrying same account (no new session)',
                {
                  code: err.code,
                  status: err.status,
                  attempt,
                  key: lastKey,
                  model: upstreamModel,
                },
              )
              sameAccountRetries = willSwitch ? 0 : sameAccountRetries + 1
              pendingGateCode = err.code || `http_${err.status || 502}`
              pendingRetryAfterMs = err.retryAfterMs ?? null
              pendingSwitchAccount = willSwitch
              pendingNoCooldown = false
              if (willSwitch && lastKey) runtimes.releaseSession(lastKey)
              continue
            }
            // 最后一次尝试也失败（无重试机会）：会话不会再被用，立刻早退
            // DELETE 释放槽位，而不是等空闲释放 / 挂到过期。
            if (lastKey) {
              logger.info('final upstream error; releasing session to free the slot', {
                key: lastKey,
                model: upstreamModel,
                code: err.code,
                status: err.status,
              })
              runtimes.releaseSession(lastKey)
            }
            mapAndSendError(res, err)
            return
          }
          // 非 UpstreamError：网络错误 / 上游超时（socket 断开、代理不可达等）。
          // 先同号重试一次（热 session 复用，不新建计费会话），再失败才换号；
          // 客户端是否已断开无法可靠区分（req.destroyed 在请求体读完后就为 true），
          // 多试一轮最多浪费一次上游调用。
          if (attempt < maxAttempts) {
            const willSwitch = sameAccountRetries >= 1
            logger.warn(
              willSwitch
                ? 'upstream network error; switching account'
                : 'upstream network error; retrying same account (no new session)',
              {
                error: err instanceof Error ? err.message : String(err),
                attempt,
                key: lastKey,
                model: upstreamModel,
              },
            )
            sameAccountRetries = willSwitch ? 0 : sameAccountRetries + 1
            pendingGateCode = 'upstream_network_error'
            pendingRetryAfterMs = null
            pendingSwitchAccount = willSwitch
            pendingNoCooldown = false
            if (willSwitch && lastKey) runtimes.releaseSession(lastKey)
            continue
          }
          logger.error('chat completions failed', {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          })
          // 网络类错误、重试已耗尽：会话不会再被本次请求使用，立刻 DELETE
          // 释放槽位（失败也会保留句柄重试），别让它挂到过期。
          if (lastKey) {
            logger.info('final network error; releasing session to free the slot', {
              key: lastKey,
              model: upstreamModel,
              error: err instanceof Error ? err.message : String(err),
            })
            runtimes.releaseSession(lastKey)
          }
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
      // 请求结束（成功/失败/预算耗尽）：释放账号串行化锁，恢复该账号轮询；
      // 并摘掉客户端断开监听器（keep-alive 连接复用，不摘会累积监听器）。
      dropChatHold()
      chatGone.cleanup()
    }
  }

  function buildForwardBody(clientBody, upstreamModel, instanceId, runId, agentId, clientId) {
    const { clientId: fallbackClientId } = newIds()
    const effectiveClientId = clientId || fallbackClientId
    let body = stripFreebuffConversationState({
      ...clientBody,
      model: upstreamModel,
    })
    // One reasoning field only — avoids Freebuff default + client dual fields.
    body = normalizeReasoningFields(body)
    // 输出预算治理：客户端偏小的 max_tokens/max_completion_tokens 会把思考链
    // （reasoning token 计入该预算）提前掐断（finish_reason=length）——参考
    // freebuff2api-wokers#8「DS4 思考链稍长即截断」。转发上游前抬到 floor。
    body = normalizeOutputBudget(body)
    // Free mode requires a system message opening with the Freebuff CLI marker
    // ("You are Buffy, the strategic coding assistant."). Without it the
    // upstream returns free_mode_cli_required. base3-free-* agent 用 base3
    // 规范开场（对齐 trefeon PR #207：base3 run 必须以 base3 canonical 身份
    // 开头，而不是 base2 的 strategic-assistant 身份）。
    body.messages = ensureFreebuffSystemMessages(body.messages, agentId)
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
    // client_id：SDK 形 13 位 base36（对齐官方 CLI），每 run 一次，绝不用
    // 自有前缀——上游 cf-worker-signals.ts 的 looksLikeProxyClientId 会指纹
    // 代理形态 client id（详见 util/http.js generateClientId）。
    body.codebuff_metadata = {
      ...existingMeta,
      run_id: runId,
      client_id: effectiveClientId,
      cost_mode: 'free',
      freebuff_instance_id: instanceId,
      ...(existingMeta.trace_session_id
        ? {}
        : { trace_session_id: randomUUID() }),
    }
    // provider.data_collection=deny：官方 CLI 每次 chat 都带（拒绝数据采集），
    // 缺失反而与官方客户端不一致。客户端自带 provider 时保留其字段，补上 deny。
    body.provider = {
      ...(body.provider && typeof body.provider === 'object'
        ? body.provider
        : {}),
      data_collection: 'deny',
    }
    // CLI 全局停止序列：JSON 编码带引号的哨兵 `"cb_easp"`（agent-runtime
    // globalStopSequence = JSON.stringify(endsAgentStepParam)），客户端没给
    // stop 时补上，与官方 CLI 一致。
    if (!body.stop) {
      body.stop = [`"cb_easp"`]
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

  /**
   * 全局请求闸门的排队上限（毫秒）。有界即可：这是"同一进程内等一个并发
   * 名额"的预算，不是上游等待。给足 15s 让突发流量自然消化，超时就明确
   * 拒绝，绝不像旧实现那样把请求永久挂在队列里。可用
   * limits.slotWaitMs 调整（<=0 表示一旦排满立即拒绝）。
   */
  function slotWaitMs() {
    const v = config.limits.slotWaitMs
    return Number.isFinite(v) && v > 0 ? v : 0
  }

  /**
   * 「首字节之前」的调度总预算（毫秒）。上游链路前置 Cloudflare（源站 100s
   * 未回响应头即 524），而本代理在 writeHead 之前有多段串行静默等待（全局槽位
   * → 账号 chat 锁 → 上游首字节）。默认 45s：留足正常排队余量，又明显低于
   * 100s 悬崖，绝不把请求静默拖到客户端早已超时。
   */
  function schedulingBudgetMs() {
    const v = config.limits.schedulingBudgetMs
    return Number.isFinite(v) && v > 0 ? v : 45_000
  }

  /** 读请求体的上限（毫秒）。<=0 关闭（不建议）。 */
  function bodyReadTimeoutMs() {
    const v = config.limits.bodyReadTimeoutMs
    return Number.isFinite(v) && v > 0 ? v : 0
  }

  async function forwardCompletions({
    req,
    res,
    forwardBody,
    stream,
    upstream,
    sessionRemainingMs,
    /**
     * 「首字节之前」的调度截止时间戳（含全局槽位/账号锁/上游首字节）。
     * 上游首字节也必须受它约束：不然账号锁等到位了，首字节又能再等 60s，
     * 总和照样冲过 Cloudflare 的 100s 悬崖。
     */
    schedulingDeadline,
    /** 上游模型 id（仅用于日志；forwardBody.model 即它，但显式传更清楚）。 */
    upstreamModel,
  }) {
    const headers = {
      ...filterRequestHeaders(req.headers),
      'content-type': 'application/json',
      // 官方 CLI chat 的 Accept 是 `application/json, text/event-stream`
      // （对齐 trefeon chat.go:105）。流式路径用官方值；非流式保持 application/json。
      accept: stream
        ? 'application/json, text/event-stream'
        : req.headers.accept || 'application/json',
      // chat 头逐字对齐官方 codebuff provider 分支：**只有** Authorization +
      // user-agent（+可选 x-freebuff-acting-user-id）。官方 chat **不带**
      // x-codebuff-api-key —— 那个头只出现在 session / agent-runs 等端点；多发就是
      // 多余的指纹面。常量真源见 src/upstream/official-fingerprint.js 与
      // .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
      ...officialChatHeaders(upstream.token, {
        version: getCliVersion(),
      }),
    }

    // 风控：chat 调用前打散节奏（随机 [0, requestJitterMs)）。上游按请求
    // 节奏指纹自动化脚本，等间隔的机器式调用是明显特征（参考项目 SAFE_MODE
    // 默认 200ms）。0 = 关闭。
    const jitterMs = Number(config.limits.requestJitterMs) || 0
    if (jitterMs > 0) await sleep(Math.random() * jitterMs)

    const abortCtrl = reqToAbortSignal(req)
    // 工具声明被上游拒绝时，去掉 tools 再发一次（见 isToolSchemaRejection）。
    // 只对"客户端确实带了 tools"的请求生效——没有工具可去时重试毫无意义。
    // 判据与取舍见
    // .agents/notes/implemented/bug-fix/2026-09-18-tool-schema-rejection-strip.md
    const toolStripCapable =
      hasClientTools(forwardBody) &&
      settingsStore?.get?.()?.stripToolsOnSchemaRejection !== false
    let requestBody = forwardBody
    let toolsStripped = false
    let upstreamRes
    /** 非 2xx 时上游响应体的文本（在循环里读一次，避免重复消费流）。 */
    let upstreamErrText = null
    try {
      // 最多两轮：第一轮带原工具集，被 tool-schema 拒后第二轮去掉工具。
      for (let round = 0; round < 2; round++) {
        upstreamRes = await upstream.raw('/api/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: abortCtrl.signal,
          // 响应头等待上限收紧到 body idle 同量级（默认 120s，带 30s 下限）：
          // chat 是流式接口，正常秒级出响应头；网络波动（TCP 黑洞）时若等
          // upstreamTimeoutSec（默认 600s）才 abort，账号 chat 锁会被占死
          // 10 分钟，期间所有新请求超时——与幽灵连接同源，必须尽快释放。
          timeoutMs: Math.max(
            1_000,
            Math.min(chatHeaderTimeoutMs(), schedulingDeadline - Date.now()),
          ),
        })
        if (upstreamRes.ok) {
          upstreamErrText = null
          break
        }
        const errText = await safeText(upstreamRes)
        if (
          round === 0 &&
          toolStripCapable &&
          isToolSchemaRejection(upstreamRes.status, errText)
        ) {
          toolsStripped = true
          requestBody = stripClientTools(forwardBody)
          logger.warn('tool-schema rejection; retrying without tools', {
            status: upstreamRes.status,
            model: forwardBody.model,
            tools: Array.isArray(forwardBody.tools)
              ? forwardBody.tools.length
              : 0,
          })
          continue
        }
        upstreamErrText = errText
        break
      }
    } finally {
      // 响应头已到/上游已失败：后续由 pipe 的 socket 监听接管，移除本监听器
      abortCtrl.cleanup()
    }

    const status = upstreamRes.status
    const respHeaders = filterResponseHeaders(upstreamRes.headers)
    if (toolsStripped) {
      // 可观测性：下游能看出这次回答是在"无工具"模式下取得的。
      res.setHeader('x-freebuff-proxy-tools-stripped', '1')
    }

    if (!upstreamRes.ok) {
      const text = upstreamErrText ?? (await safeText(upstreamRes))
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
      // 账号封禁归一：上游把"因第三方客户端被封"写成 403
      // {"error":"account_suspended",...}（error 是**字符串**）。不归一它就会以
      // 403 落进"4xx 客户端错误不换号"分支 —— 每个被封的账号被反复复用、错误
      // 原样甩给下游，控制台也记不上 bannedAt（见 extractAccountBanError）。
      // 归一后必须**重算 errCode**：下面的 shouldSwitchAccountOnError 与
      // markCooldown 都按 errCode 分支，只改 parsedBody 而留着旧 errCode 等于没改。
      const banCode = extractAccountBanError(parsed, status)
      if (banCode && parsed && typeof parsed === 'object') {
        parsed.error =
          parsed.error && typeof parsed.error === 'object'
            ? { ...parsed.error, code: banCode }
            : { code: banCode, message: parsed.error || parsed.message }
      }
      const effectiveErrCode = banCode || errCode
      const parsedBody = parsed || {
        error: { message: text, type: 'upstream_error' },
      }

      // free_mode_capacity_deferred：免费模式瞬时容量排队（上游原话
      // "your request will be retried automatically"）。不是账号级故障——
      // 实测同一账号同一 session 立即重试即恢复（flash 尤其常见）。
      // 优先复用当前热 session 重试，但绝不冷却账号，避免为瞬时容量
      // 无谓开启另一个计费 session；若账号另有故障，外层仍会正常切号。
      if (
        effectiveErrCode === 'free_mode_capacity_deferred' ||
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
      const switchAccount = shouldSwitchAccountOnError(status, effectiveErrCode)
      if (switchAccount) {
        return {
          ok: false,
          wrote: false,
          recoverable: true,
          switchAccount: true,
          gateCode:
            typeof effectiveErrCode === 'string'
              ? effectiveErrCode
              : `http_${status}`,
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

/** 有界等待（毫秒）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}

function methodHasBody(method) {
  const m = (method || 'GET').toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}

/**
 * 上游是否因为**工具集指纹**拒绝了这次 chat。
 *
 * 现场（2026-09-18 直连线上 freebuff-proxy 一手实测）：带任意 `tools`
 * （含逐字复刻官方 24 个工具名 + 中性 schema）→
 * `404 {"error":{"message":"No endpoints found for <model>","code":404}}`；
 * 同一个请求去掉 `tools` → 200。
 *
 * 这条错误**字面指向模型**，与工具毫无关联——正因如此它长期被当成
 * "模型不存在/不可用"处理（404 属于 4xx 客户端错误，不换号、不重试），
 * 最终把一个 404 透传给下游；下游 Responses 桥接层把它崩成 Cloudflare
 * 纯文本 502，客户端 SDK 解析成 "502 status code (no body)"，表现为
 * **所有模型全部空响应**。
 *
 * 所以必须按"工具被拒"识别并走剥离重试，不能按客户端 4xx 收场。
 * 取舍与实测矩阵见
 * .agents/notes/implemented/bug-fix/2026-09-18-tool-schema-rejection-strip.md
 *
 * @param {number} status
 * @param {string} text 上游响应体原文
 * @returns {boolean}
 */
function isToolSchemaRejection(status, text) {
  if (status !== 404) return false
  const s = String(text || '')
  return (
    s.includes('No endpoints found') ||
    s.includes('no_endpoints') ||
    s.includes('no endpoints')
  )
}

/**
 * 上游 chat/completions 报错时是否应冷却当前账号并换号重试：
 * 429（限流/配额）、5xx（服务端故障）、403 账号级封禁（banned/country_blocked/ip_capped）、
 * free_mode_rate_limited 等账号级限流 code，以及 start_agent_run_failed（startAgentRun
 * 被上游拒绝＝该账号+agent 组合不可用／账号级问题，即使 403/4xx 也应按账号故障换号）。
 * 其余 4xx 客户端错误不换号。
 * @param {number} status
 * @param {unknown} code
 * @returns {boolean}
 */
function shouldSwitchAccountOnError(status, code) {
  if (status >= 500) return true
  if (status === 429) return true
  const codeStr = String(code)
  if (
    status === 403 &&
    ['banned', 'country_blocked', 'ip_capped'].includes(codeStr)
  ) {
    return true
  }
  // startAgentRun 失败：上游拒绝启动 run（模型/agent 不可用、该账号被限制等）。
  // 无论返回什么状态码都冷却当前账号换下一个，而不是直接把错误甩给用户——
  // 试完所有账号（预算=账号数+1）才把错误返回给客户端。
  if (codeStr === 'start_agent_run_failed') return true
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

/** 在途 chat 请求数（占用中的槽位）。 */
let _inFlight = 0
/** 最近一次生效的槽位上限（仅用于可观测性展示）。 */
let _slotLimit = 32
/** @type {Array<{resolve: (fn: () => void) => void, timer: any}>} */
const _waitQueue = []

/**
 * 全局 chat 请求并发闸门（进程内信号量）。
 *
 * **绝不允许无界排队**：旧实现把超限请求 push 进一个**没有任何超时**的
 * _waitQueue，此后永不 reject。只要有几个请求在"占着槽位却永久挂起"
 * （最典型：客户端/SDK 声明了 Content-Length 却不再发完请求体，readRequestBody
 * 的 for await (const chunk of req) 就永远不返回），槽位就被永久吃掉，
 * 后续**所有**请求都排进那个队列再也出不来——进程 CPU/日志/控制台一切正常，
 * 但完全不接单，只有重启才恢复（已用真实 server 复现，见 test/smoke.mjs）。
 *
 * 现在的语义：
 *   - 有空位 → 立即占用；
 *   - 排满 → **有界等待**（slotWaitMs），超时抛 429 server_busy 让客户端稍后
 *     重试（客户端可重试远好于整个服务静默停摆）；
 *   - 释放函数**幂等**（与 ChatMutex._makeRelease 一致）：finally 与任何
 *     兜底路径重复调用都只归还一次，绝不让计数被多减。
 * @param {number} max
 * @param {number} [waitMs] 排队上限；<=0 表示不等待、直接拒绝
 * @returns {Promise<() => void>}
 */
function acquireRequestSlot(max, waitMs = 0) {
  const limit = Number.isFinite(max) && max > 0 ? max : 32
  _slotLimit = limit
  if (_inFlight < limit) {
    _inFlight++
    return Promise.resolve(makeSlotRelease())
  }
  if (!(waitMs > 0)) {
    throw new UpstreamError(
      "server is at max concurrent requests (" + limit + "); try again later",
      { status: 429, code: "server_busy" },
    )
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, timer: null }
    entry.timer = setTimeout(() => {
      const i = _waitQueue.indexOf(entry)
      if (i >= 0) _waitQueue.splice(i, 1)
      reject(
        new UpstreamError(
          "server is at max concurrent requests (" + limit +
            "); timed out waiting for a slot",
          { status: 429, code: "server_busy" },
        ),
      )
    }, waitMs)
    if (entry.timer.unref) entry.timer.unref()
    _waitQueue.push(entry)
  })
}

/** 幂等释放句柄：重复调用只归还一次槽位（与 ChatMutex._makeRelease 同构）。 */
function makeSlotRelease() {
  let released = false
  return () => {
    if (released) return
    released = true
    releaseRequestSlot()
  }
}

function releaseRequestSlot() {
  _inFlight = Math.max(0, _inFlight - 1)
  const next = _waitQueue.shift()
  if (next) {
    if (next.timer) clearTimeout(next.timer)
    _inFlight++
    next.resolve(makeSlotRelease())
  }
}

/**
 * 当前在途/排队的 chat 请求数：暴露到控制台，槽位泄漏时能立刻看出来
 * （旧实现完全不可观测，泄漏后只能靠"不接单"这个体感发现）。
 */
export function requestSlotStats() {
  return { inFlight: _inFlight, queued: _waitQueue.length, limit: _slotLimit }
}

/**
 * 客户端断开信号（**调度阶段**用，区别于下方的 pipe 阶段）。
 *
 * 为什么必须有：本代理在调度上有多个「首字节之前的静默等待」——全局槽位、
 * 账号 chat 锁、上游首字节。这些等待原先完全不感知客户端是否还在。客户端
 * （DSH/sub2api）等不住会自行超时并 abort 旧请求，但代理这边仍在闷等
 * （账号锁最长 accountChatWaitMs，默认 120s），**并且继续占着账号 chat 锁**。
 * 账号并发默认只有 2，粘性调度又把请求集中到同一个账号上，于是几个"已死"的
 * 请求就能把账号锁钉死 → 后续所有请求排队 → 表现为「跑着跑着完全不接单，
 * 只有重启才恢复」。
 *
 * 语义：socket close → 视为客户端已走，等待立即放弃，并保证稍后授予的锁被释放。
 * @param {import('node:http').IncomingMessage} req
 */
function clientGoneSignal(req) {
  const socket = req.socket
  /** @type {(() => void) | null} */
  let onClose = null
  const promise = new Promise((resolve) => {
    if (!socket || socket.destroyed) {
      resolve()
      return
    }
    // 与 reqToAbortSignal 同因：只有底层 socket close 才代表真断开
    // （req 'close' 在 body 读完时就触发，早于这里注册的时机）。
    onClose = () => resolve()
    socket.once('close', onClose)
  })
  return {
    /** 客户端是否已断开（同步判断）。 */
    isGone: () => Boolean(socket && socket.destroyed),
    /** 与等待 Promise 竞速；客户端断开时以 client_gone 提前结束等待。 */
    async race(waitPromise) {
      const outcome = await Promise.race([
        waitPromise.then((hold) => ({ hold }), (err) => ({ err })),
        promise.then(() => ({ gone: true })),
      ])
      if (outcome.gone) {
        // 竞速输了不等于锁没授予：授予后立刻归还，绝不泄漏槽位。
        waitPromise.then((hold) => hold()).catch(() => {})
        throw new UpstreamError(
          'client disconnected while waiting for a scheduling slot',
          { status: 499, code: 'client_gone' },
        )
      }
      if (outcome.err) throw outcome.err
      return outcome.hold
    },
    cleanup() {
      if (onClose && socket) socket.removeListener('close', onClose)
    },
  }
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
