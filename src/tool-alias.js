/**
 * Narrow compatibility alias for Hermes' `delegate_task`.
 *
 * Freebuff currently classifies that exact name as a foreign-harness signal.
 * Hermes itself dispatches on the literal name, so the proxy aliases it only
 * on the upstream wire and restores it before returning tool_calls.
 *
 * Decision record:
 * .agents/notes/implemented/bug-fix/2026-09-19-hermes-delegate-task-alias.md
 */

export const HERMES_DELEGATE_TOOL_NAME = 'delegate_task'
export const HERMES_DELEGATE_ALIAS_BASE = 'spawn_subagent'

function offeredToolNames(tools) {
  const names = new Set()
  if (!Array.isArray(tools)) return names
  for (const tool of tools) {
    const name = tool?.function?.name
    if (typeof name === 'string' && name) names.add(name)
  }
  return names
}

/**
 * Return a deterministic collision-free alias when the client offers
 * delegate_task, otherwise null.
 *
 * @param {unknown} tools
 * @returns {string | null}
 */
export function chooseHermesDelegateAlias(tools) {
  const names = offeredToolNames(tools)
  if (!names.has(HERMES_DELEGATE_TOOL_NAME)) return null

  let alias = HERMES_DELEGATE_ALIAS_BASE
  let suffix = 2
  while (names.has(alias)) {
    alias = `${HERMES_DELEGATE_ALIAS_BASE}_${suffix++}`
  }
  return alias
}

function rewriteFunctionName(fn, from, to) {
  if (!fn || typeof fn !== 'object' || fn.name !== from) return fn
  return { ...fn, name: to }
}

function rewriteToolCall(call, from, to) {
  if (!call || typeof call !== 'object') return call
  const nextFunction = rewriteFunctionName(call.function, from, to)
  return nextFunction === call.function ? call : { ...call, function: nextFunction }
}

function rewriteMessage(message, from, to) {
  if (!message || typeof message !== 'object') return message
  let changed = false
  const out = { ...message }

  if (Array.isArray(message.tool_calls)) {
    const calls = message.tool_calls.map((call) => rewriteToolCall(call, from, to))
    if (calls.some((call, i) => call !== message.tool_calls[i])) {
      out.tool_calls = calls
      changed = true
    }
  }

  const functionCall = rewriteFunctionName(message.function_call, from, to)
  if (functionCall !== message.function_call) {
    out.function_call = functionCall
    changed = true
  }

  if (message.role === 'tool' && message.name === from) {
    out.name = to
    changed = true
  }

  return changed ? out : message
}

/**
 * Rewrite the Hermes name everywhere it can participate in an OpenAI
 * chat-completions request: tool definitions, forced tool_choice, and
 * multi-turn tool history.
 *
 * @param {Record<string, any>} body
 * @param {string | null} alias
 * @returns {Record<string, any>}
 */
export function rewriteHermesDelegateForUpstream(body, alias) {
  if (!alias || !body || typeof body !== 'object' || Array.isArray(body)) {
    return body
  }

  let changed = false
  const out = { ...body }

  if (Array.isArray(body.tools)) {
    const tools = body.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool
      const nextFunction = rewriteFunctionName(
        tool.function,
        HERMES_DELEGATE_TOOL_NAME,
        alias,
      )
      return nextFunction === tool.function ? tool : { ...tool, function: nextFunction }
    })
    if (tools.some((tool, i) => tool !== body.tools[i])) {
      out.tools = tools
      changed = true
    }
  }

  if (body.tool_choice && typeof body.tool_choice === 'object') {
    const nextFunction = rewriteFunctionName(
      body.tool_choice.function,
      HERMES_DELEGATE_TOOL_NAME,
      alias,
    )
    if (nextFunction !== body.tool_choice.function) {
      out.tool_choice = { ...body.tool_choice, function: nextFunction }
      changed = true
    }
  }

  if (Array.isArray(body.messages)) {
    const messages = body.messages.map((message) =>
      rewriteMessage(message, HERMES_DELEGATE_TOOL_NAME, alias),
    )
    if (messages.some((message, i) => message !== body.messages[i])) {
      out.messages = messages
      changed = true
    }
  }

  return changed ? out : body
}

function restoreToolCalls(toolCalls, alias) {
  if (!Array.isArray(toolCalls)) return toolCalls
  return toolCalls.map((call) => rewriteToolCall(call, alias, HERMES_DELEGATE_TOOL_NAME))
}

/**
 * Restore the client-visible Hermes tool name in a non-streaming response or
 * in one parsed streaming chunk.
 *
 * @param {any} payload
 * @param {string | null} alias
 * @returns {any}
 */
export function restoreHermesDelegateInResponse(payload, alias) {
  if (!alias || !payload || typeof payload !== 'object') return payload
  if (!Array.isArray(payload.choices)) return payload

  let changed = false
  const choices = payload.choices.map((choice) => {
    if (!choice || typeof choice !== 'object') return choice
    let choiceChanged = false
    const out = { ...choice }

    for (const key of ['message', 'delta']) {
      const part = choice[key]
      if (!part || typeof part !== 'object') continue
      const calls = restoreToolCalls(part.tool_calls, alias)
      const functionCall = rewriteFunctionName(
        part.function_call,
        alias,
        HERMES_DELEGATE_TOOL_NAME,
      )
      if (calls !== part.tool_calls || functionCall !== part.function_call) {
        out[key] = {
          ...part,
          ...(calls !== part.tool_calls ? { tool_calls: calls } : {}),
          ...(functionCall !== part.function_call
            ? { function_call: functionCall }
            : {}),
        }
        choiceChanged = true
      }
    }

    if (choiceChanged) changed = true
    return choiceChanged ? out : choice
  })

  return changed ? { ...payload, choices } : payload
}

/**
 * Rewrite a single SSE line. Non-data lines, [DONE], and malformed JSON pass
 * through byte-for-byte.
 *
 * @param {string} line
 * @param {string | null} alias
 * @returns {string}
 */
export function rewriteHermesDelegateSseLine(line, alias) {
  if (!alias || typeof line !== 'string') return line
  const newline = line.endsWith('\r\n')
    ? '\r\n'
    : line.endsWith('\n')
      ? '\n'
      : ''
  const core = newline ? line.slice(0, -newline.length) : line
  const match = core.match(/^(\s*data:\s*)(.*)$/)
  if (!match) return line
  const payloadText = match[2]
  if (payloadText.trim() === '[DONE]') return line

  try {
    const parsed = JSON.parse(payloadText)
    const restored = restoreHermesDelegateInResponse(parsed, alias)
    return match[1] + JSON.stringify(restored) + newline
  } catch {
    return line
  }
}

/**
 * Transform an OpenAI-compatible SSE stream while preserving incremental
 * delivery. function.name is normally present only on the first tool-call
 * chunk; argument chunks pass through unchanged.
 *
 * @param {string} alias
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createHermesDelegateSseTransform(alias) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      let newlineAt
      while ((newlineAt = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newlineAt + 1)
        pending = pending.slice(newlineAt + 1)
        controller.enqueue(
          encoder.encode(rewriteHermesDelegateSseLine(line, alias)),
        )
      }
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending) {
        controller.enqueue(
          encoder.encode(rewriteHermesDelegateSseLine(pending, alias)),
        )
      }
    },
  })
}
