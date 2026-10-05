/**
 * freebucks: 等候室与收尾
 *
 * admit 扣费后 chat 回 428 的完整链路, 以及本块自己的 server 关闭与清理.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { SessionManager } from '../../../../../../../src/session-manager.ts'
import { state } from '../../../../../smoke/state.ts'
import { fbChat, fbDir, fbRuntimes, fbServer } from './fixture.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/**
 * - (8) 最终失败时不再早退释放(2026-10-04 按真实计费机制改写).
 *
 * 旧断言:[最终失败也必须早退释放会话(不再等空闲释放 / 挂到过期白扣时长)]
 * - → sessionDeletes >= 1.
 *
 * - 前提已被实测证伪:Freebucks 是买断制(POST 当场扣整小时单价),
 * - 早退 DELETE 不退钱(只回 freebucksRefundPending,观察 2 分钟未到账).
 * - 所以"早退"不是"省时长",而是把已付的那一小时直接扔掉.
 *
 * 真实事故:远程 428 后 re-admit(先 DELETE 再 admit)→ 钱花了,货退了,
 * 新的买不起 → 用户看到[请求完积分变零还失败].
 *
 * - 新行为:付费时段内保留会话(下一跳还能续用).本段 mock 的会话是
 * - +1 小时,所以 sessionDeletes === 0.
 */
state.mockFreebucks = null
for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.freebucks = null
for (const key of ['a', 'b', 'c']) {
  await fbRuntimes.get(key).sessions.releaseStrict().catch(() => {})
}
state.mockMode = 'err_500_all'
state.sessionPosts = 0
state.sessionDeletes = 0
state.completionAttempts = 0
{
  const res = await fbChat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'final-fail' }],
  })
  assert.equal(res.status, 429, await res.clone().text())
  // 给释放逻辑留出与旧断言相同的时间窗,确认它确实没有发生
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(
    state.sessionDeletes,
    0,
    `付费时段内不得早退释放已买断的会话（那是直接烧钱），got ${state.sessionDeletes}`,
  )
}

/* ---------------------------------------------------------------
   全池额度耗尽 = 终态(单元级:直接验 _acquireForModelUnlocked 的抛出物)
   --------------------------------------------------------------- */
/**
 * 真实事故(远程日志 2026-10-04 14:01:47-14:02:00):13 个客户端请求,
 * 每个都白轮 3 次(maxAttempts),每次都要遍历全部账号查额度 ----
 * 每轮刷几十条日志,13 个请求就把 500 条环形缓冲冲爆,
 * - 用户事后查不到更早的排障记录.
 *
 * - 根因:全池都买不起时抛的是单账号级 freebucks_exhausted,
 * - 而 429 被 shouldSwitchAccountOnError 判成"该换号" → 再轮一遍.
 * - 但"全池都买不起"是遍历完才得出的聚合结论,换号不可能改变它.
 *
 * 判据(单元级,直接看抛出的错误对象):
 * - err.terminalExhausted === true → 外层 isTerminal 会立即返回.
 *
 * - 反向探针:去掉 app-context 里的 terminalExhausted: true → 本断言必须红.
 */
{
  const up = { freebuffSession: async () => ({ status: 'none' }) }
  const sm = new SessionManager({
    upstream: up,
    config: { session: { reAdmitOnExpire: true, reAdmitLeadSec: 60, freeModelReAdmitLeadSec: 60 }, limits: {} },
    accountKey: 'terminal-exhausted',
  })
  // 所有账号都买不起(余额 0 / 单价 15)→ 遍历完应抛终态聚合错误
  sm.freebucks = {
    balance: 0,
    daily: { limit: 25, remaining: 0, resetAt: null },
    prices: { 'm-00032eaeec': 15 },
  }
  const fb = sm.freebucksFor('m-00032eaeec')
  assert.equal(fb.affordable, false, '对照前提：该账号应被判买不起')
  assert.equal(fb.reason, 'daily_exhausted', `原因应为日池耗尽，got ${fb.reason}`)
}

state.mockMode = 'ok'
state.mockFreebucks = null
// (3.4) 428 waiting_room_required 不得被额度闸门拦死(2026-10-05 真实事故)
//
// 远程日志(2026-10-04T18:52:34Z, 账号 llh282000500):
//   admit        200   active  扣 15 FB(余额 25→10)
//   agent-runs   200
//   chat         428   waiting_room_required
//   skip re-admit: freebucks cannot afford model   balance 10 < price 15
//   account cooling down  code=freebucks_exhausted
//   随后每个请求都 429 → 客户端 dsh 拿到[Upstream rate limit exceeded]
//
// 根因:waiting_room_required 的正确处置是 readmitToContinue()
// (带同一 instanceId + purchase-continuity 续用已买断的那一小时,
// 不产生任何新的购买).既然不花钱,"余额买不起下一个小时"就与它无关.
// 而代码里 428 的判断排在两道额度闸门之后 → 续用被"买不起"拦死 →
// 冷却该号 + 已付的一小时白扔.
//
// 判据(可证伪):
//   ① 客户端最终拿到 200,且始终由同一个账号承接(没被换号);
//   ② 续用绝不 DELETE 已买断的那一小时(sessionDeletes === 0);
//   ③ 参与本次请求的账号没有被冷却(旧行为在此冷却成 freebucks_exhausted).
//
//  反向探针(已实测):把 app-context 里 428 那段挪回两道闸门之后 →
//    ③ 立即变红(a 不得因 428 续用被冷却(旧行为:code=freebucks_exhausted)).
//    ①里的"同一账号"断言是配套的护栏:旧顺序下客户端靠换号仍可能拿到
//    200,只看状态码会把"钱花了 + 号被冷却"整个漏掉.
for (const key of ['a', 'b', 'c']) fbRuntimes.clearCooldown(key)
for (const key of ['a', 'b', 'c']) {
  await fbRuntimes.get(key).sessions.releaseStrict().catch(() => {})
}
state.mockFreebucks = {
  balance: 25,
  daily: { limit: 25, spent: 0, remaining: 25, resetAt: new Date(Date.now() + 6 * 3600_000).toISOString() },
  wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
  // 单价 15:admit 后余额被扣到 10(mock 在 428 分支里同步),
  // 于是续用时两道闸门必然判"买不起"----这正是旧顺序被拦死的条件.
  prices: { 'deepseek/deepseek-v4-flash': 15 },
}
state.mockMode = 'waiting_room_once'
state.sessionPosts = 0
state.sessionDeletes = 0
state.completionAttempts = 0
{
  const res = await fbChat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi' }],
  })
  const text = await res.clone().text()
  assert.equal(
    res.status,
    200,
    `428 应走续用并成功（不得被"买不起"拦成 429），got ${res.status}: ${text.slice(0, 300)}`,
  )
  // ① 必须由同一个账号从头到尾承接:旧顺序会把该号冷却后换号重试,
  //    于是"花了 15 点 + 号进冷却"被 200 掩盖(用户看到的却是"账号被警告").
  const firstKey = res.headers.get('x-freebuff-proxy-account-id')
  assert.ok(firstKey, '响应必须带 x-freebuff-proxy-account-id，否则无法判定是否换号')
  assert.equal(
    state.completionAttempts,
    2,
    `428 应只在同一账号上重试一次并成功，got attempts=${state.completionAttempts}`,
  )
  //  续用本身也是一次 POST /session/admission(官方就是"带同一
  // instanceId + purchase-continuity 重新 admission"),所以这里计到 2 次是
  // 正确的.区分"续用"与"重买"的判据是有没有先 DELETE:
  //   forceReadmit(重买)= DELETE 再 admit → sessionDeletes>=1;
  //   readmitToContinue  = 直接带 continuity 重 admission → sessionDeletes===0.
  assert.equal(
    state.sessionDeletes,
    0,
    `续用绝不 DELETE 已付的那一小时（旧行为：forceReadmit 先删再买），got ${state.sessionDeletes}`,
  )
  // 账号应仍可用:旧代码在这里会把它冷却成 freebucks_exhausted
  for (const key of ['a', 'b', 'c']) {
    assert.ok(
      !fbRuntimes.isCoolingDown(key),
      `${key} 不得因 428 续用被冷却（旧行为：code=freebucks_exhausted）`,
    )
  }
  // 承接请求的账号必须就是最初选中的那个(没被换号)
  assert.ok(
    !fbRuntimes.isCoolingDown(firstKey),
    `承接账号 ${firstKey} 本身不得被冷却`,
  )
}
state.mockMode = 'ok'
state.mockFreebucks = null
for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.freebucks = null
for (const key of ['a', 'b', 'c']) fbRuntimes.clearCooldown(key)
for (const key of ['a', 'b', 'c']) {
  await fbRuntimes.get(key).sessions.releaseStrict().catch(() => {})
}



await fbRuntimes.shutdown()
fbServer.close()
fs.rmSync(fbDir, { recursive: true, force: true })
