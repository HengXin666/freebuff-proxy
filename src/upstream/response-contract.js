/**
 * 上游响应契约(字段名与错误码)的单一真源 ---- 建在既有的
 * upstream-contract.js(端点+头名)同一条线上,把"上游会说什么"也收口.
 *
 *  为什么必须有这个文件(2026-10-05 取证):
 *
 * 用户的原话是[上游变更 API 时,我们还能轻而易举地基于逆向拿到新接口,
 * 并快速填充,且其他接口都有契约,不会牵一发动全身].
 *
 * 实测散落度(grep -rl 计数):
 *   rateLimitsByModel 15 个文件 / recentCount 11 个 / purchase_capacity 7 个 /
 *   freebucksRefundPending 7 个 / waiting_room_required 6 个 /
 *   desktopPurchases 5 个 / holderInstanceId 4 个.
 *
 * 也就是说:上游把 rateLimitsByModel 改个名,要在 15 个文件里改 15 处,
 * 而其中任何一处漏改都不会让类型检查或测试变红(字段读取失败通常表现为
 * undefined → 走兜底分支 → 静默降级).这正是"牵一发动全身"的病灶.
 *
 * 头名/端点已经有 check-upstream-contract.mjs 在看;本文件把响应字段与
 * 判据码补上同一套机制:所有直接读上游回执字段的地方从这里取常量,
 * check-contract-surface.mjs 拦住新写的裸字面量.
 *
 * ## 上游变更后的固定处置(与端点同构)
 *
 *
 * 重抓包 → 更新本文件的字段常量(一处)→ npm run check:contract-surface 转绿
 *
 *
 * @see docs/reverse/upstream-contract.json  抓包生成的客户端真值
 * @see .agents/notes/implemented/architecture/2026-10-03-upstream-contract-single-source.md
 */

// ── 额度与计费(两本账:units 与 Freebucks) ─────────────────────────────
export const F_RATE_LIMITS_BY_MODEL = 'rateLimitsByModel'
export const F_RECENT_COUNT = 'recentCount'
export const F_RESET_AT = 'resetAt'
export const F_FREEBUCKS = 'freebucks'
export const F_FREEBUCKS_SHORTFALL = 'freebucksShortfall'
export const F_FREEBUCKS_REFUND = 'freebucksRefund'
export const F_FREEBUCKS_REFUND_PENDING = 'freebucksRefundPending'

// ── 会话与购买 ──────────────────────────────────────────────────────────
export const F_DESKTOP_PURCHASES = 'desktopPurchases'
export const F_HOLDER_INSTANCE_ID = 'holderInstanceId'
export const F_PURCHASE_CLAIM = 'purchaseClaim'
export const F_SESSION_ID = 'sessionId'
export const F_INSTANCE_ID = 'instanceId'

// ── 会话槽位与准入 ──────────────────────────────────────────────────────
export const F_SESSION_ACTIVE = 'freebuff session active'

// ── 上游判据码(出现即决定"换号 / 冷却 / 重试"的分支走向) ──────────────
export const C_RATE_LIMITED = 'rate_limited'
export const C_SPEND_LIMITED = 'spend_limited'
export const C_IP_CAPPED = 'ip_capped'
export const C_BANNED = 'banned'
export const C_MODEL_UNAVAILABLE = 'model_unavailable'
export const C_PURCHASE_CAPACITY = 'purchase_capacity'
export const C_PURCHASE_IN_USE = 'purchase_in_use'
export const C_PURCHASE_CLAIM_RELEASED = 'purchase_claim_released'
export const C_PREMIUM_SLOT_TAKEN = 'premium_slot_taken'
export const C_FREE_MODE_CAPACITY_DEFERRED = 'free_mode_capacity_deferred'
export const C_WAITING_ROOM_REQUIRED = 'waiting_room_required'
export const C_SESSION_EXPIRED = 'session_expired'
export const C_SUPERSEDED = 'superseded'

/** 全部上游判据码(门禁据此判断"新码必须先登记"). */
export const REQUIRED_CODES = [
  C_RATE_LIMITED,
  C_SPEND_LIMITED,
  C_IP_CAPPED,
  C_BANNED,
  C_MODEL_UNAVAILABLE,
  C_PURCHASE_CAPACITY,
  C_PURCHASE_IN_USE,
  C_PURCHASE_CLAIM_RELEASED,
  C_PREMIUM_SLOT_TAKEN,
  C_FREE_MODE_CAPACITY_DEFERRED,
  C_WAITING_ROOM_REQUIRED,
  C_SESSION_EXPIRED,
  C_SUPERSEDED,
]

/** 全部上游响应字段名(门禁据此判断"新字段必须先登记"). */
export const REQUIRED_FIELDS = [
  F_RATE_LIMITS_BY_MODEL,
  F_RECENT_COUNT,
  F_RESET_AT,
  F_FREEBUCKS,
  F_FREEBUCKS_SHORTFALL,
  F_FREEBUCKS_REFUND,
  F_FREEBUCKS_REFUND_PENDING,
  F_DESKTOP_PURCHASES,
  F_HOLDER_INSTANCE_ID,
  F_PURCHASE_CLAIM,
  F_SESSION_ID,
  F_INSTANCE_ID,
]

/** 字段读取前缀:与头名一样按前缀识别"这是上游回执字段". */
export const FIELD_NAME_PREFIXES = ['freebucks', 'purchase', 'rateLimits', 'desktop', 'holder', 'instance', 'session']
