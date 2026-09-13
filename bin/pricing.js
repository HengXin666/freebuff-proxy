#!/usr/bin/env node
/**
 * 打印上游 Freebuff 的实时计费 / 定价表（Freebucks）。
 *
 * 为什么需要这个命令：**官方没有一份可引用的静态价格表**。上游把定价放在
 * 每次 session 响应的 `freebucks.prices` 里（模型 → N Freebucks/小时），
 * 这是唯一真源；网页版定价页并不公开这份「按模型」的价目。
 * 所以这里直接读上游实时数据，并把「今日池余额能买多少时长」折算出来，
 * 等价于把控制台的额度列搬到命令行。
 *
 * 只读：走 GET /api/v1/freebuff/session（探测），**不创建 session、不消耗额度**。
 *
 * 用法：
 *   npm run pricing                 # 人类可读的价目表
 *   npm run pricing -- --json       # 机器可读（脚本/CI 用）
 *   node bin/pricing.js --config /path/to/config.yaml
 */
import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { buildAppContext } from '../src/app-context.js'
import { configureLogger } from '../src/util/log.js'

function parseConfigPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') return argv[i + 1]
  }
  return undefined
}

/** 把分钟数写成「1 小时 5 分」这类人话；不足 1 分钟显示 <1 分钟。 */
function fmtDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return '—'
  if (minutes === 0) return '0 分钟'
  if (minutes < 1) return '<1 分钟'
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (!h) return `${m} 分钟`
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
}

/** 本地时区的可读时间（上游 resetAt 是 ISO，别让用户自己算时区）。 */
function fmtTime(iso) {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return String(iso)
  const d = new Date(t)
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（本地时区）`
}

function fmtCountdown(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  let s = Math.max(0, Math.floor((t - Date.now()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h} 小时 ${m} 分后重置` : `${m} 分钟后重置`
}

async function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const config = loadConfig(parseConfigPath(argv))
  // --json 时压掉日志，保证 stdout 是纯 JSON，可直接被管道消费
  configureLogger(asJson ? { ...config.logging, level: 'error' } : config.logging)

  let ctx
  try {
    ctx = buildAppContext(config)
  } catch (err) {
    console.error('无法读取账号凭据：', err instanceof Error ? err.message : err)
    console.error('提示：先在 Web 控制台添加账号，或运行 npm run login。')
    process.exitCode = 1
    return
  }

  let session
  try {
    // GET 探测：不创建 session、不占额度（与控制台「检测」同一路径）
    session = await ctx.upstream.freebuffSession('GET')
  } catch (err) {
    console.error('上游探测失败：', err instanceof Error ? err.message : err)
    process.exitCode = 1
    return
  }

  const fb = session?.freebucks
  if (!fb || typeof fb !== 'object') {
    console.error('上游未返回 freebucks 计费信息（账号未登录 / 上游未启用该计费方式）。')
    process.exitCode = 1
    return
  }

  /** @type {Record<string, number>} */
  const prices = {}
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

  // 计次模型（有 rateLimitsByModel 但不在 prices 里）：不走 Freebucks，按次/日限流
  const counted = Object.keys(session?.rateLimitsByModel || {}).filter((m) => !(m in prices))

  const payload = {
    balance: Number(fb.balance) || 0,
    daily: { limit, spent: Number(daily.spent) || 0, remaining, resetAt: daily.resetAt ?? null },
    wallet: { balance: Number(wallet.balance) || 0, monthlyBonus: Number(wallet.monthlyBonus) || 0, nextBonusAt: wallet.nextBonusAt ?? null },
    quotaExempt: fb.quotaExempt === true,
    planId: fb.planId ?? null,
    prices,
    perDayMinutes: Object.fromEntries(rows.map((r) => [r.model, r.perDayMinutes])),
    countedModels: counted,
    fetchedAt: new Date().toISOString(),
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return
  }

  console.log('Freebuff 实时定价表（Freebucks）')
  console.log('数据直接取上游 session 响应，非本地写死；本次为只读探测，未消耗额度。')
  console.log()
  console.log(`  计费货币   Freebucks（FB）`)
  console.log(`  今日池     ${fmtNum(limit)} FB（已用 ${fmtNum(payload.daily.spent)}，剩余 ${fmtNum(remaining)}）`)
  console.log(`  重置时间   ${fmtTime(daily.resetAt)} ${fmtCountdown(daily.resetAt)}`)
  console.log(`  可用余额   ${fmtNum(payload.balance)} FB`)
  if (payload.wallet.balance || payload.wallet.monthlyBonus) {
    console.log(`  钱包       ${fmtNum(payload.wallet.balance)} FB（每月赠送 ${fmtNum(payload.wallet.monthlyBonus)}）`)
  }
  if (payload.quotaExempt) console.log('  额度豁免   该账号 quotaExempt（不受上述池限制）')
  console.log()
  console.log('  模型定价（admit 按整小时单价预扣；提前释放按实际占用退还未用部分）')
  console.log()
  const w = Math.max(28, ...rows.map((r) => r.model.length))
  console.log(`  ${'模型'.padEnd(w)}  ${'FB/小时'.padStart(8)}  ${'今日池可跑'.padStart(12)}  ${'当前余额可跑'.padStart(12)}`)
  console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(8)}  ${'-'.repeat(12)}  ${'-'.repeat(12)}`)
  for (const r of rows) {
    const label = r.price <= 0 ? '免费' : fmtNum(r.price)
    console.log(
      `  ${r.model.padEnd(w)}  ${label.padStart(8)}  ${fmtDuration(r.perDayMinutes).padStart(12)}  ${fmtDuration(r.perBalanceMinutes).padStart(12)}`,
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
  // 参考模型：优先用 README 常见的 deepseek flash，否则取最便宜的有价模型。
  // 刻意不用 /flash/ 之类模糊匹配——它会命中 gemini-3.8-flash 这种最贵的，
  // 报出来的「今日池约等于多久」会是最悲观的值，反而误导读者。
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

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err)
  process.exitCode = 1
})
