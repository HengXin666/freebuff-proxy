/**
 - 上游判据码  --  把上游回执里的字面量归一到本仓的判据集合.
 *
 * 为什么单独成文件:这里一整柜都是"上游会说什么"的实测结论  --  封禁归一,
 * 限流换号, 会话闸门, 当日配额(hash).每条都带一次真实事故的出处;它们与
 * UpstreamError 的字段定义(见 ./error-class.ts)是两类东西:载体稳定, 判据常改.
 * 放在一起时每加一个上游新码就要重排载体的注释块.
 */

/** 单模型当日会话额度判定结果. */
export interface QuotaVerdict {
  exhausted: boolean
  resetAtMs: number | null
  limit: number | null
  recentCount: number | null
}

/**
 * 哪些 countryBlockReason 是真正的封锁(terminal,账号在此出口下不可用).
 *
 * 官方枚举(common/src/types/freebuff-session.ts FreebuffCountryBlockReason):
 *   country_not_allowed            → 国家不在 allowlist(terminal)
 *   anonymized_or_unknown_country → 位置不可信,无法给 free mode(terminal)
 *   missing_client_ip / unresolved_client_ip / ip_privacy_lookup_failed → 同理
 *   anonymous_network             → 不是封锁:只是被判为 VPN/代理,
 *                                   落进 accessTier: limited(可用,模型集变小)
 *   recent_limited_country        → 不是封锁:账号近期从受限地区用过,
 *                                   限制延续一段时间(可用)
 *
 * 判据来源:common/src/constants/freebuff-countries.ts
 *   "everywhere else, and any VPN, is limited access"
 *
 * @param {string | null | undefined} reason 上游回执里的 countryBlockReason
 * @returns {boolean} true 表示该原因导致账号在此出口不可用
 */
export function isTerminalCountryBlock(reason?: string | null): boolean {
  return (
    reason === 'country_not_allowed' ||
    reason === 'anonymized_or_unknown_country' ||
    reason === 'missing_client_ip' ||
    reason === 'unresolved_client_ip' ||
    reason === 'ip_privacy_lookup_failed'
  )
}

/** 会话闸门码:重发 re-admit 才可能恢复的集合(不是账号故障,不该冷却账号). */
const GATE_CODES = new Set([
  'waiting_room_required',
  'waiting_room_queued',
  'session_superseded',
  'session_model_mismatch',
  'session_expired',
  'free_mode_capacity_deferred',
  // Freebuff retires old Luna conversations after an agent rollout. This is
  // recoverable by replacing the cached session, not by cooling the account.
  'free_mode_legacy_luna_agent',
])

/**
 * chat/completions 返回的账号级限流/配额错误:当前账号被上游限流,
 * 换一个账号重试可能成功(free_mode_rate_limited = 免费模式 30 分钟窗口限流,
 * 例如 "Free mode rate limit exceeded (30 minutes limit). Try again in 1 minute.").
 */
const RATE_LIMIT_CODES = new Set([
  'free_mode_rate_limited',
  'rate_limited',
  'spend_limited',
  'ip_capped',
])

/** 从多种错误形态里抽出字符串 code({error:'x'} / {error:{code}} / {code} / {status}). */
function codeOf(body: any): string | null {
  if (!body || typeof body !== 'object') return null
  const nested =
    body.error && typeof body.error === 'object' && !Array.isArray(body.error)
      ? body.error
      : null
  const code =
    nested?.code ||
    (typeof body.error === 'string' ? body.error : null) ||
    body.code ||
    body.status
  return typeof code === 'string' ? code : null
}

/**
 * 从 chat/completions 错误响应里提取"应换号重试"的限流 code.
 * 兼容多种返回形态:{ error: 'free_mode_rate_limited' } /
 * { error: { code: 'rate_limited' } } / { code: ... } / { status: ... }.
 *
 * @param {any} body 上游错误响应体
 * @param {number} [status] HTTP 状态码(当前判据只看 code,保留参数以稳定签名)
 * @returns {string | null} 命中的限流 code;不命中返回 null
 */
export function extractRateLimitError(body: any, status?: number): string | null {
  const code = codeOf(body)
  if (!code) return null
  if (RATE_LIMIT_CODES.has(code)) return code
  return null
}

/**
 * chat 返回 503 时,判断是不是[该模型当日会话次数用尽].
 *
 * 2026-10-02 实测(全新账号,25/25 Freebucks 满额):完整链路
 * catalog → admission(200 active) → agent-runs(200) 都成功,
 * 唯独 chat 503 The model is temporarily unavailable;
 * 换了三个价格档(0/5/15),多种身份组合,全部 503.
 * 排除法走到最后,真因在 rateLimitsByModel:
 *
 *   m-00032eaeec recent=6 limit=6   ← 打满
 *   m-096e75164d recent=6 limit=6
 *   m-22ff70c712 recent=6 limit=6
 *   resetAt = 2026-10-03T07:00:00.000Z(period: pacific_day)
 *
 * 即:limited 档每模型每天 6 次会话,与 Freebucks 是两本账  --
 * 503 后上游自动退款(balance 恒 25 不变),但次数那本账不退.
 * 所以"额度看起来没少"是假象,而"模型暂时故障"是错误归因:
 * 按模型故障去换模型重试,只会把下一个模型也打满.
 *
 * @param {any} quota session 回执里的 rateLimitsByModel / rateLimit
 * @param {string} [model] 目录 key(m-xxx);不传时只看是否全满
 * @returns {{ exhausted: boolean, resetAtMs: number | null, limit: number | null, recentCount: number | null }}
 *   该模型当日会话次数是否打满及重置时间
 */
export function dailySessionQuota(quota: any, model?: string): QuotaVerdict {
  const empty = { exhausted: false, resetAtMs: null, limit: null, recentCount: null }
  if (!quota || typeof quota !== 'object') return empty
  const byModel = quota.byModel
  const rows = []
  if (byModel && typeof byModel === 'object') {
    if (model && byModel[model]) rows.push(byModel[model])
    else for (const v of Object.values(byModel)) rows.push(v)
  }
  if (quota.rateLimit && typeof quota.rateLimit === 'object') {
    rows.push(quota.rateLimit)
  }
  let limit = null
  let recentCount = null
  let resetAtMs = null
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (typeof row.limit === 'number') {
      limit = limit === null ? row.limit : Math.min(limit, row.limit)
    }
    if (typeof row.recentCount === 'number') {
      recentCount =
        recentCount === null ? row.recentCount : Math.max(recentCount, row.recentCount)
    }
    if (row.resetAt) {
      const ms = Date.parse(row.resetAt)
      if (Number.isFinite(ms)) resetAtMs = resetAtMs === null ? ms : Math.max(resetAtMs, ms)
    }
  }
  if (limit === null || recentCount === null) return empty
  // limit=0 表示免费档下该模型完全没有额度,同样视为不可用
  const exhausted = limit <= 0 || recentCount >= limit
  return { exhausted, resetAtMs, limit, recentCount }
}

/**
 * 上游把"账号生命周期终止"写成多个不同字面量,必须归一成一个 code.
 *
 * 2026-09-18 实测:免费模式对第三方客户端的封禁回的是
 * 403 error=account_suspended, message=Your account has been suspended
 * for accessing Freebuff with a third-party client or proxy. 注意
 * error 是字符串而非对象.不归一,它会以 403 落入"4xx 客户端错误,
 * 不换号"的分支,于是每一个被封的账号都被反复复用,错误原样甩给下游
 * (app-context.markCooldown 也无法记 bannedAt,控制台看不见封禁).
 *
 * 归一理由见
 * .agents/notes/implemented/bug-fix/2026-09-18-tool-schema-rejection-strip.md.
 *
 * @param {any} body 上游错误响应体
 * @param {number} [status] HTTP 状态码(当前判据只看 code,保留参数以稳定签名)
 * @returns {string | null} 归一后的 code(目前统一为 'banned')
 */
export function extractAccountBanError(body: any, status?: number): string | null {
  const code = codeOf(body)
  if (!code) return null
  if (code === 'account_suspended' || code === 'banned' || code === 'country_blocked') {
    return 'banned'
  }
  return null
}

/**
 * 判断错误是否属于"会话闸门"(可用 re-admit 恢复,而非账号故障).
 *
 * @param {any} body 上游错误响应体
 * @param {number} [status] HTTP 状态码(当前判据只看 code,保留参数以稳定签名)
 * @returns {string | null} 命中的闸门 code;不命中返回 null
 */
export function extractGateError(body: any, status?: number): string | null {
  const code = codeOf(body)
  if (!code) return null
  // Status may vary; code is the source of truth.
  if (GATE_CODES.has(code)) return code
  return null
}

/**
 * 该闸门码是否可通过 re-admit(同号或换号)恢复.
 *
 * @param {string | null | undefined} code extractGateError 的返回值
 * @returns {boolean} true 表示值得重发一次
 */
export function isSessionRecoverableGate(code?: string | null): boolean {
  return (
    code === 'waiting_room_required' ||
    code === 'waiting_room_queued' ||
    code === 'session_expired' ||
    code === 'session_model_mismatch' ||
    code === 'session_superseded' ||
    code === 'free_mode_capacity_deferred' ||
    code === 'free_mode_legacy_luna_agent'
  )
}
