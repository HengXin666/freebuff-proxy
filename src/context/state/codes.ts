/**
 * 账号调度与冷却的判据码表: 集合与时长常量.
 *
 * 这些集合被选号(account-schedule)与错误归档(account-errors)共用, 放在任何一侧都会
 * 让另一侧反向依赖; 单独成文件后两边都只依赖这份码表, 判据不会漂移.
 *
 * 注释规范: 只写这段代码做什么, 标点用 ASCII.
 */

/**
 * 账号级冷却里"被上游拒付/封禁"的那几种 code.
 * 控制台的可用判定与选号调度用同一套 code: banned / rate_limited 等
 * 一旦命中, 账号既不参与调度, 也不该被显示成可用.
 */
export const UNAVAILABLE_COOLDOWN_CODES = new Set([
  'banned',
  'rate_limited',
  'spend_limited',
  'ip_capped',
  'free_mode_rate_limited',
  'premium_slot_taken',
])

/** Errors where trying another logged-in account may succeed. */
export const SWITCHABLE_CODES = new Set([
  'rate_limited',
  'spend_limited',
  'ip_capped',
  'free_mode_rate_limited',
  'premium_slot_taken',
  'model_unavailable',
  'banned',
  'no_session',
  'admit_failed',
])

/**
 * [槽位忙]类错误 -- 处置是跳过该账号, 不冷却(等它空出来即可).
 *
 * purchase_claim_released 不在此集合内: 它的处置是删掉那条作废的 claim, 换全新
 * instanceId, 重试一次(rotated), 由 SessionManager._admitUnlocked 内部完成轮换,
 * 不再向上暴露给调度层当"跳过".
 * 见 .agents/notes/implemented/bug-fix/2026-10-03-model-name-fallback-and-slot-no-cooldown.md
 */
export const SLOT_BUSY_CODES = new Set([
  'purchase_capacity',
  'purchase_in_use',
  'premium_slot_taken',
])

/**
 * 本账号有会话但这一小时内绑在别的模型上(issue #24).
 *
 * 它不是账号故障: 这条会话健康, 已付费, 仍在服务它自己的模型, 只是"此刻不能接
 * 这个模型". 处置与槽位忙同类(跳过, 不冷却).
 *
 * 不冷却: 冷却一个仍在正常服务旧模型的账号等于把可用的额度判死. 上层换下一个
 * 账号即可; 若池内所有账号都命中这个码, 说明这一小时内每个号都各绑一个模型,
 * 应把这条说明返回给用户(见 no_available_account).
 */
export const PAID_WINDOW_BOUND_CODES = new Set(['paid_window_model_mismatch'])

/** Whole-account cooldown (any model). */
export const ACCOUNT_COOLDOWN_CODES = new Set([
  'rate_limited',
  'spend_limited',
  'ip_capped',
  'free_mode_rate_limited',
  'banned',
  'premium_slot_taken',
])

/** 一天的毫秒数(冷却上限的比较基准). */
export const DAY_MS = 24 * 60 * 60 * 1000

/** 默认冷却时长(上游没给 retryAfterMs 时的兜底). */
export const DEFAULT_COOLDOWN_MS = 60_000

/**
 * 接管探测的退避窗口(毫秒).
 *
 * 探到"上游有可接管会话"与"探测失败"都按它延后下一次探测: 池内每个额度不足的
 * 账号在每个请求里各探一次 = N 个账号 x M 个在途请求次串行往返, 那是选号变慢的
 * 直接成因. 窗口只挡重复探测, 不挡首次 ---- "别的部署建的会话"仍会被发现.
 */
export const PAID_UPSTREAM_PROBE_RETRY_MS = 60_000

/** 封禁冷却时长: 封禁是生命周期终点, 记足一天. */
export const BANNED_COOLDOWN_MS = DAY_MS
