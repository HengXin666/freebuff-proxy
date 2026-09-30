/**
 * 网页通道（/api/chat/stream）↔ OpenAI 格式的转换。
 *
 * 网页通道的响应是自定义 SSE（meta/delta/done…），下游要的是 OpenAI 的
 * chat.completion.chunk。这层只做**格式转换**，不做重试/调度。
 *
 * 已知降级：网页通道能否真正发起 tool_call 未证实，故**不冒充**工具能力 ——
 * 本层只产出文本内容，finish_reason 恒为 'stop'。
 */
import { randomUUID } from 'crypto'

/**
 * 造一个 OpenAI 非流式响应。
 * @param {{ id?: string, model: string, text: string, reasoning?: string, usage?: object }} p
 * @returns {object}
 */
export function openAiCompletion({ id, model, text, reasoning, usage }) {
  const created = Math.floor(Date.now() / 1000)
  const message = { role: 'assistant', content: text }
  if (reasoning) message.reasoning_content = reasoning
  return {
    id: id || 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24),
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  }
}

/**
 * 造一个 OpenAI 流式 chunk（SSE 的 data 行内容）。
 * @param {{ id: string, model: string, delta?: object, finishReason?: string|null, usage?: object|null }} p
 * @returns {object}
 */
export function openAiChunk({ id, model, delta, finishReason = null, usage = null }) {
  const created = Math.floor(Date.now() / 1000)
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: delta || {},
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

/**
 * 把一个网页通道事件转成 0..n 个 OpenAI chunk 的 delta 负载。
 *
 * 映射（实测事件类型）：
 *   meta             → 忽略（threadId 由上层记录）
 *   delta            → { content: text }
 *   reasoning_delta  → { reasoning_content: text }
 *   suggestions/title/done → 忽略（done 由上层收尾）
 *
 * @param {{ type: string, text?: string }} ev
 * @returns {object|null}
 */
export function webEventToDelta(ev) {
  if (!ev || typeof ev !== 'object') return null
  if (ev.type === 'delta' && typeof ev.text === 'string' && ev.text) {
    return { content: ev.text }
  }
  if (
    ev.type === 'reasoning_delta' &&
    typeof ev.text === 'string' &&
    ev.text
  ) {
    return { reasoning_content: ev.text }
  }
  return null
}

/** SSE 的一帧（data: ...\n\n）。 */
export function sseFrame(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n'
}

/** SSE 结束帧。 */
export const SSE_DONE = 'data: [DONE]\n\n'
