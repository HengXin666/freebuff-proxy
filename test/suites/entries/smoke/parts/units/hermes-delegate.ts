/**
 * unit: Hermes delegate_task 兼容别名
 *
 * issue #17: 客户端用 delegate_task, 上游要真名, 双向改写与还原.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { ensureFreebuffToolSignature } from '../../../../../../src/free-mode.ts'
import {
  chooseHermesDelegateAlias,
  restoreHermesDelegateInResponse,
  rewriteHermesDelegateForUpstream,
  rewriteHermesDelegateSseLine,
} from '../../../../../../src/tool-alias.ts'
import { detectForeignClient } from '../../../../../../src/upstream/foreign-client-signals.ts'
import assert from 'node:assert/strict'

// --- unit: Hermes delegate_task compatibility alias (issue #17) ---
{
  const clientBody = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'delegate_task',
          description: 'delegate work',
          parameters: {
            type: 'object',
            properties: { prompt: { type: 'string' } },
          },
        },
      },
    ],
    tool_choice: {
      type: 'function',
      function: { name: 'delegate_task' },
    },
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'delegate_task', arguments: '{"prompt":"x"}' },
          },
        ],
      },
      { role: 'tool', name: 'delegate_task', tool_call_id: 'call-1', content: 'ok' },
    ],
  }
  const alias = chooseHermesDelegateAlias(clientBody.tools)
  assert.equal(alias, 'spawn_subagent')
  const upstreamBody = rewriteHermesDelegateForUpstream(clientBody, alias)
  assert.equal(upstreamBody.tools[0].function.name, alias)
  assert.equal(upstreamBody.tool_choice.function.name, alias)
  assert.equal(upstreamBody.messages[0].tool_calls[0].function.name, alias)
  assert.equal(upstreamBody.messages[1].name, alias)
  assert.equal(clientBody.tools[0].function.name, 'delegate_task', '不得修改客户端原对象')

  const signedTools = ensureFreebuffToolSignature(upstreamBody.tools, true)
  const verdict = detectForeignClient({ ...upstreamBody, tools: signedTools }, true)
  assert.notEqual(verdict.signal, 'foreign_tool_names')
  assert.deepEqual(verdict.foreignToolNames, [])

  const restored = restoreHermesDelegateInResponse(
    {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: alias, arguments: '{"prompt":"x"}' } },
            ],
          },
          delta: {
            tool_calls: [{ function: { name: alias, arguments: '' } }],
          },
        },
      ],
    },
    alias,
  )
  assert.equal(restored.choices[0].message.tool_calls[0].function.name, 'delegate_task')
  assert.equal(restored.choices[0].delta.tool_calls[0].function.name, 'delegate_task')

  const sse = rewriteHermesDelegateSseLine(
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"spawn_subagent","arguments":""}}]}}]}\n',
    alias,
  )
  assert.match(sse, /"name":"delegate_task"/)

  // 已有同名工具时选择无冲突别名,不能覆盖客户端自己的 spawn_subagent.
  assert.equal(
    chooseHermesDelegateAlias([
      { type: 'function', function: { name: 'delegate_task' } },
      { type: 'function', function: { name: 'spawn_subagent' } },
    ]),
    'spawn_subagent_2',
  )
}
