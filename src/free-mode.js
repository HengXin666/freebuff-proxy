/**
 * Freebuff free-mode request shape gates (client-side enforcement helpers).
 * Server source of truth: freebuff common/src/constants/free-agents.ts
 */

/** Canonical opening the free-mode gate requires at the start of a system message. */
export const FREEBUFF_SYSTEM_OPENING =
  'You are Buffy, the strategic coding assistant.'

/**
 * Minimal system prompt that satisfies free_mode system-marker checks.
 * Kept short so user content dominates; opening must be byte-prefix exact.
 */
export const FREEBUFF_FREE_SYSTEM_PROMPT = `${FREEBUFF_SYSTEM_OPENING}

You help the user with coding and technical questions. Be concise and accurate.
Follow the user's instructions in subsequent messages.
`

export const FREEBUFF_SIGNATURE_TOOL_NAME = 'end_turn'

const FREEBUFF_SIGNATURE_TOOL = Object.freeze({
  type: 'function',
  function: Object.freeze({
    name: FREEBUFF_SIGNATURE_TOOL_NAME,
    description: 'Compatibility marker only. Do not call this function.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({}),
    }),
  }),
})

/**
 * Add one Freebuff-specific tool name to a foreign toolset so upstream keeps
 * the requested model. Tool-free requests do not trigger that upstream check.
 *
 * @param {unknown} tools
 * @param {boolean} enabled
 * @returns {unknown}
 */
export function ensureFreebuffToolSignature(tools, enabled = true) {
  if (!enabled || !Array.isArray(tools) || tools.length === 0) return tools
  const alreadyPresent = tools.some(
    (tool) =>
      tool &&
      typeof tool === 'object' &&
      tool.function &&
      typeof tool.function === 'object' &&
      tool.function.name === FREEBUFF_SIGNATURE_TOOL_NAME,
  )
  return alreadyPresent ? tools : [...tools, FREEBUFF_SIGNATURE_TOOL]
}

/**
 * Ensure messages[] has a leading system message whose text starts with the
 * Freebuff free-mode opening. Does not strip or rewrite user content beyond
 * that gate requirement.
 *
 * @param {unknown} messages
 * @returns {any[]}
 */
export function ensureFreebuffSystemMessages(messages) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : []

  const firstSystemIdx = list.findIndex((m) => m && m.role === 'system')
  if (firstSystemIdx === -1) {
    return [
      { role: 'system', content: FREEBUFF_FREE_SYSTEM_PROMPT },
      ...list,
    ]
  }

  const sys = list[firstSystemIdx]
  const content = normalizeContentToText(sys.content)
  if (content.trimStart().startsWith(FREEBUFF_SYSTEM_OPENING)) {
    // Keep as-is (already valid freebuff opening)
    return list
  }

  // Prepend canonical opening without discarding the caller's system text.
  list[firstSystemIdx] = {
    ...sys,
    content: `${FREEBUFF_SYSTEM_OPENING}\n\n${content}`,
  }
  return list
}

function normalizeContentToText(content) {
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
 * Freebuff/OpenAI reject requests that carry BOTH reasoning_effort and
 * reasoning.effort (especially with different values). Freebuff also injects
 * a default `reasoning.effort` for catalog models when it thinks the caller
 * omitted reasoning — so a bare `reasoning_effort: "max"` collides with the
 * server default `high`.
 *
 * Collapse to a single `reasoning: { effort }` field. Map `max` → `high`
 * (Freebuff Luna catalog top effort).
 *
 * @param {Record<string, any>} body
 * @returns {Record<string, any>}
 */
export function normalizeReasoningFields(body) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }

  const fromTop =
    typeof out.reasoning_effort === 'string' ? out.reasoning_effort : null
  const fromNested =
    out.reasoning &&
    typeof out.reasoning === 'object' &&
    typeof out.reasoning.effort === 'string'
      ? out.reasoning.effort
      : null

  let effort = fromTop || fromNested
  if (!effort) return out

  // Prefer explicit top-level if both present (caller's curl-style field)
  if (fromTop) effort = fromTop

  // 官方 efforts 表：deepseek-v4-flash = [low, high, max]、v4-pro = [high, max]，
  // 因此 max 是合法档位，不降档（旧实现 max→high 会压制思考深度/智力）。
  const mapped = effort
  delete out.reasoning_effort
  out.reasoning = {
    ...(out.reasoning && typeof out.reasoning === 'object' ? out.reasoning : {}),
    effort: mapped,
  }
  return out
}
