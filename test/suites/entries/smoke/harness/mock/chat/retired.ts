/**

 * mock chat: 退役 Luna agent 的首次必撞
 *
 * legacy_luna_once 与 luna_base2_retired 两个模式: 首次 completion 回 403 free_mode_legacy_luna_agent, 用来验证换 agentId 后重试成功.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { jsonRes } from '../../helpers.ts'

/** 命中即返回 403 回执, 未命中返回 null(调用方继续往下走).
 * @param {any} body
 * @returns {any}
 */
export function retiredAgentReply(body) {
  if (
    state.mockMode === 'legacy_luna_once' &&
    body.model === 'openai/gpt-5.6-luna' &&
    state.completionAttempts === 0
  ) {
    state.completionAttempts++
    return jsonRes(
      {
        error: 'free_mode_legacy_luna_agent',
        message:
          'This conversation uses a retired Luna agent. Update Freebuff if needed, then start a new conversation.',
      },
      403,
    )
  }
  // luna_base2_retired:base2 的 runId 指向退役 agent,chat 第一次必撞
  // free_mode_legacy_luna_agent;重试(切 base3 + 新 runId)后成功.
  if (
    state.mockMode === 'luna_base2_retired' &&
    body.model === 'openai/gpt-5.6-luna' &&
    state.completionAttempts === 0
  ) {
    state.completionAttempts++
    return jsonRes(
      {
        error: 'free_mode_legacy_luna_agent',
        message:
          'This conversation uses a retired Luna agent. Update Freebuff if needed, then start a new conversation.',
      },
      403,
    )
  }
  return null
}
