/**
 * free-mode 的系统消息门禁 ---- 从 src/free-mode.ts 按职责切出.
 *
 * 为什么单独成文件: 上游对 system 消息的第一句做 opening 前缀校验(any-of-5
 * trimmed prefix), 这条判据与工具签名, 请求体归一互不相关, 却各自要读一大段
 * 背景. 拆开后"开场白该长什么样"只在这一个文件里.
 *
 * 口径: 纯搬移, 行为零改动.
 */

/** Canonical opening the free-mode gate requires at the start of a system message. */
export const FREEBUFF_SYSTEM_OPENING =
  'You are Buffy, the strategic coding assistant.'

/**
 - base3 世代 root(base3-free-*)的规范开场(对齐 trefeon cliSystemMarkerBase3:
 - agents/base3.ts createBase3 的 canonical opening).base3 运行必须以它开头,
 - 而不是 base2 的 "strategic coding assistant"(对齐 trefeon PR #207:
 - "a base3 run must open with the BASE3 canonical identity, not base2's").
 */
export const FREEBUFF_SYSTEM_OPENING_BASE3 =
  'You are Buffy, the coding agent behind Codebuff.'

/**
 * 判断 agentId 是否 base3 世代 root(base3-free-*).
 * @param {any} agentId 上游 agent 标识
 * @returns {boolean} 是否 base3 世代
 */
export function isBase3Agent(agentId: any) {
  return typeof agentId === 'string' && /^base3-/.test(agentId)
}

/**
 - Minimal system prompt that satisfies free_mode system-marker checks.
 - Kept short so user content dominates; opening must be byte-prefix exact.
 */
export const FREEBUFF_FREE_SYSTEM_PROMPT = `${FREEBUFF_SYSTEM_OPENING}

You help the user with coding and technical questions. Be concise and accurate.
Follow the user's instructions in subsequent messages.
`

function normalizeContentToText(content: any) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text
        }
        return ''
      })
      .join('\n')
  }
  if (content == null) return ''
  return String(content)
}

/**
 - Ensure messages[] has a leading system message whose text starts with the
 - Freebuff free-mode opening. Does not strip or rewrite user content beyond
 - that gate requirement.
 *
 - @param {unknown} messages
 - @param {string} [agentId]  base3-free-* 时用 base3 规范开场(对齐 trefeon)
 - @returns {any[]}
 */
export function ensureFreebuffSystemMessages(messages: any, agentId: any) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : []

  const opening = isBase3Agent(agentId)
    ? FREEBUFF_SYSTEM_OPENING_BASE3
    : FREEBUFF_SYSTEM_OPENING
  const freePrompt = isBase3Agent(agentId)
    ? `${FREEBUFF_SYSTEM_OPENING_BASE3}

You help the user with coding and technical questions. Be concise and accurate.
Follow the user's instructions in subsequent messages.
`
    : FREEBUFF_FREE_SYSTEM_PROMPT

  const firstSystemIdx = list.findIndex((m) => m && m.role === 'system')
  if (firstSystemIdx === -1) {
    return [{ role: 'system', content: freePrompt }, ...list]
  }

  const sys = list[firstSystemIdx]
  const content = normalizeContentToText(sys.content)
  // 任一规范开场已存在则保持原样(门禁是 any-of-5 trimmed prefix).
  const anyCanonical = [
    FREEBUFF_SYSTEM_OPENING,
    FREEBUFF_SYSTEM_OPENING_BASE3,
  ].some((o) => content.trimStart().startsWith(o))
  if (anyCanonical) {
    // Keep as-is (already valid freebuff opening)
    return list
  }

  // Prepend canonical opening without discarding the caller's system text.
  list[firstSystemIdx] = {
    ...sys,
    content: `${opening}\n\n${content}`,
  }
  return list
}
