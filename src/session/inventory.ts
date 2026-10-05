/**
 * session 域的纯函数层: 常量, 上游回执解析, 标量工具.
 *
 * 从 session-manager.js 按职责切出. 这里只放无状态函数, 不持有会话状态,
 * 因此可以被 admit / lease / observe 三个子域共同引用而不形成环.
 *
 * 注释规范: 只写为什么, 标点用 ASCII.
 */

/**
 * 账号级故障状态码(回执反映账号处境, 不反映某条会话的生死).
 *
 * 名单与 app-context.js 的 UNAVAILABLE_COOLDOWN_CODES, _terminalSessionError 的
 * statusMap 保持一致: banned / country_blocked 是 403 直通, rate_limited /
 * spend_limited / ip_capped / free_mode_rate_limited 是 429 直通.
 */
export const ACCOUNT_LEVEL_SESSION_STATUSES: Set<string> = new Set([
  'banned',
  'country_blocked',
  'rate_limited',
  'spend_limited',
  'ip_capped',
  'free_mode_rate_limited',
])

/** 待结算退款的重试间隔: 上游算完最终用量才会给回执, 30s 足够且不扰上游. */
export const REFUND_RETRY_INTERVAL_MS = 30_000

/**
 * 待结算退款的追问窗口上限(毫秒). 超窗后句柄仍留在 sessions.json,
 * 交给下次启动扫尾.
 */
export const REFUND_RETRY_MAX_MS = 60 * 60 * 1000

/**
 * 上游 session 回执里账号级的终态状态码(不是"这条会话怎么了", 而是
 * "这个账号怎么了"). 这类回执到达时, 会话现场必须原样保留 -- 它们既不代表
 * 当前会话已结束, 也不携带新的 instanceId, 用它覆盖 session 等于把唯一能
 * 用来 DELETE 退款的句柄丢掉(见 observe/probe.ts 的 refresh).
 * @param {unknown} status 回执里的 status 字段
 * @returns {string | null} 命中则返回规范化后的 code
 */
export function accountLevelSessionStatus(status: unknown): string | null {
  const s = typeof status === 'string' ? status.trim().toLowerCase() : ''
  if (!s) return null
  return ACCOUNT_LEVEL_SESSION_STATUSES.has(s) ? s : null
}

/**
 * Pull daily-session quota out of a Freebuff session payload.
 * Present on admit (POST) and on GET while a slot is live; absent when
 * status is none. Returns null when the payload has no quota info.
 * @param {any} body 上游回执
 * @returns {null | { byModel: Record<string, any>, rateLimit: any, updatedAt: string }}
 */
export function extractQuota(body: any): any {
  if (!body || typeof body !== 'object') return null
  const byModel =
    body.rateLimitsByModel && typeof body.rateLimitsByModel === 'object'
      ? body.rateLimitsByModel
      : null
  if (!byModel && !body.rateLimit) return null
  const single = byModel || {}
  if (body.rateLimit && body.rateLimit.model) {
    single[body.rateLimit.model] = body.rateLimit
  }
  return {
    byModel: single,
    rateLimit: body.rateLimit || null,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Pull the Freebucks meter out of a Freebuff session payload (2026-09 计费改版).
 *
 * 上游把[计费货币]放在每个 session 响应的 freebucks 字段里:
 *   { balance, daily:{limit,spent,remaining,resetAt}, wallet:{...},
 *     prices:{ modelId: price }, quotaExempt, planId, monthly, peak, priceChanges }
 * admit 按整小时单价预扣, 提前 DELETE 不退(2026-09-13 实测), 所以本地必须知道
 * [每个模型多少钱]和[这个账号还买不买得起], 否则会白白 admit 一堆计费会话.
 * 老上游/未登录状态没有该字段 -> 返回 null, 调度退回旧行为(不拦截).
 * @param {any} body 上游回执
 * @returns {any} 归一后的 Freebucks 块; 没有则 null
 */
export function extractFreebucks(body: any): any {
  if (!body || typeof body !== 'object') return null
  const fb = body.freebucks
  if (!fb || typeof fb !== 'object') return null
  const daily = fb.daily && typeof fb.daily === 'object' ? fb.daily : {}
  const wallet = fb.wallet && typeof fb.wallet === 'object' ? fb.wallet : {}
  /** @type {Record<string, number>} */
  const prices: Record<string, number> = {}
  if (fb.prices && typeof fb.prices === 'object') {
    for (const [id, price] of Object.entries(fb.prices)) {
      const n = Number(price)
      if (Number.isFinite(n)) prices[id] = n
    }
  }
  const monthly =
    fb.monthly && typeof fb.monthly === 'object'
      ? {
          limitUsd: num(fb.monthly.limitUsd),
          spentUsd: num(fb.monthly.spentUsd),
          remainingUsd: num(fb.monthly.remainingUsd),
          resetAt: fb.monthly.resetAt ?? null,
        }
      : null
  return {
    balance: num(fb.balance),
    daily: {
      limit: num(daily.limit),
      spent: num(daily.spent),
      remaining: num(daily.remaining),
      resetAt: daily.resetAt ?? null,
    },
    wallet: {
      balance: num(wallet.balance),
      monthlyBonus: num(wallet.monthlyBonus),
      nextBonusAt: wallet.nextBonusAt ?? null,
    },
    prices,
    quotaExempt: fb.quotaExempt === true,
    planId: typeof fb.planId === 'string' ? fb.planId : null,
    monthly,
    peak: fb.peak && typeof fb.peak === 'object' ? fb.peak : null,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 有限数归一(非有限一律 0).
 * @param {any} v 待归一值
 * @returns {number} 有限数或 0
 */
export function num(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 两位小数归整(上游金额口径).
 * @param {number} n 原始数值
 * @returns {number} 保留两位小数的数值
 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 有界等待(毫秒), 定时器 unref 以免阻止进程退出.
 * @param {number} ms 等待毫秒
 * @returns {Promise<void>} 计时结束即 resolve
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}
