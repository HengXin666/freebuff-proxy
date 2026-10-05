/**
 * concurrency: 并发信号量单元测试
 *
 * 容量 / 排队 / 超时 / 动态调大.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import assert from 'node:assert/strict'

// --- 账号并发信号量单元测试:容量,排队,超时,动态调大 ---
{
  const capPool = new AccountRuntimes(loadConfig(), {
    getAccountConcurrency: () => 2,
  })
  const r1 = await capPool.acquireChat('cap-key', 0)
  const r2 = await capPool.acquireChat('cap-key', 0)
  assert.equal(capPool.chatInFlight('cap-key'), 2)
  assert.equal(capPool.isChatBusy('cap-key'), true)
  // 满员时排队,超时 → account_busy
  let timedOut = null
  try {
    await capPool.acquireChat('cap-key', 50)
  } catch (err) {
    timedOut = err
  }
  assert.equal(timedOut?.code, 'account_busy')
  // 释放一个槽位 → 排队者立即获得
  const waiting = capPool.acquireChat('cap-key', 500)
  r2()
  const r3 = await waiting
  assert.equal(capPool.chatInFlight('cap-key'), 2)
  // 动态调大容量 → 队列里再排的人立即获得
  const waiting2 = capPool.acquireChat('cap-key', 500)
  capPool.chatLockFor('cap-key').setCapacity(4)
  const r4 = await waiting2
  assert.equal(capPool.chatInFlight('cap-key'), 3)
  r1(); r3(); r4()
  assert.equal(capPool.chatInFlight('cap-key'), 0)
  // 全部断开重连:重置信号量,在途清零,排队者放行
  const r5 = await capPool.acquireChat('cap-key', 0)
  const waiting3 = capPool.acquireChat('cap-key', 500)
  await capPool.reconnectAll()
  // 旧持有被清除;排队者被放行(已拿到槽位,会在 chat 流程重新 re-admit)
  assert.ok(capPool.chatInFlight('cap-key') <= 1, 'reconnect 后旧持有应被清除')
  const r6 = await waiting3
  r5(); r6()
  assert.equal(capPool.chatInFlight('cap-key'), 0)
  await capPool.shutdown()
}
