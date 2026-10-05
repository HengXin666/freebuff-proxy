/**
 * smoke 的模块级可变状态 -- 用例树拆分后, 这是这些绑定的唯一真源.
 *
 * 为什么集中在一处: 它们被 604 处引用, 且读写在用例块之间穿插(不是集中在
 * 某个共用 harness). 集中到本模块后每个用例 import state, 引用点从裸变量
 * 变成 state.x, 语义不变且可机械核对.
 *
 * 口径: 纯搬移. 初值与类型注释逐字保留.
 */

const originalFetch = globalThis.fetch
let calls = []
/** @type {'ok' | 'gate_once' | 'rate_limit_a' | 'rate_limit_completion' | 'err_500_a' | 'capacity_once' | 'capacity_all' | 'run_500_a' | 'run_403_a' | 'network_err_a' | 'gate_twice_a' | 'hold_once' | 'legacy_luna_once' | 'luna_base2_retired'} */
let mockMode = 'ok'
let sessionPosts = 0
/**
 * - claim_released 场景用:记录已经作废过的 instanceId.
 * - 同一个 id 第二次出现就放行 ---- 用来验证实现确实换了新 id(而不是原地重试).
 */
const claimReleasedSeen = new Set()
let sessionDeletes = 0
let completionAttempts = 0
/** 历次 startAgentRun 使用的 agentId(agent 兜底/退役验证用). */
let startAgentCalls = []
/** 会话有效期(毫秒):近过期/重连测试用 */
let sessionExpiryMs = 3600_000
/**
 * 模拟上游 Freebucks 计量块(2026-09 改版):设成对象后,每个 session 响应
 * (POST/GET/DELETE)都会带上它;null = 老上游(无计量,不拦截).
 * @type {null | { balance: number, daily?: any, wallet?: any, prices?: Record<string, number>, quotaExempt?: boolean, planId?: string | null }}
 */
let mockFreebucks = null
/**
 * - 真实链路复现:余额 0,但上游会话清单里有一条同模型,未过期的已付费会话
 * - (desktopPurchases[].holderInstanceId,可能是别的部署建的).
 *
 * 置成对象后:
 * - - GET /freebuff/session 回 status: none + 一份买不起的 Freebucks
 * - (balance 0 / 每日池 0/25),listed=true 时另带上面那条会话的清单;
 * - - POST /session/admission 镜像上游槽位语义:不带占用者 id 的 takeover
 * - 一律回 purchase_capacity(槽位被占),带了才移交槽位.
 *
 * - 与 mockFreebucks 分开是刻意的:那个变量会被所有 session 回执
 * (含 POST admission)带上,用它表达"余额 0"会把用例变成"admit 也失败",
 * 测不到[闸门放行 → takeover 复用]这条链路.
 * @type {null | { holderInstanceId: string, model: string, listed: boolean,
 * freebucks: { balance: number, daily: any, prices: Record<string, number> } }}
 */
let mockPaidTakeover = null
/** 每次 DELETE 退还给调用方的 Freebucks(模拟"提前结束退款"). */
let mockRefund = 1.5
/**
 * 上游"结算未完成"标志 (vendor af898dc freebucksRefundPending).true 时 DELETE
 * - 回执只带 pending,不带 freebucksRefund----2026-09 实测提前结束的会话会
 * 持续挂起数分钟.用于验证"挂起 ≠ 退款 0".
 */
let mockRefundPending = false
/** DELETE 收到过的 x-freebuff-instance-id(回归:不带会被上游 400). */
let deleteInstanceIds = []
/** 还需要失败几次 DELETE(验证"失败不丢句柄").0 = 全部成功. */
let deleteFailuresLeft = 0
/** 模拟上游 DELETE 缺 instance id 时返回 400 instance_required. */
let requireDeleteInstance = true
/** hold_once 模式:被挂起的流式响应控制器(等 releaseHoldStreams 放行) */
let holdStreamControllers = []

const ALL = [
  'originalFetch',
  'claimReleasedSeen',
  'requireDeleteInstance',
  'calls',
  'mockMode',
  'sessionPosts',
  'sessionDeletes',
  'completionAttempts',
  'startAgentCalls',
  'sessionExpiryMs',
  'mockFreebucks',
  'mockPaidTakeover',
  'mockRefund',
  'mockRefundPending',
  'deleteInstanceIds',
  'deleteFailuresLeft',
  'holdStreamControllers',
]

/** 共享状态对象(唯一的可变容器). */
export const state = {}
for (const k of ALL) state[k] = undefined
state.originalFetch = originalFetch
state.claimReleasedSeen = claimReleasedSeen
state.requireDeleteInstance = requireDeleteInstance
state.calls = calls
state.mockMode = mockMode
state.sessionPosts = sessionPosts
state.sessionDeletes = sessionDeletes
state.completionAttempts = completionAttempts
state.startAgentCalls = startAgentCalls
state.sessionExpiryMs = sessionExpiryMs
state.mockFreebucks = mockFreebucks
state.mockPaidTakeover = mockPaidTakeover
state.mockRefund = mockRefund
state.mockRefundPending = mockRefundPending
state.deleteInstanceIds = deleteInstanceIds
state.deleteFailuresLeft = deleteFailuresLeft
state.holdStreamControllers = holdStreamControllers

/** 把可变状态恢复到初始值(供需要干净基线的用例). */
export function resetMockState() {
  state.calls = []
  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.sessionDeletes = 0
  state.completionAttempts = 0
  state.startAgentCalls = []
  state.sessionExpiryMs = 3600_000
  state.mockFreebucks = null
  state.mockPaidTakeover = null
  state.mockRefund = 1.5
  state.mockRefundPending = false
  state.deleteInstanceIds = []
  state.deleteFailuresLeft = 0
  state.holdStreamControllers = []
}
