/**

 * mock chat: 请求形态断言
 *
 * mock 侧逐项断言客户端发来的 model 形态 / 元数据 / 工具签名 / 输出预算与真机一致.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { FREEBUFF_SYSTEM_OPENING } from '../../../../../../../src/free-mode.ts'
import assert from 'node:assert/strict'

/** model 形态 + codebuff_metadata + 开场 + 输出预算. 任一不成立即断言失败.
 * @param {any} body
 * @param {any} headers
 */
export function assertChatShape(body, headers) {
  // model 可能是三种形态之一:
  //   - provider/name(legacy 模型 id,如 deepseek/deepseek-v4-flash)
  //   - m-xxxxxxx(目录 key,服务端指派)
  //   - fbm1.xxx(目录句柄,服务端签名)
  // chat 必须用会话回执里服务端指派的 model, 不能用自己的模型名
  // (自己另取模型名会命中上游的 session_model_mismatch 拒绝).见
  // .agents/notes/implemented/bug-fix/2026-10-01-session-model-binding.md
  assert.match(
    body.model,
    /^(?:[a-z0-9-]+\/[a-z0-9.-]+|m-[a-z0-9]+|fbm1\.[A-Za-z0-9_-]+)$/i,
    'chat model 必须是合法形态, got ' + body.model,
  )
  assert.equal(body.codebuff_metadata.cost_mode, 'free')
  assert.ok(body.codebuff_metadata.freebuff_instance_id)
  assert.equal(
    body.codebuff_metadata.run_id,
    '00000000-0000-4000-8000-000000000001',
  )
  assert.ok(Array.isArray(body.messages))
  assert.equal(body.messages[0].role, 'system')
  // base3 世代 root(base3-free-*)用 base3 规范开场(对齐 trefeon PR #207):
  // "a base3 run must open with the BASE3 canonical identity, not base2's".
  // 世代判定不能按模型名猜 ---- 真实来源是 agentId,而 chat body 里没有它.
  // 目录模式(会话模型是 m-xxx / fbm1.xxx)下官方统一用
  // base3-free-catalog,故必然以 base3 开场;见
  // .agents/notes/implemented/bug-fix/2026-10-01-catalog-agent.md
  // 真机证据:官方 chat 的 system 开场就是
  //   "You are Buffy, the coding agent behind Codebuff."
  const isBase3Run =
    /luna/.test(body.model) || /^(m-|fbm1\.)/.test(String(body.model))
  const msg0 = String(body.messages[0].content)
  //  官方抓包(2026-10-03)证明 system 开场恒为
  //   "You are Buffy, the coding agent behind Codebuff."
  // (worker 层模板 7918 字符以此开头).
  // 旧判定按模型名猜世代,模型名不匹配时会误走 base2 分支;
  // 这里改为:官方开头与 legacy 的 base2 开场都接受.
  // 见 docs/reverse/14-captured-diff.md
  assert.ok(
    msg0.startsWith('You are Buffy, the coding agent behind Codebuff.') ||
      msg0.startsWith(FREEBUFF_SYSTEM_OPENING),
    `messages[0] 应以官方模板或 base2 开场, got ${msg0.slice(0, 80)}`,
  )
  const userMsg = body.messages.find((m) => m.role === 'user')
  assert.ok(userMsg && String(userMsg.content).length > 0)
  assert.ok(headers.Authorization || headers.authorization)
  /**
   * - x-codebuff-api-key 必须不存在:客户端抓包里出现 0 次
   * (docs/reverse/20 §20.4).
   */
  assert.ok(
    !headers['x-codebuff-api-key'] && !headers['X-Codebuff-Api-Key'],
    '不得再带 x-codebuff-api-key（客户端 0 次）',
  )

  // 输出预算治理(freebuff2api-wokers#8):客户端小 max_tokens 会把思考链
  // (reasoning token 计入预算)掐断----转发上游前必须抬到 floor 并统一为
  // max_completion_tokens 单字段,绝不允许小上限原样透传.
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.max_output_tokens, undefined)
  assert.ok(
    body.max_completion_tokens >= 65536,
    `转发上游的输出预算应 >= 65536, got ${body.max_completion_tokens}`,
  )
}
