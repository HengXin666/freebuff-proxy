/**
 * 请求级状态的字段表(纯数据, 无时序逻辑).
 *
 * 字段分两块拼: 请求标识与调度预算(coreChatFields, 请求内只读) / 重试过程中的
 * 可变游标(retryCursors, 每轮都在变).
 *
 * 每请求独立语义见 ./state.ts 的文件头. 本文件不持有任何模块级可变绑定.
 */
import { clientGoneSignal } from '../../transport/stream/stream-pipe.ts'
import { schedulingBudgetMs } from '../../config/limits.ts'

/**
 * 请求标识与调度预算这类"请求内只读"的字段.
 * @param {any} ctx 依赖集合(config / runtimes / settingsStore / modelStore)
 * @param {any} req 下游请求
 * @param {any} parsed parseChatRequest 的结果(body / upstreamModel / catalogKeys)
 * @returns {any} 只读字段对象
 */
function coreChatFields(ctx: any, req: any, parsed: any) {
  const config = ctx.config
  const body = parsed.body
  const upstreamModel = parsed.upstreamModel
  return {
    ctx,
    req,
    config,
    runtimes: ctx.runtimes,
    settingsStore: ctx.settingsStore,
    body,
    upstreamModel,
    catalogKeys: parsed.catalogKeys,
    stream: Boolean(body.stream),
    /**
     - [首字节之前]的总预算起点:全局槽位/账号锁/上游首字节这些静默等待
     - 全部计入.超预算即快速失败(429 scheduling_timeout),不让客户端
     - 对着一个一直转圈的连接等到自己超时.
     */
    schedulingDeadline: Date.now() + schedulingBudgetMs(ctx),
    /**
     - 本次下游请求允许新建的上游会话数(Freebucks 计费单位);
     - 复用已有热 session 不消耗预算.
     *
     - 0 = 不限制(控制台/配置文档/API 校验三处一致的契约). 取值时 0 必须映射为
     - null(= 不限额): 若存成 remaining:0, app-context 的预算闸门会把每个账号
     - 判成 session_budget_exhausted 跳过, 整个代理固定返回 429 no_available_account.
     - 见 .agents/notes/implemented/bug-fix/2026-09-24-zero-session-budget-means-unlimited.md
     */
    sessionBudget: null,
    /**
     - 客户端断开信号(整个请求共用;finally 里 cleanup).账号锁等待是
     - "首字节前静默等待"里最长的一段(热 75s / 冷 120s).
     */
    chatGone: clientGoneSignal(req),
  }
}

/**
 * 重试过程中会变的游标(每轮读写, 详见各处注释).
 * @param {any} ctx 依赖集合(含 config / runtimes)
 * @returns {any} 游标字段对象
 */
function retryCursors(ctx: any) {
  const { config, runtimes } = ctx
  const maxRetry = config.limits.maxAutoRetryOnSessionError ?? 1
  return {
    attempt: 0,
    maxRetry,
    // 换号重试预算:账号数 +1(封顶 5 次)----多出的一次用于同账号 gate 重试
    // (session 失效等先同号 re-admit 一次,再失败才升级换号),保证一波限流/5xx
    // 时能换到可用账号,试完所有账号才把错误返回给用户.
    maxAttempts: Math.max(
      maxRetry + 1,
      Math.min((runtimes.allKeys().length || 1) + 1, 5),
    ),
    /** @type {string | null} */
    lastKey: null,
    /** @type {string | null} */
    pendingGateCode: null,
    /** @type {number | null} */
    pendingRetryAfterMs: null,
    /** @type {boolean} */
    pendingSwitchAccount: false,
    /** @type {boolean} */
    pendingNoCooldown: false,
    /** 同一账号连续重试计数:同号重试过一次仍失败 → 升级为换号. */
    sameAccountRetries: 0,
    /**
     - 本次请求已经"满员排队超时"过的账号:粘性调度会优先继续用已用账号
     - (甚至排队等它),若不在选号里排除,超时后会再次选中同一个账号反复等.
     */
    skipKeys: new Set<any>(),
    /** 当前持锁账号 runtime(账号级串行化:一个账号同一时间只处理一个 chat). */
    rt: null,
    /** 当前持有的账号 chat 锁释放函数. */
    releaseChat: null,
    /**
     - 选号阶段占用的[槽位预留]释放函数(见 AccountRuntimes.reserveSlot).
     - spread(并发优先)排序靠它看见"刚被选中,正在拿锁"的请求.拿到 chat 锁后立即交还.
     */
    releaseReserved: null,
    /** 是否已完整等待过账号锁(account_busy 超时一次后,再等只给短窗,避免 5 次重试 × 长等待). */
    chatWaited: false,
    /**
     - agent 覆盖(本次请求内贯穿重试):startAgentRun 被上游以
     - free_mode_invalid_agent_model 拒绝时回退 base3 孪生(通用模型兜底).
     - 注意:luna 系不经过这里----agentIdForModel 已强制 base3,永不尝试 base2.
     - @type {string | null}
     */
    agentOverride: null,
    /** 本轮 run 的 id / client_id(每轮重置, 见 runUpstreamTurn). */
    runId: undefined,
    clientId: undefined,
    /** 本次请求实际使用的模型(会话回执里的 m-xxx / fbm1.xxx). */
    sessionModel: null,
  }
}

/**
 * 造一份请求级状态(不含 sessionBudget 归一与两个派生方法).
 * @param {any} ctx 依赖集合(config / runtimes / settingsStore / modelStore)
 * @param {any} req 下游请求
 * @param {any} parsed parseChatRequest 的结果(body / upstreamModel / catalogKeys)
 * @returns {any} 字段齐备但 sessionBudget 待填的状态对象
 */
export function buildChatState(ctx: any, req: any, parsed: any) {
  return { ...coreChatFields(ctx, req, parsed), ...retryCursors(ctx) }
}
