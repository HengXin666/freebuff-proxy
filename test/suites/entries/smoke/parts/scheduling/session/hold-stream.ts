/**
 * scheduling: 挂起流与放行
 *
 * hold_once 模式下的长流与 releaseHoldStreams 放行.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { chat } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'

// 客户端断开必须立即释放账号锁(回归:reqToAbortSignal 无条件 abort,
// 否则请求体读完(req.complete=true)后断开会让上游挂到超时,锁占死全部请求)
{
  state.mockMode = 'hold_once'
  state.completionAttempts = 0
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200)
  // 读一个 chunk 后客户端断开(cancel body → 连接关闭)
  const reader = res.body.getReader()
  await reader.read()
  await reader.cancel().catch(() => {})
  // 立即发第二个请求:锁必须已释放并快速 200(无修复会卡到上游超时/无限排队)
  const t0 = Date.now()
  const res2 = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello again' }],
  })
  assert.equal(res2.status, 200, await res2.clone().text())
  assert.ok(
    Date.now() - t0 < 10_000,
    `断开后账号锁应快速释放, took ${Date.now() - t0}ms`,
  )
  await res2.text()
  state.mockMode = 'ok'
}
