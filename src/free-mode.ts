/**
 - Freebuff free-mode request shape gates (client-side enforcement helpers).
 - Server source of truth: freebuff common/src/constants/free-agents.ts
 *
 * 本文件是薄门面(barrel):实现已按职责拆进 ./free-mode/ --
 *   system.ts  system 消息的规范开场门禁(opening 前缀校验)
 *   tools.ts   工具签名与工具集判据(补签名 / 剥工具 / 是否带工具)
 *   body.ts    请求体字段归一(会话标识 / 推理字段 / 输出预算)
 *
 * 保留原路径与全部原有导出名, 既有 import 点一处都不用改.
 */
export {
  FREEBUFF_FREE_SYSTEM_PROMPT,
  FREEBUFF_SYSTEM_OPENING,
  FREEBUFF_SYSTEM_OPENING_BASE3,
  ensureFreebuffSystemMessages,
  isBase3Agent,
} from './free-mode/system.ts'

export {
  FREEBUFF_SIGNATURE_TOOL_DEFINITIONS,
  FREEBUFF_SIGNATURE_TOOL_NAME,
  FREEBUFF_SIGNATURE_TOOL_NAMES,
  detectForeignClient,
  ensureFreebuffToolSignature,
  hasClientTools,
  isGenuineSignatureTool,
  stripClientTools,
} from './free-mode/tools.ts'

export {
  normalizeOutputBudget,
  normalizeReasoningFields,
  stripFreebuffConversationState,
} from './free-mode/body.ts'
