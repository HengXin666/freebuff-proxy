/**
 * scheduling: agent 兜底与退役
 *
 * agentId 不被接受时按 fallback 表换 base3 世代, 并清理付费时段的跨用例残留.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { chat, runtimes } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'

// agent 兜底:主 agent 403 free_mode_invalid_agent_model → 自动回退 base3 孪生
{
  state.mockMode = 'agent_fallback'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  // startAgentRun 至少尝试了 base3(fallback),且 chat 成功
  const startCalls = state.calls.filter(
    (c) => c.url.includes('/agent-runs') && JSON.parse(c.body).action === 'START',
  )
  assert.ok(
    startCalls.some((c) => JSON.parse(c.body).agentId === 'base3-free-deepseek-flash'),
    `应回退到 base3 孪生 agent, got ${JSON.stringify(startCalls.map((c) => JSON.parse(c.body).agentId))}`,
  )
  state.mockMode = 'ok'
}

// retired Luna conversation → release/re-admit the same model session once,
// without cooling the account or forwarding the stale conversation identity.
{
  await runtimes.get('u1').sessions.release()
  state.mockMode = 'legacy_luna_once'
  state.sessionPosts = 0
  state.sessionDeletes = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await chat({
    model: 'openai/gpt-5.6-luna',
    conversation_id: 'old-top-level-conversation',
    codebuff_metadata: {
      conversation_id: 'old-nested-conversation',
      client_id: 'old-client-id',
      agent_id: 'retired-luna-agent',
    },
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(state.sessionPosts, 2, 'legacy Luna error should admit a fresh session')
  assert.equal(state.sessionDeletes, 1, 'legacy Luna recovery should release the old session')

  const completionCalls = state.calls.filter((c) => c.url.includes('/chat/completions'))
  assert.equal(completionCalls.length, 2, 'legacy Luna should retry once')
  const forwarded = completionCalls.map((c) => JSON.parse(c.body))
  for (const body of forwarded) {
    assert.equal(body.conversation_id, undefined)
    assert.equal(body.codebuff_metadata.conversation_id, undefined)
    assert.equal(body.codebuff_metadata.agent_id, undefined)
    // client_id 必须是 SDK 形 13 位 base36(对齐官方 CLI
    // Math.random().toString(36).substring(2,15))----绝不能用 freebuff-proxy
    // 等自有前缀:上游 cf-worker-signals.ts 的 looksLikeProxyClientId 会把
    // 自定义形态指纹为代理客户端(对齐 trefeon generateClientID).
    assert.match(
      body.codebuff_metadata.client_id,
      /^[0-9a-z]{13}$/,
      `client_id 应为 13 位 base36 SDK 形, got ${body.codebuff_metadata.client_id}`,
    )
  }
  assert.notEqual(
    forwarded[0].codebuff_metadata.client_id,
    'old-client-id',
    'proxy must not inherit a retired client identity',
  )
  state.mockMode = 'ok'
}

// luna 系强制 base3(风控保护):agentIdForModel 对 luna 永远返回 base3-free-luna,
// 无论自定义/catalog 写了 base2----任何 base2 尝试都会触发上游风控.
// 验证:真实 chat 里 startAgentRun 只用 base3,绝无 base2 出现.
{
  await runtimes.get('u1').sessions.release()
  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.sessionDeletes = 0
  state.completionAttempts = 0
  state.startAgentCalls = []
  state.calls = []
  const res = await chat({
    model: 'openai/gpt-5.6-luna',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.ok(
    state.startAgentCalls.length >= 1,
    `startAgentRun 至少调用一次, got ${JSON.stringify(state.startAgentCalls)}`,
  )
  assert.ok(
    state.startAgentCalls.every((a) => a === 'base3-free-luna'),
    `luna 只允许 base3-free-luna, got ${JSON.stringify(state.startAgentCalls)}`,
  )
  assert.ok(
    !state.startAgentCalls.some((a) => a.includes('base2')),
    `luna 绝不允许 base2, got ${JSON.stringify(state.startAgentCalls)}`,
  )
  // luna-es 同样强制 base3(base3-free-luna-es,绝无 base2)
  //
  //  换模型前必须显式释放上一条会话: 一次 admit 买断一小时且绑定模型,
  // 付费时段内换模型会把那一小时作废且接不回来, 所以[同一小时内跨模型可用]
  // 不成立. 这里显式释放 = 模拟"时段结束/用户主动关闭后再换模型"的路径.
  await runtimes.get('u1').sessions.release()
  state.startAgentCalls = []
  const resEs = await chat({
    model: 'openai/gpt-5.6-luna-es',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(resEs.status, 200, await resEs.clone().text())
  assert.ok(
    state.startAgentCalls.every((a) => a === 'base3-free-luna-es'),
    `luna-es 应只用 base3-free-luna-es, got ${JSON.stringify(state.startAgentCalls)}`,
  )
  state.mockMode = 'ok'
}

// 模型白名单:APP 里没有的模型 id 一律 400 拒绝,绝不盲发上游
{
  // 清掉上一用例留下的已付费会话:它绑在 luna-es 上,会让本用例的选号先撞上
  // 付费时段内绑别模型而拿不到 400.白名单校验发生在选号之前,
  // 但选号失败会先返回 429 ---- 保持用例间状态干净,断言的才是白名单本身.
  await runtimes.get('u1').sessions.release()
  state.calls = []
  state.completionAttempts = 0
  // 完全未知的模型 id(不在 catalog / 自定义 / 上游探测里)
  const res = await chat({
    model: 'openai/gpt-5.7-unknown',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 400, await res.clone().text())
  const j = await res.json()
  assert.equal(j.error.code, 'model_not_allowed')
  assert.equal(state.completionAttempts, 0, '未知模型不应打到上游')
  state.mockMode = 'ok'
}
