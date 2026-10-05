/**

 * mock chat: 入口
 *
 * 按原顺序编排三段: 形态断言 -> 退役 agent 拦截 -> 模式分支. 顺序与原实现逐行一致.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { modesReply } from './modes.ts'
import { retiredAgentReply } from './retired.ts'
import { assertChatShape } from './shape.ts'

/** 处理 POST /v1/chat/completions(上游侧).
 * @param {any} init
 * @returns {any}
 */
export function handleChatCompletions(init) {
  const body = JSON.parse(init.body)
  const headers = init.headers || {}
  assertChatShape(body, headers)
  const retired = retiredAgentReply(body)
  if (retired) return retired
  return modesReply(body, headers)
}
