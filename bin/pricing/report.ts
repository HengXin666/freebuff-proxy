/**
 - 定价表的组装与打印 -- 从 bin/pricing.ts 的 main 按职责切出.
 *
 */
import { fmtCountdown, fmtDuration, fmtNum, fmtTime } from './format.ts'

/**
 - 把上游 session 回执折算成定价表(含"今日池能买多少时长").
 - @param {any} session 上游 session 回执
 - @returns {{payload: any, rows: any[], counted: string[]}} 结算结果
 */
export function buildPayload(session: any) {
  const fb = session?.freebucks || {}
  /** @type {Record<string, number>} */
  const prices: Record<string, number> = {}
  for (const [id, p] of Object.entries(fb.prices || {})) {
    const n = Number(p)
    if (Number.isFinite(n)) prices[id] = n
  }
  const daily = fb.daily || {}
  const wallet = fb.wallet || {}
  const limit = Number(daily.limit) || 0
  const remaining = Number.isFinite(Number(daily.remaining)) ? Number(daily.remaining) : 0

  const rows = Object.entries(prices)
    .map(([model, price]) => ({
      model,
      price,
      perDayMinutes: price > 0 && limit > 0 ? (limit / price) * 60 : null,
      perBalanceMinutes: price > 0 ? (remaining / price) * 60 : null,
    }))
    .sort((a, b) => b.price - a.price || a.model.localeCompare(b.model))

  // 计次模型(有 rateLimitsByModel 但不在 prices 里):不走 Freebucks,按次/日限流
  const counted = Object.keys(session?.rateLimitsByModel || {}).filter((m) => !(m in prices))

  const payload = {
    balance: Number(fb.balance) || 0,
    daily: { limit, spent: Number(daily.spent) || 0, remaining, resetAt: daily.resetAt ?? null },
    wallet: {
      balance: Number(wallet.balance) || 0,
      monthlyBonus: Number(wallet.monthlyBonus) || 0,
      nextBonusAt: wallet.nextBonusAt ?? null,
    },
    quotaExempt: fb.quotaExempt === true,
    planId: fb.planId ?? null,
    prices,
    perDayMinutes: Object.fromEntries(rows.map((r) => [r.model, r.perDayMinutes])),
    countedModels: counted,
    fetchedAt: new Date().toISOString(),
  }
  return { payload, rows, counted }
}

/**
 - 人类可读的价目表打印.
 - @param {any} payload 结算结果
 - @param {any[]} rows 逐模型行
 - @param {string[]} counted 计次模型
 - @param {{ limit: number, daily: any, session: any }} ctx 上方解析出的上下文
 - @returns {void} 无返回值
 */
export function printHuman(
  payload: any,
  rows: any[],
  counted: string[],
  ctx: any,
): void {
  const { limit, daily, session } = ctx
  console.log('Freebuff 实时定价表（Freebucks）')
  console.log('数据直接取上游 session 响应，非本地写死；本次为只读探测，未消耗额度。')
  console.log()
  console.log(`  计费货币   Freebucks（FB）`)
  console.log(`  今日池     ${fmtNum(limit)} FB（已用 ${fmtNum(payload.daily.spent)}，剩余 ${fmtNum(payload.daily.remaining)}）`)
  console.log(`  重置时间   ${fmtTime(daily.resetAt)} ${fmtCountdown(daily.resetAt)}`)
  console.log(`  可用余额   ${fmtNum(payload.balance)} FB`)
  if (payload.wallet.balance || payload.wallet.monthlyBonus) {
    console.log(`  钱包       ${fmtNum(payload.wallet.balance)} FB（每月赠送 ${fmtNum(payload.wallet.monthlyBonus)}）`)
  }
  if (payload.quotaExempt) console.log('  额度豁免   该账号 quotaExempt（不受上述池限制）')
  console.log()
  console.log('  模型定价（一次 admit = 买断一小时；时段内复用不额外计费）')
  console.log()
  const w = Math.max(28, ...rows.map((r) => r.model.length))
  const head = `${'模型'.padEnd(w)}  ${'FB/小时'.padStart(8)}`
  console.log(`  ${head}  ${'今日池可跑'.padStart(12)}  ${'当前余额可跑'.padStart(12)}`)
  console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(8)}  ${'-'.repeat(12)}  ${'-'.repeat(12)}`)
  for (const r of rows) {
    const label = r.price <= 0 ? '免费' : fmtNum(r.price)
    console.log(
      `  ${r.model.padEnd(w)}  ${label.padStart(8)}`
        + `  ${fmtDuration(r.perDayMinutes).padStart(12)}`
        + `  ${fmtDuration(r.perBalanceMinutes).padStart(12)}`,
    )
  }
  console.log()
  if (counted.length) {
    console.log(`  另有 ${counted.length} 个模型未走 Freebucks，按「次/日」限流（上游 rateLimitsByModel）：`)
    for (const m of counted.sort()) {
      const q = session.rateLimitsByModel[m] || {}
      console.log(`    ${m.padEnd(w)}  ${fmtNum(Number(q.recentCount))}/${fmtNum(Number(q.limit))} 次`)
    }
    console.log()
  }
  const ref =
    rows.find((r) => r.model === 'deepseek/deepseek-v4-flash' && r.price > 0) ||
    [...rows].filter((r) => r.price > 0).sort((a, b) => a.price - b.price)[0]
  if (ref) {
    console.log(
      `  参考：今日池 ${fmtNum(limit)} FB 约等于 ${ref.model} 的 ${fmtDuration(ref.perDayMinutes)}。`,
    )
  }
  console.log('  提示：模型单价与池上限由上游决定、可能随时调整；请以上游实时返回为准。')
}
