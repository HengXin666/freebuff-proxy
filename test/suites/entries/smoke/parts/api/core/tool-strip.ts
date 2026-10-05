/**
 * api: tool-schema 拒后剥离重试
 *
 * 上游按工具 schema 指纹拒绝时去掉 tools 重试一次.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { chat, settingsStore } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'

// 明确开启纯文本回退时,工具拒绝仍允许剥离 tools 重试.
{
  settingsStore.save({ stripToolsOnSchemaRejection: true })
  state.calls = []
  state.completionAttempts = 0
  state.mockMode = 'tool_schema_reject'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'run_code',
          description: 'Execute code.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  })
  assert.equal(res.status, 200, await res.clone().text())
  const j = await res.json()
  assert.equal(j.choices[0].message.content, 'hi')
  // 必须恰好两次 chat 尝试:第一次带 tools 被拒,第二次不带 tools 成功.
  const chatCalls = state.calls.filter((c) => c.url.includes('/chat/completions'))
  assert.equal(chatCalls.length, 2, '应重试恰好一次')
  const first = JSON.parse(chatCalls[0].body)
  const second = JSON.parse(chatCalls[1].body)
  // 第一次带 tools(原工具 + 签名工具 end_turn,签名开关默认开).
  assert.ok(Array.isArray(first.tools), '第一次应带 tools')
  assert.ok(
    first.tools.some((t) => t.function && t.function.name === 'run_code'),
    '第一次应保留客户端原始工具',
  )
  assert.equal(second.tools, undefined, '第二次必须已剥离 tools')
  assert.equal(second.tool_choice, undefined)
  assert.equal(res.headers.get('x-freebuff-proxy-tools-stripped'), '1')
  settingsStore.save({ stripToolsOnSchemaRejection: false })
}

// 不带 tools 的请求遇到同样 404 时不得重试(没有工具可去),原样返回 404.
{
  state.calls = []
  state.completionAttempts = 0
  state.mockMode = 'tool_schema_reject'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, '无 tools 时 mock 不触发拒绝，正常 200')
  assert.equal(state.calls.filter((c) => c.url.includes('/chat/completions')).length, 1)
}
