/**
 * freebucks: 付费时段内不释放
 *
 * 一次 admit 买断一小时, 这一小时内继续用边际成本为 0; 空闲超阈值也不得释放, 要等付费时段结束.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { waitFor } from '../../../harness/helpers.ts'
import { fbChat, fbRuntimes, freebucks25, futureReset } from '../refund/fixture.ts'
import assert from 'node:assert/strict'

// (1) 已付费时段内不释放(2026-09-14 一手实测后改):
//     上游一次 admit 就是买断一小时,POST 当场扣满整小时单价,回执带 expiresAt.
//     这一小时内继续用边际成本为 0,而 DELETE 后那一小时作废,重开要重买.
//     所以空闲超过 idleReleaseSec 也不得释放;要等付费时段结束.
state.mockMode = 'ok'
state.mockFreebucks = freebucks25
state.sessionPosts = 0
state.sessionDeletes = 0
state.deleteInstanceIds = []
state.completionAttempts = 0
{
  const res = await fbChat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(state.sessionPosts, 1, 'first request admits one session')
  const sm = fbRuntimes.get('a').sessions
  // 拿到 freebucks 计量块(余额 / 单价 / 重置时间)
  const snap0 = sm.getSnapshot()
  assert.equal(snap0.freebucks?.balance, 25, 'freebucks balance parsed')
  assert.equal(snap0.freebucks?.prices?.['deepseek/deepseek-v4-flash'], 2, 'price parsed')
  assert.equal(sm.freebucksFor('deepseek/deepseek-v4-flash').affordable, true)

  // 付费时段判定本身
  assert.equal(sm.inPaidWindow(), true, '刚 admit（expiresAt=+1h）应判为在付费时段内')
  // (REUSE-COUNT) [我们在省钱]必须可被前端量化:一次 admit = 买断一小时,
  // 之后的每次复用都是零边际成本.计数器要如实反映 admit/reuse.
  assert.equal(sm.admitCount, 1, '首次请求应记为买过 1 条会话')
  assert.equal(sm.reuseCount, 0, '此时还没有复用')
  {
    const again = await fbChat({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'reuse-me' }],
    })
    assert.equal(again.status, 200, await again.clone().text())
    assert.equal(state.sessionPosts, 1, '复用不得再 admit（那一小时已买断）')
    assert.equal(sm.admitCount, 1, '复用不应增加 admitCount')
    assert.equal(sm.reuseCount, 1, '同一小时内第二次请求应记为 1 次复用')
    const row = fbRuntimes.list().find((x) => x.key === 'a')
    assert.equal(row.admitCount, 1, '账号列表必须暴露 admitCount（前端显示"买过几条"）')
    assert.equal(row.reuseCount, 1, '账号列表必须暴露 reuseCount（前端显示"复用几次"）')
  }
  assert.ok(
    sm.paidWindowRemainingMs() > 0,
    '付费时段剩余应 > 0',
  )
  // 快照把 expiresAt 一路带到前端
  assert.ok(snap0.expiresAt, '快照应带 expiresAt（付费时段依据）')

  // 空闲时长远超 idleReleaseSec(150ms),但付费时段内必须一条都不删.
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(state.sessionDeletes, 0, '付费时段内空闲不得释放（那一小时已买断）')
  assert.equal(sm.getSnapshot().status, 'active', '付费时段内会话应保持 active')

  // 付费时段结束后(把 expiresAt 拨到过去)→ 空闲释放恢复生效
  sm.session.expiresAt = new Date(Date.now() - 1000).toISOString()
  sm.session.remainingMs = 0
  assert.equal(sm.inPaidWindow(), false, '过期后不应再判为在付费时段内')
  sm._armIdleRelease()
  await waitFor('付费时段结束后空闲释放触发 DELETE', () => state.sessionDeletes >= 1, 4_000)
  assert.equal(state.deleteInstanceIds[0], 'inst-1', 'DELETE 必须带 x-freebuff-instance-id')
  const snap = sm.getSnapshot()
  assert.equal(snap.status, 'none', '空闲释放后会话应已结束')
  assert.equal(snap.lastRefund?.refund, state.mockRefund, '退款回执应记录')
  // 账号列表把 Freebucks 暴露给控制台
  const row = fbRuntimes.list().find((x) => x.key === 'a')
  assert.equal(row.freebucks?.balance, 25, '账号列表应带 freebucks')

  // (1.5) 退款流水必须落盘:只有 lastRefund 一个内存字段时,"退款是不是失败
  //       了 / 金额对不对"根本无法审计(重启就丢).流水要同时给出
  //       refund(上游实退)与 expected(按实际占用应付),差额才可对账.
  fbRuntimes.accountState.flush()
  const rlog = fbRuntimes.accountState.refunds('a')
  assert.ok(rlog.length >= 1, '退款流水应至少有一条')
  assert.equal(rlog[0].refund, state.mockRefund, '流水应记上游实退金额')
  assert.equal(rlog[0].instanceId, 'inst-1', '流水应记 instanceId')
  assert.equal(rlog[0].model, 'deepseek/deepseek-v4-flash')
  assert.equal(rlog[0].price, 2, '流水应记当时单价，便于换算 expected')
  assert.ok(
    typeof rlog[0].holdMs === 'number' && rlog[0].holdMs >= 0,
    '流水应记实际占用时长',
  )
  assert.ok(
    typeof rlog[0].expected === 'number',
    `流水应给出应付金额（对账用），got ${JSON.stringify(rlog[0])}`,
  )
  assert.equal(
    fbRuntimes.list().find((x) => x.key === 'a').refundTotal,
    state.mockRefund,
    '累计退款应出现在账号列表里',
  )
  // 账号生命周期字段必须能到前端(分区功能的数据来源)
  const listRow = fbRuntimes.list().find((x) => x.key === 'a')
  assert.ok(listRow.firstSeenAt, '列表应带 firstSeenAt（账号加入时间）')
  assert.ok(
    !Number.isNaN(Date.parse(listRow.firstSeenAt)),
    'firstSeenAt 应是可解析的时间',
  )
  assert.ok(
    Array.isArray(listRow.refunds) && listRow.refunds.length >= 1,
    '列表应带退款流水',
  )
  // 注：/api/accounts 是 { object, data: runtimes.list() } 的直通（web
  // 会话鉴权，本块未搭该设施），所以上面 list() 的断言就等于端点契约。
}

// (2) 余额买不起该模型 → 不 admit(不发 POST),直接跳过该账号.
state.mockFreebucks = {
  ...freebucks25,
  balance: 0.5,
  daily: { limit: 25, spent: 24.5, remaining: 0.5, resetAt: futureReset },
}
state.sessionPosts = 0
state.sessionDeletes = 0
state.completionAttempts = 0
{
  // 粘性调度:warm 请求全部落在同一个账号(a)上,它的 freebucks 会更新成
  // "只剩 0.5".b/c 从未被使用过,压根不该被碰到.
  for (let i = 0; i < 2; i++) {
    const warm = await fbChat({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: `warm-${i}` }],
    })
    assert.equal(warm.status, 200, await warm.clone().text())
    assert.equal(warm.headers.get('x-freebuff-proxy-account'), 'a@example.com')
  }
  assert.equal(fbRuntimes.list().find((x) => x.key === 'b').used, false, 'b 不应被使用')
  // 把三个号都标成"余额只剩 0.5"(等价于它们各自的 session 响应都回写过计量块)
  for (const key of ['a', 'b', 'c']) {
    const sm = fbRuntimes.get(key).sessions
    sm.freebucks = {
      balance: 0.5,
      daily: { limit: 25, spent: 24.5, remaining: 0.5, resetAt: futureReset },
      wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
      prices: { 'deepseek/deepseek-v4-flash': 2 },
      quotaExempt: false,
      planId: null,
      monthly: null,
      peak: null,
      updatedAt: new Date().toISOString(),
    }
    await sm.release()
    assert.equal(
      sm.freebucksFor('deepseek/deepseek-v4-flash').affordable,
      false,
      `${key} 余额 0.5 < 单价 2 应判为买不起`,
    )
  }
  const postsBefore = state.sessionPosts
  const res = await fbChat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 429, await res.clone().text())
  const j = await res.json()
  // 全部账号都是"余额买不起"→ 独立错误码,与"没号/都在冷却"区分开
  // (前者等每日池刷新即可,后者要加号),控制台/调用方才分得清处境.
  assert.equal(
    j.error.code,
    'freebucks_exhausted',
    `全账号余额不足应报 freebucks_exhausted，got ${JSON.stringify(j.error)}`,
  )
  assert.ok(
    (j.error.details?.failures || []).length >= 3 &&
      (j.error.details?.failures || []).every(
        (f) => f.code === 'freebucks_exhausted',
      ),
    `每个账号都应记为 freebucks_exhausted，got ${JSON.stringify(j.error.details)}`,
  )
  // 真实端到端:对外响应不得出现任何账号标识.
  // 这是 429 会原样转发给下游 Agent 客户端的载荷,带 email = 泄露整个账号池.
  const dumped = JSON.stringify(j)
  for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
    assert.ok(
      !dumped.includes(email),
      `错误响应泄露了账号邮箱 ${email}：${dumped.slice(0, 300)}`,
    )
  }
  for (const f of j.error.details?.failures || []) {
    assert.ok(!('email' in f), `failures 条目不得含 email，got ${JSON.stringify(f)}`)
    assert.ok(!('key' in f), `failures 条目不得含 key，got ${JSON.stringify(f)}`)
    assert.ok(!('message' in f), `failures 条目不得含 message，got ${JSON.stringify(f)}`)
  }
  // 聚合字段仍在(调用方据此判断"为什么全挂了")
  assert.ok(j.error.details?.reasons, '应给 reasons 聚合')
  assert.equal(typeof j.error.details?.tried, 'number', '应给 tried 计数')
  assert.equal(
    state.sessionPosts,
    postsBefore,
    '余额不足不得再 admit 新会话（admit 一次即买断整小时）',
  )
}
