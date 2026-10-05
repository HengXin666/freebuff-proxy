/**
 * freebucks: DELETE 与退款语义
 *
 * DELETE 必须带 instance id; 退款挂起不等于退款 0; 上游删不掉时句柄必须保留.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { SessionHandleStore } from '../../../../../../../src/session-handles.ts'
import { state } from '../../../../../smoke/state.ts'
import { releaseHoldStreams, waitFor } from '../../../harness/helpers.ts'
import { fbChat, fbConfig, fbDir, fbRuntimes } from './fixture.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// 上面的故障换号把 3 个账号都冷却了;恢复预算并清掉冷却,别污染后续用例.
for (const key of ['a', 'b', 'c']) fbRuntimes.clearCooldown(key)
fbConfig.limits.maxNewSessionsPerRequest = 2
/**
 * - 同时清掉遗留的热会话(2026-10-04).
 *
 * 前面的用例改成"付费时段内不释放已买断的会话"后,热 session 会留在原地
 * - (新行为的目的就是别扔掉已付的钱).本段要断言 sessionPosts === 1
 * (排队复用同一会话,不新建),复用旧会话就不会再 admit → 计数对不上.
 *
 * 每个用例自足地建立前置状态,不依赖上一个用例"恰好清干净了".
 * - releaseStrict 在这里是合法的:测的是排队/空闲释放语义,
 * - 不是付费时段保护(那条由 (3) 的 sessionDeletes === 0 覆盖).
 */
for (const key of ['a', 'b', 'c']) {
  await fbRuntimes.get(key).sessions.releaseStrict().catch(() => {})
}


// (4) 排队等 chat 锁的请求不得被空闲释放误删会话(选号阶段就 admit,请求
//     还没走到 beginRequest,在途计数为 0----只看在途会误删).
state.mockFreebucks = null
for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.freebucks = null
state.mockMode = 'hold_once'
state.sessionPosts = 0
state.sessionDeletes = 0
state.completionAttempts = 0
{
  const resA = await fbChat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hold' }],
  })
  assert.equal(resA.status, 200, 'held stream should start')
  const heldKey = resA.headers.get('x-freebuff-proxy-account-id')
  const sm = fbRuntimes.get(heldKey).sessions
  assert.equal(sm.inFlightCount(), 1, 'hold 流应在途')
  // B 排在同一条会话的 chat 锁后面(每账号并发 1,粘性调度先排队不换号)
  const pendingB = fbChat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'queued' }],
  })
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(
    state.sessionDeletes,
    0,
    '有请求排队等待该会话时，空闲释放不得删会话',
  )
  releaseHoldStreams()
  await resA.text()
  const resB = await pendingB
  assert.equal(resB.status, 200, await resB.clone().text())
  assert.equal(
    resB.headers.get('x-freebuff-proxy-account-id'),
    heldKey,
    '排队请求应复用同一账号的会话，不得换号',
  )
  assert.equal(state.sessionPosts, 1, '排队请求应复用同一会话，不得新建')
}


// (5) DELETE 失败不得丢弃 instanceId(issue:取消失败 = 会话再也删不掉,
//     一直占着上游会话槽位).失败后句柄保留并退避重试,第二次成功才清空会话.
state.sessionPosts = 0
state.sessionDeletes = 0
state.deleteFailuresLeft = 1
state.mockMode = 'ok'
{
  const key = 'a'
  const sm = fbRuntimes.get(key).sessions
  await sm.ensureSession('deepseek/deepseek-v4-flash')
  assert.ok(sm.getSnapshot().instanceId, 'admit 后应有 instanceId')
  const ok = await sm.release()
  assert.equal(ok, false, '首次 DELETE 失败应返回 false（不谎报成功）')
  assert.equal(sm.getSnapshot().instanceId, sm.session.instanceId, '句柄必须保留')
  assert.equal(sm._releasePending, true, '应标记待重试')
  // 退避重试(第一次 delay=0,立即重试)后应成功并清空
  await waitFor('释放失败后自动重试成功', () => sm.getSnapshot().status === 'none', 3_000)
  assert.equal(sm._releasePending, false, '成功后清除待重试标记')
  assert.equal(sm.getSnapshot().status, 'none', '成功后句柄应清空')
}

// (6) 严格释放([断开全部连接]/[重启服务]用):等到真的删掉才返回 ok.
state.sessionPosts = 0
state.sessionDeletes = 0
state.deleteFailuresLeft = 0
{
  const r = await fbRuntimes.releaseAllStrict()
  assert.equal(r.ok, true, `严格释放应全部成功：${JSON.stringify(r.failed)}`)
  assert.ok(r.released >= 1, '至少释放一条会话')
}
{
  // 上游一直删不掉 → 如实返回失败明细,绝不谎报"已全部断开"
  const sm = fbRuntimes.get('a').sessions
  await sm.ensureSession('deepseek/deepseek-v4-flash')
  state.deleteFailuresLeft = 99
  const r = await fbRuntimes.releaseAllStrict()
  assert.equal(r.ok, false, '删不掉时必须 ok=false')
  assert.ok(r.failed.length >= 1, '必须带上失败明细')
  assert.ok(r.failed[0].instanceId, '失败明细要带 instanceId（供排查/扫尾）')
  assert.ok(sm.getSnapshot().instanceId, '失败后句柄仍保留')
  state.deleteFailuresLeft = 0
  await sm.release()
}

// (7) 会话句柄落盘 sessions.json(重启/换容器后仍能寻址 DELETE 退款):
//     admit 写入,释放清空,遗留句柄进 orphans 由启动扫尾清理.
{
  const idx = path.join(path.dirname(fbDir), 'sessions.json')
  const storeFile = fbRuntimes.handleStore.file
  assert.ok(
    storeFile.startsWith(path.dirname(fbDir)),
    `句柄索引应与凭据目录同级，got ${storeFile}`,
  )
  state.sessionPosts = 0
  state.sessionDeletes = 0
  state.deleteFailuresLeft = 0
  const sm = fbRuntimes.get('b').sessions
  await sm.ensureSession('deepseek/deepseek-v4-flash')
  const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  assert.ok(
    onDisk.sessions.some((s) => s.key === 'b' && s.instanceId),
    'admit 后句柄应落盘',
  )
  // 模拟"进程被杀":内存句柄丢弃,文件里仍有记录 → 下次启动扫尾应删掉它
  const store = new SessionHandleStore(storeFile)
  assert.ok(store.listOrphans().length >= 1, '上次运行遗留的句柄应视为待清理')
  // 账号已删除 / 凭据解析不到时:不得谎报清理成功,句柄要保留在文件里
  const skipped = await store.cleanupOrphans(() => null)
  assert.equal(skipped.cleaned, 0, '解析不到账号时不得谎报已清理')
  assert.ok(skipped.skipped >= 1, '解析不到的句柄应计入 skipped 并保留')
  assert.ok(store.listOrphans().length >= 1, '跳过的句柄必须保留')
  // 用真实 upstream 解析器再跑一次:应清掉所有遗留句柄
  await store.cleanupOrphans((key) => fbRuntimes.byKey.get(key)?.upstream)
  assert.equal(store.listOrphans().length, 0, '启动扫尾后不应残留待清理句柄')
  // ---- 启动扫尾必须是有界的:一个连不通的上游(DNS 黑洞/代理挂起/已被删的
  // 账号)曾让每条 DELETE 各等 30s×3 次重放,服务十几分钟不进监听状态,用户看到
  // 的就是[起不来,删 sessions.json 就好了].预算用完的句柄只许 deferred(留到
  // 下次启动继续),绝不许把启动路径拖住.
  {
    const hangFile = path.join(path.dirname(storeFile), 'sessions-hang.json')
    fs.writeFileSync(hangFile, JSON.stringify({
      version: 1,
      sessions: [],
      orphans: Array.from({ length: 4 }, (_, i) => ({
        key: 'a',
        instanceId: `hang-${i}`,
        model: 'deepseek/deepseek-v4-flash',
      })),
    }))
    const hangStore = new SessionHandleStore(hangFile)
    // 永远拿不到结果的上游:模拟黑洞代理 / 上游不响应
    const blackHole = { freebuffSession: () => new Promise(() => {}) }
    const started = Date.now()
    const res = await Promise.race([
      hangStore.cleanupOrphans(() => blackHole, { budgetMs: 300 }),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
    ])
    const elapsed = Date.now() - started
    assert.notEqual(res, 'timeout', '扫尾必须在预算内返回，绝不能挂住启动路径')
    assert.ok(elapsed < 2_500, `扫尾耗时必须受预算约束，实际 ${elapsed}ms`)
    assert.equal(res.cleaned, 0, '连不上时不得谎报已清理')
    assert.ok(res.failed + res.deferred >= 4, '未清理的句柄必须如实计入 failed/deferred')
    assert.equal(hangStore.listOrphans().length, 4, '预算用完的句柄必须保留（信息不丢）')
  }
  sm.getSnapshot()
  if (sm.hasLiveSlot()) await sm.release()
}


// (7.5) 结算挂起 ≠ 退款 0:上游回 freebucksRefundPending 时必须保留句柄
//       并继续重放,不能在 1.5s 后就把 instanceId 丢掉,把 pending 读成
//       "退款 0".上游在 1.5s/7s/17s/37s/67s 各档位都仍回 pending.
{
  const sm = fbRuntimes.get('b').sessions
  const storeFile = fbRuntimes.handleStore.file
  state.mockMode = 'ok'
  state.mockFreebucks = null
  state.deleteFailuresLeft = 0
  state.sessionDeletes = 0
  state.deleteInstanceIds = []
  // 上游持续挂起:DELETE 只回 pending,不给金额
  state.mockRefundPending = true
  try {
    await sm.ensureSession('deepseek/deepseek-v4-flash')
    const live = sm.getSnapshot()
    assert.ok(live.instanceId, 'admit 后应有 instanceId')
    const instanceId = live.instanceId

    await sm.release()

    // 必须重放(>1 次)
    assert.ok(
      state.sessionDeletes >= 2,
      '挂起时必须继续重放 DELETE，实际只发了 ' + state.sessionDeletes + ' 次',
    )
    // 重放必须始终带同一个 instanceId(丢了就再也删不掉这条会话)
    for (const id of state.deleteInstanceIds) {
      assert.equal(id, instanceId, '重放必须带同一个 instanceId')
    }
    // 关键回归:句柄绝不能丢----丢了这笔预扣就永远要不回来
    const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    const kept =
      onDisk.orphans.some((o) => o.instanceId === instanceId) ||
      onDisk.sessions.some((x) => x.instanceId === instanceId)
    assert.ok(kept, '结算挂起时 instanceId 必须保留在句柄存储里')
    // 绝不能把 pending 记成"退款 0"
    const snap = sm.getSnapshot()
    assert.notEqual(
      snap.lastRefund?.refund,
      0,
      'pending 不得被读成退款 0（那是把没结算完错读成退了 0 元）',
    )

    // ---- 摘除走的是启动扫尾 cleanupOrphans(此刻已无 live session,
    //    release() 不会再发 DELETE).先验证仍挂起时扫尾也不摘:
    const swept = await fbRuntimes.handleStore.cleanupOrphans(
      (key) => fbRuntimes.byKey.get(key)?.upstream,
    )
    assert.equal(swept.cleaned, 0, '仍挂起时扫尾不得宣称已清理')
    assert.ok(swept.failed >= 1, '仍挂起时应计入 failed 并保留句柄')
    const mid = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    assert.ok(
      mid.orphans.some((o) => o.instanceId === instanceId),
      '仍挂起时扫尾后句柄必须还在',
    )

    // 现在让上游结算完成(终态,无金额 = 退款 0),扫尾应真正摘掉句柄
    state.mockRefundPending = false
    const swept2 = await fbRuntimes.handleStore.cleanupOrphans(
      (key) => fbRuntimes.byKey.get(key)?.upstream,
    )
    assert.equal(swept2.cleaned, 1, '结算到终态后扫尾应清理掉这条句柄')
    const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    const stillThere =
      after.orphans.some((o) => o.instanceId === instanceId) ||
      after.sessions.some((x) => x.instanceId === instanceId)
    assert.ok(
      !stillThere,
      '拿到终态回执后句柄必须清掉（否则重启扫尾会无限重放）',
    )
  } finally {
    state.mockRefundPending = false
    if (sm.hasLiveSlot()) await sm.release()
  }
}
