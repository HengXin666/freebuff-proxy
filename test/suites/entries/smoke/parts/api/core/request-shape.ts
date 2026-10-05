/**
 * api: 请求形态与工具剥离
 *
 * 客户端请求转发到上游时的 model 形态 / 元数据 / 工具剥离开关.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { chat, settingsStore } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'

// model required
{
  const res = await chat({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(res.status, 400)
  const j = await res.json()
  assert.equal(j.error.code, 'model_required')
}

// happy path non-stream
{
  state.calls = []
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.mockMode = 'ok'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    temperature: 0.2,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  const j = await res.json()
  assert.equal(j.choices[0].message.content, 'hi')
  assert.ok(
    state.calls.some((c) => c.url.includes('/freebuff/session') && c.method === 'POST'),
  )
  assert.ok(state.calls.some((c) => c.url.includes('/chat/completions')))
}


// 工具请求默认保持工具语义:上游拒绝时不得静默返回无工具回答.
{
  state.calls = []
  state.completionAttempts = 0
  state.mockMode = 'tool_schema_reject'
  assert.equal(settingsStore.get().stripToolsOnSchemaRejection, false)
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'run_code', parameters: { type: 'object', properties: {} } } }],
  })
  assert.equal(res.status, 404)
  assert.equal(state.calls.filter((c) => c.url.includes('/chat/completions')).length, 1)
  assert.equal(res.headers.get('x-freebuff-proxy-tools-stripped'), null)
}
