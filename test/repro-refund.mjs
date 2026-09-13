/**
 * 退款决定性实验：同时测两套账（session units vs Freebucks）。
 *
 * 结论（2026-09-13，**当天内经历一次反转**，见 docs/account-scheduling-and-refund.md §3）：
 *   早退 DELETE 会按实际占用比例退还 **session units**（rateLimitsByModel.recentCount），
 *   **并且同样退还 Freebucks 的未用部分**——回执 `freebucksRefund` 是终态金额，
 *   `freebucksRefundPending` 表示**结算未完成**（要用同一个 instanceId 重放 DELETE 取回执），
 *   **不是"不退"**。
 *
 * ⚠️ 本脚本的默认参数（HOLD_MS=3 分钟、POLL_MS=20 分钟）**不足以区分**"按比例退但结算是 0"
 * 与"结构上不退"——两者在这两个时间点上的预测完全一致，早期版本正是据此得出了错误结论。
 * 要复现"退得回来"，请把 HOLD_MS 调到接近整个会话窗口（如 3300000 ≈ 55 分钟），
 * 让占用足够长、结算窗口真正走完。
 *
 * 这个脚本的协议：
 *   T0 GET 基线 -> T1 POST admit -> T2 admit 后 GET（看预扣）
 *   T0 GET 基线 -> T1 POST admit -> T2 admit 后 GET（看预扣）
 *   -> T3 持有一段时间 -> T4 DELETE -> T5 按官方节奏每 3s 重放 DELETE
 *   -> T6 GET 终态，对比两个计数器。
 *
 * 用法（需要一个真实账号的 authToken；admit 会真实消耗额度）：
 *   TOK=<authToken> node test/repro-refund.mjs
 *
 * 环境变量：
 *   TOK     必填，freebuff authToken（UUID 形式）
 *   MODEL   默认 deepseek/deepseek-v4-flash；建议选单价 <= 账号剩余 balance 的模型，
 *           否则 admit 会 429 rate_limited（freebucksShortfall）
 *   HOLD_MS 持有毫秒，默认 180000（3 分钟）
 *   POLL_MS 单次重放的总预算，默认 1200000（20 分钟）
 */
import { fetch as undiciFetch } from 'undici'

const TOK = process.env.TOK
const MODEL = process.env.MODEL || 'deepseek/deepseek-v4-flash'
const HOLD_MS = Number(process.env.HOLD_MS || 180000)
const POLL_MS = Number(process.env.POLL_MS || 1200000)
const BASE = 'https://codebuff.com/api/v1/freebuff/session'

if (!TOK) {
  console.error('缺少 TOK 环境变量。用法：TOK=<authToken> node test/repro-refund.mjs')
  process.exit(1)
}

const t0 = Date.now()
const el = () => '+' + String(Math.round((Date.now() - t0) / 1000)).padStart(4) + 's'
const log = (...a) => console.log(el() + ' | ' + a.join(' | '))

function headers(method, instanceId) {
  const h = {
    Authorization: 'Bearer ' + TOK,
    'x-codebuff-api-key': TOK,
    'user-agent': 'Bun/1.3.14',
  }
  if (method === 'POST') h['x-freebuff-model'] = MODEL
  if (method === 'DELETE' && instanceId) h['x-freebuff-instance-id'] = instanceId
  return h
}

async function call(method, { instanceId } = {}) {
  const r = await undiciFetch(BASE, {
    method,
    headers: headers(method, instanceId),
    signal: AbortSignal.timeout(30000),
  })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  return { http: r.status, body }
}

const units = (b) => {
  const row = b && b.rateLimitsByModel && b.rateLimitsByModel[MODEL]
  return row ? row.recentCount : null
}
const fbSpent = (b) => (b && b.freebucks && b.freebucks.daily ? b.freebucks.daily.spent : null)
const fbBalance = (b) => (b && b.freebucks ? b.freebucks.balance : null)

// T0: baseline
let g = await call('GET')
const u0 = units(g.body), f0 = fbSpent(g.body), b0 = fbBalance(g.body)
log('T0 baseline      units=' + u0 + '  FBspent=' + f0 + '  FBbalance=' + b0 + '  status=' + (g.body && g.body.status))

// T1: admit
const a = await call('POST')
const inst = a.body && a.body.instanceId
log('T1 admit         http=' + a.http + ' status=' + (a.body && a.body.status) + ' inst=' + String(inst || '').slice(0, 8))
if (!inst) {
  log('admit 失败：' + JSON.stringify(a.body).slice(0, 300))
  log('提示：429 rate_limited + freebucksShortfall 说明余额不足该模型单价；换 MODEL 或换账号。')
  process.exit(2)
}

await new Promise((r) => setTimeout(r, 5000))
g = await call('GET')
const u1 = units(g.body), f1 = fbSpent(g.body), b1 = fbBalance(g.body)
log('T2 in-session    units=' + u1 + '  FBspent=' + f1 + '  FBbalance=' + b1)
log('   >> 预扣: units +' + (u1 - u0).toFixed(4) + '   Freebucks +' + (f1 - f0))

log('T3 hold          ' + HOLD_MS + 'ms = ' + (HOLD_MS / 3600000).toFixed(4) + ' h')
await new Promise((r) => setTimeout(r, HOLD_MS))

// T4/T5: DELETE then replay per official cadence (every 3s)
let d = await call('DELETE', { instanceId: inst })
log('T4 DELETE        http=' + d.http + ' ' + JSON.stringify(d.body))
const deadline = Date.now() + POLL_MS
let replays = 0
while (d.body && d.body.freebucksRefundPending === true && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000))
  replays++
  d = await call('DELETE', { instanceId: inst })
  if (replays <= 3 || replays % 50 === 0) log('T5 replay#' + replays + '   ' + JSON.stringify(d.body))
}

await new Promise((r) => setTimeout(r, 5000))
g = await call('GET')
const u2 = units(g.body), f2 = fbSpent(g.body), b2 = fbBalance(g.body)
log('T6 final         units=' + u2 + '  FBspent=' + f2 + '  FBbalance=' + b2 + '  status=' + (g.body && g.body.status))

const chargedUnits = u1 - u0, retainedUnits = u2 - u0
const chargedFb = f1 - f0, retainedFb = f2 - f0
log('')
log('==================== VERDICT ====================')
log('model=' + MODEL + '  hold=' + (HOLD_MS / 3600000).toFixed(4) + ' h  replays=' + replays)
log('SESSION UNITS : ' + u0 + ' -> ' + u1 + ' -> ' + u2)
log('   charged=' + chargedUnits.toFixed(4) + '  retained=' + retainedUnits.toFixed(4) + '  REFUNDED=' + (chargedUnits - retainedUnits).toFixed(4))
log('FREEBUCKS     : spent ' + f0 + ' -> ' + f1 + ' -> ' + f2 + '   balance ' + b0 + ' -> ' + b1 + ' -> ' + b2)
log('   charged=' + chargedFb + '  retained=' + retainedFb + '  REFUNDED=' + (chargedFb - retainedFb))
log('freebucksRefund field=' + (d.body && d.body.freebucksRefund) + '  pending=' + (d.body && d.body.freebucksRefundPending))
log('')
log(chargedUnits > 0 && retainedUnits < chargedUnits
  ? '=> session units 被退还：符合 §3.1 结论'
  : '=> session units 未退还（注意：占用太短或账号状态不同）')
log(chargedFb > 0 && retainedFb >= chargedFb
  ? '=> Freebucks 未退还：符合 §3.1 结论'
  : '=> Freebucks 出现退还！与 §3.1 结论不符，请记录并更新文档')