/**
 * unit: free-mode 辅助
 *
 * 系统开场注入 / 推理档位 / 输出预算抬升 / 签名工具注入的真实性.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import {
  FREEBUFF_SIGNATURE_TOOL_DEFINITIONS,
  FREEBUFF_SIGNATURE_TOOL_NAME,
  FREEBUFF_SIGNATURE_TOOL_NAMES,
  FREEBUFF_SYSTEM_OPENING,
  ensureFreebuffSystemMessages,
  ensureFreebuffToolSignature,
  normalizeOutputBudget,
  normalizeReasoningFields,
} from '../../../../../../src/free-mode.ts'
import { isGenuineSignatureTool } from '../../../../../../src/upstream/foreign-client-signals.ts'
import assert from 'node:assert/strict'

// --- unit: free-mode helpers ---
{
  const msgs = ensureFreebuffSystemMessages([
    { role: 'user', content: 'hi' },
  ])
  assert.equal(msgs[0].role, 'system')
  assert.ok(msgs[0].content.startsWith(FREEBUFF_SYSTEM_OPENING))

  const already = ensureFreebuffSystemMessages([
    { role: 'system', content: `${FREEBUFF_SYSTEM_OPENING}\nextra` },
    { role: 'user', content: 'x' },
  ])
  assert.equal(already[0].content, `${FREEBUFF_SYSTEM_OPENING}\nextra`)

  const prefixed = ensureFreebuffSystemMessages([
    { role: 'system', content: 'Be brief.' },
  ])
  assert.ok(prefixed[0].content.startsWith(FREEBUFF_SYSTEM_OPENING))
  assert.match(prefixed[0].content, /Be brief/)

  const r = normalizeReasoningFields({
    reasoning_effort: 'max',
    reasoning: { effort: 'low', other: 1 },
  })
  assert.equal(r.reasoning_effort, undefined)
  // 官方 efforts 表(freebuff free-agents/reasoning-effort):flash=[low,high,max],
  // pro=[high,max]----max 是合法档位,保留以支持最深思考(不降档)
  assert.equal(r.reasoning.effort, 'max')
  assert.equal(r.reasoning.other, 1)

  const r2 = normalizeReasoningFields({ reasoning_effort: 'high' })
  assert.equal(r2.reasoning.effort, 'high')

  // 输出预算治理(freebuff2api-wokers#8:DS4 思考链稍长即截断):
  // reasoning token 计入 max_tokens 预算,客户端偏小上限会把思考链掐断
  // (finish_reason=length).转发上游前抬到 floor,统一为 max_completion_tokens.
  const b1 = normalizeOutputBudget({ max_tokens: 8192 })
  assert.equal(b1.max_tokens, undefined)
  assert.equal(b1.max_completion_tokens, 65536)

  const b2 = normalizeOutputBudget({ max_completion_tokens: 4096, max_tokens: 1000 })
  assert.equal(b2.max_tokens, undefined)
  assert.equal(b2.max_completion_tokens, 65536)

  // 客户端上限高于 floor → 保留客户端意图(不降档)
  const b3 = normalizeOutputBudget({ max_tokens: 131072 })
  assert.equal(b3.max_completion_tokens, 131072)

  // 未设上限 → 补 floor(上游默认若不设可能同样偏小)
  const b4 = normalizeOutputBudget({ model: 'x' })
  assert.equal(b4.max_completion_tokens, 65536)
  assert.equal(b4.model, 'x')

  // max_output_tokens(Responses/部分 SDK 字段)同样计入预算
  const b6 = normalizeOutputBudget({ max_output_tokens: 2048 })
  assert.equal(b6.max_output_tokens, undefined)
  assert.equal(b6.max_completion_tokens, 65536)

  // 非法/非数值上限 → 兜底 floor
  const b5 = normalizeOutputBudget({ max_tokens: 'abc', max_completion_tokens: -5 })
  assert.equal(b5.max_completion_tokens, 65536)

  const originalTools = [
    { type: 'function', function: { name: 'web_search' } },
  ]
  const signedTools = ensureFreebuffToolSignature(originalTools, true)
  assert.equal(originalTools.length, 1)
  // 注入的是官方真签名工具:主签名(带参数,走 schema 子集)+ 自定义名兜底.
  assert.equal(signedTools.length, 1 + FREEBUFF_SIGNATURE_TOOL_NAMES.length)
  assert.ok(signedTools[1].function.name === FREEBUFF_SIGNATURE_TOOL_NAME)
  // 主签名工具必须带非空 schema ---- 上游判据要求签名工具[名字 + 真实参数]双真,
  // 零参数工具不算签名(注入空心 end_turn 正是被上游点名的洗白形态).
  assert.ok(
    signedTools[1].function.parameters &&
      Object.keys(signedTools[1].function.parameters.properties || {}).length > 0,
    '主签名工具必须带非空参数 schema',
  )
  // 每个注入的工具都必须被上游判据认可为[货真价实].
  for (const def of FREEBUFF_SIGNATURE_TOOL_DEFINITIONS) {
    assert.ok(
      isGenuineSignatureTool({
        name: def.function.name,
        parameters: def.function.parameters,
      }),
      '注入的签名工具必须通过上游 isGenuineSignatureTool：' + def.function.name,
    )
    assert.ok(
      FREEBUFF_SIGNATURE_TOOL_NAMES.includes(def.function.name),
      '注入的工具名必须在官方签名名集内：' + def.function.name,
    )
  }
  assert.equal(ensureFreebuffToolSignature(originalTools, false), originalTools)
  assert.deepEqual(ensureFreebuffToolSignature([], true), [])
  assert.equal(
    ensureFreebuffToolSignature(signedTools, true),
    signedTools,
  )
  // 只带其中一个签名工具时,应把缺的那个补上(两个都带才最稳).
  const half = [originalTools[0], FREEBUFF_SIGNATURE_TOOL_DEFINITIONS[0]]
  assert.equal(
    ensureFreebuffToolSignature(half, true).length,
    1 + FREEBUFF_SIGNATURE_TOOL_NAMES.length,
  )
}
