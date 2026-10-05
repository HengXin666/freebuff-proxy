/**
 * scheduling: 强制新建会话路径
 *
 * 释放会话后必须真的重走 admit, 不复用内存里的旧句柄.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { releaseHoldStreams } from '../../../harness/helpers.ts'
import { chat, runtimes } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'

// recoverable gate: exactly one re-admit (session POST again), one extra completion
{
  // Force fresh session path by releasing
  await runtimes.get('u1').sessions.release()
  state.calls = []
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.mockMode = 'gate_once'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  const j = await res.json()
  assert.equal(j.choices[0].message.content, 'hi')
  // First admit + one force re-admit on retry (not double)
  assert.equal(state.sessionPosts, 2, `expected 2 session POSTs, got ${state.sessionPosts}`)
  assert.equal(state.completionAttempts, 2)
  state.mockMode = 'ok'
}

// 会话切换(re-admit)不得掐断在途 SSE:旧 session 必须等在途流结束后才释放
{
  const sm = runtimes.get('u1').sessions
  await sm.release()
  state.calls = []
  state.sessionPosts = 0
  state.sessionDeletes = 0
  state.completionAttempts = 0
  state.mockMode = 'hold_once'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200)
  assert.equal(sm.inFlightCount(), 1, 'hold 流应在途')
  assert.equal(state.sessionPosts, 1)
  assert.equal(state.sessionDeletes, 0)

  // 模拟"会话即将过期需要 re-admit":让 isUsableForModel 返回 false 后触发 ensureSession
  sm.session.expiresAt = new Date(Date.now() - 1000).toISOString()
  const ensurePromise = sm.ensureSession('deepseek/deepseek-v4-flash')
  // 等待一小段: ensureSession 应等待在途流结束, 期间不 DELETE 旧 session
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(state.sessionDeletes, 0, 're-admit 不得在流在途时删除旧 session')
  assert.equal(sm.inFlightCount(), 1)

  // 放行旧流 → 在途归零 → ensureSession 才释放旧 session 并 admit 新 session
  releaseHoldStreams()
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)
  await ensurePromise
  assert.equal(state.sessionDeletes, 1, '旧 session 应在流结束后才释放')
  assert.equal(state.sessionPosts, 2, '应 admit 一个新 session')
  state.mockMode = 'ok'
}
