/**

 * mock: POST /api/v1/agent-runs
 *
 * agent 兜底 / 退役场景: 按 agentId 回 200 / 403 / 500, 并记录历次 agentId 供断言.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../smoke/state.ts'
import { jsonRes } from '../helpers.ts'

/** 处理 POST /agent-runs.
 * @param {any} headers
 * @param {any} init
 * @returns {any}
 */
export function handleAgentRunsPost(headers, init) {
  const body = JSON.parse(init.body || '{}')
  if (body.action === 'START') {
    const runAuth =
      headers.Authorization ||
      headers.authorization ||
      headers['x-codebuff-api-key'] ||
      ''
    if (state.mockMode === 'run_500_a' && String(runAuth).includes('token-a')) {
      return jsonRes({ error: 'internal_error', message: 'run boom' }, 500)
    }
    // run_403_a 模式下 token-a 的 startAgentRun 回 403 start_agent_run_failed.
    // 用例断言该账号被冷却后换下一个账号, 不把该错误直接甩给下游.
    if (state.mockMode === 'run_403_a' && String(runAuth).includes('token-a')) {
      return jsonRes(
        {
          error: 'start_agent_run_failed',
          message: 'This account/agent combination cannot start a run.',
        },
        403,
      )
    }
    // agent 兜底:主 agent(base2)被拒,base3 孪生成功
    if (state.mockMode === 'agent_fallback' && body.agentId === 'base2-free-deepseek-flash') {
      return jsonRes(
        {
          error: 'free_mode_invalid_agent_model',
          message:
            'Free mode is only available for specific agent and model combinations.',
        },
        403,
      )
    }
    // 退役 Luna agent:chat 阶段 free_mode_legacy_luna_agent 场景----base2
    // startAgentRun 能成功(runId 正常返回),但 chat 转发后上游说
    // "此对话用了退役 agent".重试必须切 base3.
    if (state.mockMode === 'luna_base2_retired' && body.agentId === 'base2-free-luna') {
      state.startAgentCalls.push(body.agentId)
      return jsonRes({ runId: '00000000-0000-4000-8000-000000000002' })
    }
    state.startAgentCalls.push(body.agentId)
    return jsonRes({ runId: '00000000-0000-4000-8000-000000000001' })
  }
  if (body.action === 'FINISH') {
    return jsonRes({ ok: true })
  }
  return jsonRes({ error: 'bad action' }, 400)
}
