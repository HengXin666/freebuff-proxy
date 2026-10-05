/**
 * 账号调度与冷却的判据码表: 集合与时长常量.
 *
 * 从 app-context.js 按职责切出. 为什么需要一个独立文件: 这些集合被
 * 选号(account-schedule) 与错误归档(account-errors) 共用, 放在任何一侧都会
 * 让另一侧反向依赖; 单独成文件后两边都只依赖这份码表, 判据不会漂移.
 *
 * 注释规范: 只写为什么, 标点用 ASCII.
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
 * purchase_claim_released 已从这里移出(2026-10-04).
 *
 * 它此前被当成"槽位忙, 等一等就好", 于是永远卡在同一个已作废的 instanceId 上:
 * 实测连续三个模型全部返回该码(其中单价 0 的模型也失败 -- 证明卡的不是钱),
 * 直到 expiresAt 到期才"恢复".
 *
 * 官方真值(orchestrator.js:208166-208176): 这个码的处置是删掉那条作废的
 * claim, 换全新 instanceId, 重试一次(rotated). 现在由
 * SessionManager._admitUnlocked 内部完成轮换, 不再向上暴露给调度层当"跳过".
 */
export const SLOT_BUSY_CODES = new Set([
  'purchase_capacity',
  'purchase_in_use',
  'premium_slot_taken',
])

/**
 * 本账号有会话但这一小时内绑在别的模型上(issue #24).
 *
 * 它不是账号故障: 这条会话健康, 已付费, 仍在服务它自己的模型. 只是"此刻
 * 不能接这个模型". 处置与槽位忙同类(跳过, 不冷却), 但原因不同 --
 * 槽位忙是"等一等就空出来", 这个是"这一小时内都腾不出来".
 *
 * 必须不冷却: 冷却一个仍在正常服务旧模型的账号, 等于把可用的额度判死.
 * 上层换下一个账号即可; 若池内所有账号都命中这个码, 说明这一小时内每个号
 * 都各绑一个模型, 此时应如实把原因返回给用户(见 no_available_account).
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

/** 封禁冷却时长: 封禁是生命周期终点, 记足一天以免反复撞同一把锁. */
export const BANNED_COOLDOWN_MS = DAY_MS
