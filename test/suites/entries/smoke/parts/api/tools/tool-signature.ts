/**
 * api: 签名工具注入
 *
 * 注入官方签名工具, 让带 tools 的请求不被判成伪装客户端.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { FREEBUFF_SIGNATURE_TOOL_NAMES } from '../../../../../../../src/free-mode.ts'
import { detectForeignClient } from '../../../../../../../src/upstream/foreign-client-signals.ts'
import { state } from '../../../../../smoke/state.ts'
import { chat, settingsStore } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'

// tool signature compatibility: default on, hot-disable without restart
{
  state.calls = []
  state.completionAttempts = 0
  const tools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        parameters: { type: 'object', properties: {} },
      },
    },
  ]
  const enabledRes = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
    tools,
  })
  assert.equal(enabledRes.status, 200, await enabledRes.clone().text())
  const enabledCall = state.calls.find((c) => c.url.includes('/chat/completions'))
  const enabledBody = JSON.parse(enabledCall.body)
  // 转发上游的工具集 = 客户端原工具 + 官方真签名工具(顺序:原工具在前).
  assert.deepEqual(
    enabledBody.tools.map((tool) => tool.function.name),
    ['web_search', ...FREEBUFF_SIGNATURE_TOOL_NAMES],
  )
  // 决定性断言:这整个工具集送进上游判据必须判自己人.
  // 旧实现注入空心 end_turn,上游判 foreign_toolset 并把请求降级到
  // inclusionai/ling-3.0-tiny:free ---- 那正是 issue#15[所有模型空响应]的根因.
  const verdict = detectForeignClient(
    { tools: enabledBody.tools, messages: enabledBody.messages },
    true,
  )
  assert.equal(
    verdict.signal,
    null,
    '转发上游的工具集不得被判为外来：' + verdict.signal,
  )
  assert.deepEqual(verdict.hollowToolNames, [], '不得再出现空心签名工具')
  assert.deepEqual(verdict.foreignToolNames, [], '不得夹带第三方 harness 工具名')

  settingsStore.save({ freeToolSignatureEnabled: false })
  state.calls = []
  state.completionAttempts = 0
  const disabledRes = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
    tools,
  })
  assert.equal(disabledRes.status, 200, await disabledRes.clone().text())
  const disabledCall = state.calls.find((c) => c.url.includes('/chat/completions'))
  const disabledBody = JSON.parse(disabledCall.body)
  assert.deepEqual(
    disabledBody.tools.map((tool) => tool.function.name),
    ['web_search'],
  )
  settingsStore.save({ freeToolSignatureEnabled: true })
}


// stream
{
  state.mockMode = 'ok'
  state.completionAttempts = 0
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)
  assert.match(text, /hi/)
}
