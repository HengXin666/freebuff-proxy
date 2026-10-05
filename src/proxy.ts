import {
  requireModelId,
  buildModelsListResponse,
  agentIdForModel,
  CATALOG_UNIFIED_AGENT_ID,
  agentFallbackForModel,
  isModelAllowed,
} from './model.ts'
import { buildCatalogDrivenModelsResponse } from './catalog-models.ts'
import {
  extractAccountBanError,
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
  safeText,
  UpstreamError,
} from './upstream/client.ts'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  filterRequestHeaders,
  filterResponseHeaders,
  newIds,
  readBearer,
  readRequestBody,
  sendJson,
} from './util/http.ts'
import { freebuffAuthHeaders } from './auth-store.ts'
import { patchLogContext } from './util/log.ts'
import { resolveUpstreamChannel } from './config.ts'
import { buildRpcCfg, rpcReuse } from './upstream/official-rpc.ts'
import {
  officialChatHeaders,
  clientEnvironment,
  META_CLIENT_ENV,
  isCliClaim,
  HEADER_INSTANCE_ID,
} from './upstream/official-fingerprint.ts'
import {
  ENFORCED_FOREIGN_SIGNALS,
  detectForeignClient,
} from './upstream/foreign-client-signals.ts'
import { unmapToolCallsInBody } from './upstream/foreign-client-signals.ts'
import { withChatMetadataParity as chatMetadataParity } from './upstream/chat-metadata-parity.ts'
import {
  coerceUser,
  saveAccountUser,
  deleteAccountUser,
} from './auth-store.ts'
import {
  ensureFreebuffSystemMessages,
  ensureFreebuffToolSignature,
  hasClientTools,
  normalizeReasoningFields,
  normalizeOutputBudget,
  stripClientTools,
  stripFreebuffConversationState,
} from './free-mode.ts'
import {
  chooseHermesDelegateAlias,
  createHermesDelegateSseTransform,
  restoreHermesDelegateInResponse,
  rewriteHermesDelegateForUpstream,
} from './tool-alias.ts'
import { logger } from './util/log.ts'
import {
  blockPremiumModels,
  catalogModelKeys,
  customModels,
  handleModels,
  handleStatus,
  hiddenModels,
} from './proxy/routes/catalog.ts'
import { handleAccountsImport, handleAccountsDelete } from './proxy/routes/accounts.ts'
import {
  bodyReadTimeoutMs,
  chatHeaderTimeoutMs,
  effectiveStreamIdleMs,
  schedulingBudgetMs,
  slotWaitMs,
} from './proxy/config/limits.ts'
import { buildForwardBody } from './proxy/transport/forward-body.ts'
import { handleGenericPassthrough } from './proxy/transport/passthrough.ts'
import { parseChatRequest } from './proxy/routes/chat-request.ts'
import { authorize, releaseSessionUnlessPaid } from './proxy/routes/auth.ts'
import { handle as handleRoute } from './proxy/routes/router.ts'
import { forwardCompletions } from './proxy/transport/forward.ts'

/**
 - OpenAI-compatible surface under /v1 only.
 - Freebuff upstream calls are internal (/api/v1/...).
 *
 - @param {object} ctx 依赖集合(config / runtimes / userStore / settingsStore / modelStore)
 - @returns {{ handle: (req: object, res: object) => Promise<void> }} 请求处理器
 */
export function createProxyHandler(ctx: any) {
  const { config, runtimes, userStore, settingsStore } = ctx
  /** 传给已抽出的模块级函数(它们需要 config 等依赖). */
  const ctxValue = { config, runtimes, userStore, settingsStore, modelStore: ctx.modelStore }
  if (!runtimes) {
    throw new Error('createProxyHandler requires ctx.runtimes (AccountRuntimes)')
  }

  /** 前端[模型管理]配置的自定义模型(覆盖内置目录),实时生效. */

  /** 前端[模型管理]删除(隐藏)的模型 id,实时生效. */

  /**
   - 已删除 probeUpstreamSessionCached() 及其 60s 缓存.
   *
   - 它做过两件都错的事:
   - 1. 主动打上游 ---- 白名单校验时 GET /session,与[零自动探测]
   - (docs/reverse/20 §20.3:只有用户主动刷新才准探测)直接冲突;
   - 2. 无调用点 ---- 是死代码,却留着"随时会被重新接上"的隐患.
   *
   - 白名单判定所需的模型 id 现在全部来自本地:目录行(catalogKeys),
   - 内置 catalog,前端自定义,隐藏表.拿不到就是拿不到,如实拒绝,
   - 不为判定而发上游请求.
   */

  /**
   * 路由分发(实现在 ./proxy/routes/router.ts, 见其文件头).
   * @param {object} req 请求
   * @param {object} res 响应
   * @returns {Promise<void>} 处理完成
   */
  async function handle(req: any, res: any) {
    return handleRoute(ctxValue, handleChatCompletions, req, res)
  }

  /** 一键屏蔽收费模型开关(前端[模型管理],实时生效). */

  async function handleChatCompletions(req: any, res: any) {
    // 有界排队:闸门排满时最多等 slotWaitMs,超时以 429 server_busy 拒绝
    // (客户端可重试),绝不无界排队把整个服务静默钉死.
    let releaseSlot
    // 客户端在排队期间断开:立即放弃等待(否则这个"已死"的请求会一直占着
    // 它稍后拿到的槽位,直到走完整个上游流程).
    const slotGone = clientGoneSignal(req)
    try {
      releaseSlot = await slotGone.race(
        acquireRequestSlot(config.limits.maxConcurrentRequests, slotWaitMs(ctxValue)),
      )
    } catch (err: any) {
      // client_gone:连接已没了,安静收场(无法再写响应).
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

  async function handleChatCompletionsInner(req: any, res: any) {
    const parsed = await parseChatRequest(ctxValue, req, res)
    if (!parsed) return
    const { body, requestedModel, upstreamModel, catalogKeys } = parsed

    const stream = Boolean(body.stream)
    /**
     - [首字节之前]的总预算起点:全局槽位/账号锁/上游首字节这些静默等待
     - 全部计入.超预算即快速失败(429 scheduling_timeout),而不是让客户端
     - 对着一个一直转圈的连接等到自己超时(上游前面是 Cloudflare,100s 524).
     */
    const schedulingDeadline = Date.now() + schedulingBudgetMs(ctxValue)
    let attempt = 0
    const maxRetry = config.limits.maxAutoRetryOnSessionError ?? 1
    // 换号重试预算:账号数 +1(封顶 5 次)----多出的一次用于同账号 gate 重试
    // (session 失效等先同号 re-admit 一次,再失败才升级换号),保证一波限流/5xx
    // 时能换到可用账号,试完所有账号才把错误返回给用户.
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
    /** 同一账号连续重试计数:同号重试过一次仍失败 → 升级为换号. */
    let sameAccountRetries = 0
    /**
     - 本次请求已经"满员排队超时"过的账号:粘性调度会优先继续用已用账号
     - (甚至排队等它),若不在选号里排除,超时后会再次选中同一个账号反复等.
     */
    const skipKeys = new Set()
    /**
     - 本次下游请求允许新建的上游会话数(Freebucks 计费单位).
     - 上游按整小时单价预扣,早退按实际占用退还(见 docs/account-scheduling-and-refund.md §3),
     - 旧行为在报错时把[账号数+1]个账号挨个 admit 一遍,一次故障就买断好几条整小时
     - (issue #7).复用已有热 session 不消耗预算.
     *
     - 0 = 不限制(控制台/配置文档/API 校验三处一致的契约),不是"零预算".
     - 曾经这里无条件 Math.max(0, ...),把 0 存成 remaining:0,于是
     - app-context 的预算闸门把每个账号都判成 session_budget_exhausted 跳过,
     - 整个代理固定返回 429 no_available_account----本地自锁,与上游额度无关.
     - 因此 0 必须映射为 null(= 不限额),而不是一个会被用尽的数字.
     - 见 .agents/notes/implemented/bug-fix/2026-09-24-zero-session-budget-means-unlimited.md
     */
    const budgetSetting = settingsStore?.get?.()?.maxNewSessionsPerRequest
    const budgetRaw = Number.isFinite(budgetSetting)
      ? budgetSetting
      : config.limits.maxNewSessionsPerRequest
    const budgetLimit = Number.isFinite(budgetRaw) ? Math.floor(budgetRaw) : 2
    const sessionBudget = {
      // 0(或负数)= 不限额:remaining 为 null 时闸门恒放行,也不递减.
      remaining: budgetLimit > 0 ? budgetLimit : null,
    }
    /** 当前持锁账号 runtime(账号级串行化:一个账号同一时间只处理一个 chat). */
    let heldRt: any = null
    /** 当前持有的账号 chat 锁释放函数. */
    let releaseChat: any = null
    /**
     - 选号阶段占用的[槽位预留]释放函数(见 AccountRuntimes.reserveSlot).
     - spread(并发优先)排序靠它看见"刚被选中,正在拿锁"的请求----否则 N 个并发
     - 请求会同时看到空账号,全部选中同一个号.拿到 chat 锁后立即交还.
     */
    let releaseReserved: any = null
    /**
     - 客户端断开信号(整个请求共用;finally 里 cleanup).账号锁等待是
     - "首字节前静默等待"里最长的一段(热 75s / 冷 120s),客户端早就断了却
     - 还在闷等,且拿到锁后会继续跑完上游流程----死请求钉死账号并发.
     */
    const chatGone = clientGoneSignal(req)
    /** 是否已完整等待过账号锁(account_busy 超时一次后,再等只给短窗,避免 5 次重试 × 长等待). */
    let chatWaited = false
    /**
     - agent 覆盖(本次请求内贯穿重试):startAgentRun 被上游以
     - free_mode_invalid_agent_model 拒绝时回退 base3 孪生(通用模型兜底).
     - 注意:luna 系不经过这里----agentIdForModel 已强制 base3,永不尝试 base2.
     - @type {string | null}
     */
    let agentOverride = null

    /** 释放当前账号的串行化锁与在途标记(换号/请求结束时调用). */
    function dropChatHold() {
      if (releaseChat) {
        releaseChat()
        releaseChat = null
      }
      if (heldRt) {
        heldRt.sessions.endRequest()
        heldRt = null
      }
      // 预留槽位(选号时占用)必须无论如何交还:它是 spread 排序看见
      // "这个账号马上要满了"的唯一依据,泄漏一次就会让账号被误判为满员.
      if (releaseReserved) {
        releaseReserved()
        releaseReserved = null
      }
    }

    /**
     - 账号锁等待时长(仅在所有可用账号都满员时排队才生效;有账号空闲时
     - 选号阶段就已换号,不会走到这里):
     - - 热 session(同模型可直接复用):等一个完整 idle 超时周期.上游卡死也会在
     - streamIdleTimeoutSec 后被掐断释放锁,所以热会话优先排队复用而不是新建 session.
     - - 冷账号/换模型:只等固定窗口,超时即换下一个账号.
     */
    function chatWaitMs(rt: any) {
      // spread 模式:并发优先----账号满员就是"该换号了",只给一个短窗
      // (accountOverflowWaitMs,默认 15s)就溢出到下一个账号,绝不把并发
      // 钉死在一个账号上干等.sticky(默认)保留大等待:宁可排队也不换号,
      // 因为换号 = 新买一条 Freebucks 计费会话.
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
    // account (one account handles at most accountMaxConcurrency chats at a
    // time). The upstream is stateless because clients send the full history.
    // 账号并发上限即"满了换号"的阈值:在途已满的账号排最后,新请求优先去
    // 有空闲槽位的账号;所有账号都满员时才排队(有界等待,超时 account_busy).
    // 故障转移:除了 4xx 客户端错误,任何上游失败(session/run/chat/网络超时)都
    // 冷却当前账号并继续轮询下一个,只有试完所有账号才把错误返回给用户.
    try {
      while (attempt < maxAttempts) {
        attempt++
        try {
          // Single reacquire path: first attempt acquires; retries use gate from previous failure.
          const rt: any =
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
          // 本轮选号占用的槽位预留:换号时必须先交还上一个账号的预留
          // (它已经不在本次请求的候选里了),再接管新账号的预留.
          if (releaseReserved) {
            releaseReserved()
            releaseReserved = null
          }
          releaseReserved =
            typeof rt.releaseReservedSlot === 'function'
              ? rt.releaseReservedSlot
              : null
          if (lastKey && rt.key !== lastKey) {
            // 已经换到不同账号 → 重置同账号重试计数,并释放上一账号的串行化锁
            sameAccountRetries = 0
            dropChatHold()
            // agentOverride 是针对上一账号的 agent 覆盖(free_mode_invalid_agent_model
            // 等按该账号+agent 组合判定).换到新账号后必须清空,让新账号从它自己的
            // 主 agent 重新尝试----否则上一账号被拒的 agent 覆盖会泄漏到新账号上,
            // 使新账号跳过主 agent,直接用孪生/兜底(偏离其应有主 agent).
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
          // 账号选定 → 补进日志上下文:其后这条请求的所有日志都能对上"哪个账号".
          // 多账号池并发时没有它,日志就是一堆无主记录交织,排障只能靠猜.
          patchLogContext({ account: rt.email || rt.key, model: upstreamModel })
          logger.info('account selected', {
            key: rt.key,
            email: rt.email,
            model: upstreamModel,
            wasAgentOverride: !!agentOverride,
          })

          // 账号并发上限:同一账号同时在途流数不超过上限(热会话优先复用,
          // 选号阶段已把满员账号排后;只有所有账号都满员时才排队复用,
          // 超时兜底换号).任何一次获取都必须有界:兜底阶段虽然预算已
          // 耗尽(不会再换号),但若持锁者因网络波动卡死(幽灵连接),无限
          // 等待会让本请求永久挂起,所有后续请求排队超时----必须像前面的
          // acquire 一样设上界,超时把 account_busy 返回给客户端(可重试),
          // 绝不无限等待.
          if (!heldRt) {
            // 已在上一轮完整等待过账号锁(account_busy)→ 本轮只给短窗
            // (账号并发上限即"满了换号"阈值:所有账号都满员时才排队复用热
            // 会话,但排队只等一次完整 idle 周期,之后必须尽快换下一个账号,
            // 而不是在满员账号上反复长等把并发全部钉死).
            // 夹到剩余调度预算:账号锁是本阶段最长的一段(热 75s / 冷 120s),
            // 不能让它单独把整个请求拖过客户端耐心与 Cloudflare 100s 悬崖.
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
            } catch (lockErr: any) {
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
                // 满员排队超时:把该账号从本次请求的候选中排除,下一轮才
                // 真正换到别的账号(否则粘性排序会再次选中它反复等).
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
            // 切换竞态:等待 chat 锁期间可能发生了代理/账号切换(本 runtime
            // 已被顶替,旧 session 正在被优雅释放).此时不能继续用旧 runtime
            // ----它的 session 可能马上被 DELETE,硬用会让请求撞上已失效会话而
            // 卡死.释放锁,无冷却重新选号(新 runtime 走新出口,新 session).
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
            // 在途标记:锁内唯一请求;轮询 GET 会跳过该账号,避免干扰活跃会话.
            heldRt.sessions.beginRequest()
            // 已经拿到真实槽位 ---- 预留完成使命,立刻交还(此后由
            // chatLock.inFlight 承担"这个账号有多满"的事实来源).
            if (releaseReserved) {
              releaseReserved()
              releaseReserved = null
            }
          }

          let result: any
          let runId
          /** 本 run 的 client_id(对齐 trefeon:每个 run 一个 client_id,
           - 整个 run 的所有 chat 调用复用----client_id 绑定 run 生命周期,
           - 绝不在同一 run 的多次 chat 间 fanout(free_mode_run_fanout). */
          let clientId
          {
            // 可观测性:响应头标明本次实际使用的账号.
            res.setHeader('x-freebuff-proxy-account', rt.email)
            res.setHeader('x-freebuff-proxy-account-id', rt.key)

            const snap = rt.sessions.getSnapshot()
            if (!snap.live || !snap.instanceId) {
              throw new UpstreamError(
                'No live freebuff session after admit.',
                { status: 503, code: 'no_session' },
              )
            }

            // agent 选择:主 agent 被上游以 free_mode_invalid_agent_model 拒绝时
            // (上游按用途/推理任务可能只接受特定 agent,且部分 agent 带单次
            // output 限制会截断长思考链),回退 base3 孪生 agent 再试一次.
            // agentOverride:本请求上一次尝试因 free_mode_legacy_luna_agent 失败
            // 后置为 base3 孪生(上游退役旧 agent 时换 session 没用,必须换 agent).
            //  目录协议下的 agent 选择(真机抓包 + 二进制双重证据):
            //
            // 官方 chat 走目录协议时,agent-run 用的是统一的
            // base3-free-catalog,而不是 base2-free-<model>.
            // 二进制原文:
            //   UK = "base3-free-catalog"
            //   Ps$(H){ return WD().row(H)?.key === H ? UK : cCH(H) }
            // 即:当会话模型是目录 key(m-xxx)时 → 用 catalog agent;
            // 否则才按 legacy 规则推导 base2/base3.
            //
            // 抓包实测:官方 START agentId=base3-free-catalog(目录模式下唯一值).
            // 我们此前发 base2-free-deepseek-flash ---- 与官方不一致.
            // 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-agent.md
            const sessionModelId = snap.model
            const isCatalogMode =
              typeof sessionModelId === 'string' &&
              (sessionModelId.startsWith('m-') ||
                sessionModelId.startsWith('fbm1.'))
            //  official 通道:跳过本段 startAgentRun.
            // agent 世代是官方形态的一部分,实现只在副仓库;这里自己发一次
            // 会用 legacy 世代,与副仓库后续 chat 的世代打架.
            // 副仓库的 reuse 会自己做 startRun(desktop 世代)+ chat.
            // 见 docs/reverse/17-current-status-and-gaps.md
            // legacy 已废弃(见 config.resolveUpstreamChannel):一律 official
            const _channel = resolveUpstreamChannel(
              settingsStore?.get?.(),
              config,
              (m, f) => logger.warn(m, f),
            )
            const agentId: any =
              agentOverride ||
              (isCatalogMode
                ? CATALOG_UNIFIED_AGENT_ID
                : agentIdForModel(upstreamModel, customModels(ctxValue)))
            // official 通道仍然发 startAgentRun:
            //   - 保证 runId 始终有值(FINISH 上报,以及 RPC 失败回落 legacy
            //     时都要用);
            //   - 不影响 chat 世代 ---- official 下 chat 由副仓库执行,
            //     它自己会用 desktop 世代再 startRun 一次.
            // 见 docs/reverse/17-current-status-and-gaps.md
            {
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
                // 目录模式下主 agent 是 base3-free-catalog;兜底必须同代,
                // 否则回退成 base2-free 会跨世代(系统消息开场白按 base3 写,
                // agent 却是 base2 → 上游按世代校验必然拒绝).
                // 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-agent.md
                const fbAgentId = isCatalogMode
                  ? CATALOG_UNIFIED_AGENT_ID
                  : agentFallbackForModel(upstreamModel, customModels(ctxValue))
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
            }
            logger.info('started agent run', {
              runId,
              agentId,
              model: upstreamModel,
              key: rt.key,
              email: rt.email,
            })

            const hermesDelegateAlias = chooseHermesDelegateAlias(body.tools)
            const forwardBody = buildForwardBody(ctxValue,
              body,
              upstreamModel,
              snap.instanceId,
              runId,
              agentId,
              clientId,
              hermesDelegateAlias,
              // 服务端指派的 model(会话回执里的 m-xxx / fbm1.xxx).
              // 用错会得到 session_model_mismatch ---- 实测踩过.
              snap.model,
              // 目录持有者:把 m-xxx(目录 key)翻成 fbm1.xxx(句柄)----
              // 官方 chat 的 model 用的就是句柄(真机抓包确认).
              rt.upstream.catalog,
            )
            result = await forwardCompletions(ctxValue, {
              req,
              res,
              forwardBody,
              stream,
              hermesDelegateAlias,
              upstream: rt.upstream,
              // 会话剩余时间:用于把流 idle 超时收敛到会话过期附近,过期即掐
              sessionRemainingMs: snap.remainingMs,
              // chat 必须带会话实例 id,否则上游 428(见 forwardCompletions)
              instanceId: snap.instanceId,
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

          // 幽灵连接(流 idle 超时被掐断):响应头已提交,无法整体重试,但
          // 该账号刚被掐断过一条卡死的链路----上游/网络对该会话不稳定.给账号
          // 一个短暂冷却(stallCooldownSec,默认 30s),让后续新请求优先去别的
          // 账号,避免反复撞上同一条卡死链路;不冷却会导致卡死的账号继续吸收
          // 新流量(用户实测:一个账号 3/3 满了还在持续接收请求).
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
            // 先判定是否换号,再累加同号重试计数(顺序不能反:反了会让
            // 第一次同号重试就被判成"该换号").
            const willSwitch =
              result.switchAccount === true || sameAccountRetries >= 1
            sameAccountRetries = willSwitch ? 0 : sameAccountRetries + 1
            // free_mode_legacy_luna_agent:上游退役旧 Luna agent.agentIdForModel
            // 已对 luna 系强制 base3(见 model.ts),重试换 session 即用新 agent,
            // 不再需要额外的 agentOverride----任何 base2 尝试都不会发生.
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
            // 换号前不再无条件早退 DELETE:那一小时是实付买断的,
            // 而上游早退不退 Freebucks.旧注释说"它已经在冷却,没人会再用它"----
            // 但冷却只有 60 秒,而这一小时还剩几十分钟可用(下一跳还能续用).
            // 只有付费时段已过才真正没有保留价值,那时才释放.
            // 换号前释放:走统一入口(付费时段内会被拒绝 ---- 那一小时是实付的)
            if (willSwitch && lastKey) {
              releaseSessionUnlessPaid(ctxValue, lastKey, 'switch account after gate error')
            }
            continue
          }

          // 最后一次尝试也失败:把当前账号标记冷却(gate 瞬时问题 noCooldown 除外),
          // 避免下一个请求立刻又撞上同一个故障账号.
          //
          // 同时必须把该账号的会话早退 DELETE 掉:请求已经不会再用这条
          // 会话了,留着只会白占上游会话槽位(一个账号同时只有一条 session 且
          // 绑定模型),换模型时会被它挡住.一次 admit 买断一小时,付费时段内
          // 换模型才需要早退腾槽位(那一小时已付款,闲置不额外花钱).
          // 释放失败也不丢句柄(SessionManager
          // 会保留 instanceId 并重试,sessions.json 里还有一份).
          /**
           - 付费时段内绝不释放(2026-10-04 真实事故修正).
           *
           - 旧行为:最后一次尝试失败就 releaseSession(),日志写
           - releasing session to free the slot.但那一小时是实付买断的,
           - 上游早退 DELETE 不退 Freebucks(实测只回 freebucksRefundPending
           - 且观察 2 分钟未到账)---- 于是"请求失败 + 钱白花 + 会话没了",
           - 用户看到的就是[请求完积分变零,还失败了].
           *
           - 更要命的是 428 waiting_room_required:上游原话是
           - "Send your message again to start a new one" ---- 它要的是重发,
           - 不是重买;而我们把会话扔了,重发就真的只能重买.
           *
           - 现在:只要会话仍在已付费时段内(inPaidWindow()),就保留句柄.
           - 闲置不额外花钱,而留着它下一跳还能续用(见 readmitToContinue).
           - 只有付费时段已过才释放腾槽位.
           *
           - 释放失败也不丢句柄(SessionManager 会保留 instanceId 并重试,
           - sessions.json 里还有一份).
           */
          if (lastKey) {
            const st = result.status
            const clientError =
              typeof st === 'number' &&
              st >= 400 &&
              st < 500 &&
              st !== 429 &&
              result.noCooldown !== true
            if (!clientError || result.gateCode === 'stream_idle_timeout') {
              // 统一入口:付费时段内会被拒绝(避免把已买断的一小时扔掉)
              releaseSessionUnlessPaid(ctxValue, lastKey, 'final attempt failed')
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
        } catch (err: any) {
          if (err instanceof UpstreamError) {
            // 终态错误:没有可用账号 / 参数缺失,直接返回.
            const isTerminal =
              err.code === 'no_available_account' ||
              err.code === 'model_required' ||
              err.code === 'upstream_auth_missing' ||
              // 客户端已断开:换号只会再买一条 Freebucks 计费会话给一个
              // 没人接收的响应,必须立刻收场(连接已死,写不出去也不报错).
              err.code === 'client_gone' ||
              // 调度预算已耗尽:预算是整个请求一份,后续每轮都会立即再超,
              // 重试只会白烧 maxAttempts 次循环,直接快速失败让客户端重试.
              err.code === 'scheduling_timeout' ||
              // 本次请求的新会话预算已用尽:同样在整个请求内不会恢复
              // (重新选号也拿不到预算),重试只会白转一轮,直接返回可操作的错误码.
              err.code === 'session_budget_exhausted' ||
              // 出口级故障(地理封锁):换号无用(所有账号共享同一出口),
              // 重试只会再买断一次一整小时的 Freebucks.立即收场.
              // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
              err.fatal === true ||
              /**
               - 全池额度耗尽:遍历完所有账号才得出的聚合结论 ----
               - 换号/同号重试不可能有不同结果.立即收场,不白轮 maxAttempts 轮.
               - (实测:每个客户端请求白轮 3 次 × 每次遍历全部账号,
               - 13 个请求就把 500 条日志缓冲冲爆,用户事后查不到更早记录.)
               */
              err.terminalExhausted === true
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
                // 同号 re-admit 一次;再失败即换号(见下方 sameAccountRetries).
                const willSwitch = sameAccountRetries >= 1
                sameAccountRetries += 1
                pendingGateCode = err.code
                pendingSwitchAccount = willSwitch
                pendingNoCooldown = false
                if (willSwitch && lastKey) {
                  releaseSessionUnlessPaid(ctxValue, lastKey, 'switch account (recoverable error)')
                }
                continue
              }
              // 上游错误(startAgentRun 失败 / no_session / 5xx 等):
              // - 账号级故障(限流/封禁/配额)→ 冷却换号;
              // - 其他(5xx/网络/上游瞬时故障)→ 先在同一账号上重试一次:
              //   复用热 session,不新建计费会话;同号再失败才换号.
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
              if (willSwitch && lastKey) {
                  releaseSessionUnlessPaid(ctxValue, lastKey, 'switch account (session error)')
                }
              continue
            }
            // 最后一次尝试也失败(无重试机会):会话不会再被用,立刻早退
            // DELETE 释放槽位,而不是等空闲释放 / 挂到过期.
            if (lastKey) {
              // 统一入口(付费时段内拒绝释放)
              releaseSessionUnlessPaid(ctxValue, lastKey, 'final upstream error')
            }
            mapAndSendError(res, err)
            return
          }
          // 非 UpstreamError:网络错误 / 上游超时(socket 断开,代理不可达等).
          // 先同号重试一次(热 session 复用,不新建计费会话),再失败才换号;
          // 客户端是否已断开无法可靠区分(req.destroyed 在请求体读完后就为 true),
          // 多试一轮最多浪费一次上游调用.
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
            if (willSwitch && lastKey) {
                  releaseSessionUnlessPaid(ctxValue, lastKey, 'switch account (session error)')
                }
            continue
          }
          logger.error('chat completions failed', {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          })
          // 网络类错误,重试已耗尽:会话不会再被本次请求使用,立刻 DELETE
          // 释放槽位(失败也会保留句柄重试),别让它挂到过期.
          if (lastKey) {
            logger.info('final network error; releasing session to free the slot', {
              key: lastKey,
              model: upstreamModel,
              error: err instanceof Error ? err.message : String(err),
            })
            releaseSessionUnlessPaid(ctxValue, lastKey, 'final upstream error')
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
      // 请求结束(成功/失败/预算耗尽):释放账号串行化锁,恢复该账号轮询;
      // 并摘掉客户端断开监听器(keep-alive 连接复用,不摘会累积监听器).
      dropChatHold()
      chatGone.cleanup()
    }
  }

  /** 读请求体的上限(毫秒).<=0 关闭(不建议). */

  return { handle }
}

/**
 - 搬进 ./proxy/* 的私有实现 ---- 必须逐个 import 进来,因为下面
 - createProxyHandler 内部直接调用它们.
 *
 - 教训(2026-10-05 实测复现的运行时回归):单靠末尾的
 - export { X } from './proxy/y.js' 是不够的 ---- re-export 只影响本模块的
 - 对外导出,不会把 X 带进本模块的作用域.只写 re-export 的话,
 - createProxyHandler 里每个调用点都会抛 ReferenceError: X is not defined,
 - 而 node --check 与 tsc(默认 checkJs:false)都可能放过它.这与本仓历史上
 - 的 mergeOfficialTools: mapped is not defined 是同一形状.
 *
 - 自查纪律:搬走一个函数后 grep -n "<名>" <原文件> ---- 每一处出现必须是
 - import,注释或调用点,且 import 必须存在.
 */
import {
  acquireRequestSlot,
  requestSlotStats,
} from './proxy/transport/stream/slots.ts'

import {
  isToolSchemaRejection,
  parseRetryAfterMsHeader,
  shouldSwitchAccountOnError,
  unmapToolCallsInSse,
  upstreamBodyEmbeddedError,
} from './proxy/transport/errors/errors.ts'

import {
  handleStreamPipeFailure,
  mapAndSendError,
  writeUpstreamError,
} from './proxy/transport/errors/respond.ts'

import {
  apiKeyMatches,
  clientGoneSignal,
  methodHasBody,
  pipeWebStreamToNode,
  reqToAbortSignal,
  sleep,
} from './proxy/transport/stream/stream-pipe.ts'

// 这三个符号在 src/proxy.ts 里的对外导出名必须保持不变(消费方:
// src/server.ts,src/web/api.ts,test/smoke.mjs 含动态 import).
//  upstreamBodyEmbeddedError 在本次搬运前就是 src/proxy.ts 的导出符号,
// 搬进子模块后必须原样再导出,否则是无声的导出面收缩.
export { shouldSwitchAccountOnError } from './proxy/transport/errors/errors.ts'
export { requestSlotStats } from './proxy/transport/stream/slots.ts'
export { upstreamBodyEmbeddedError } from './proxy/transport/errors/errors.ts'
