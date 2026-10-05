/**
 * chat 响应 -> Responses 响应(整体 JSON 与非流式聚合两种形态).
 *
 * 协议真值取自 dsh 自身实现(@earendil-works/pi-ai 的 openai-responses-shared):
 * 拓扑是 output 数组 + 扁平字段, 工具调用是 function_call item, 且 id 采取
 * call_id|item_id 两段式(见其 createSlot 对 item.type === 'function_call' 的处理).
 * 客户端按 call_id 回传 function_call_output, 所以两段都要给出, 缺 call_id
 * 会让下一轮的工具结果对不上.
 */

/**
 * 造一个 Responses 形态的 function_call item.
 *
 * @param {any} call chat 形态的 tool_call
 * @param {number} index 序号
 * @returns {any} function_call item
 */
function toFunctionCallItem(call: any, index: number) {
  const callId = call?.id || `call_${index}`
  return {
    type: 'function_call',
    id: `${callId}|fc_${index}`,
    call_id: callId,
    name: call?.function?.name || '',
    arguments: call?.function?.arguments ?? '{}',
    status: 'completed',
  }
}

/**
 * 把 chat 的 message 翻成 Responses 的 output 数组.
 *
 * @param {any} message chat 响应里的 message
 * @returns {any[]} output items
 */
export function outputItemsFromMessage(message: any): any[] {
  const items: any[] = []
  const text = typeof message?.content === 'string' ? message.content : ''
  if (text) {
    items.push({
      type: 'message',
      id: 'msg_0',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  calls.forEach((call: any, i: number) => items.push(toFunctionCallItem(call, i)))
  return items
}

/**
 * chat 的 finish_reason -> Responses 的 status 与 incomplete 详情.
 *
 * 只有 length(输出被截断)才是 incomplete; 工具调用在 Responses 里是正常
 * completed(status 表达的是整轮响应是否完整, 不是有没有工具调用).
 *
 * @param {any} finishReason chat finish_reason
 * @returns {{ status: string, incomplete_details?: any }} status 与可选详情
 */
function statusFromFinishReason(finishReason: any) {
  if (finishReason === 'length') {
    return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
  }
  return { status: 'completed' }
}

/**
 * 组装 Responses 响应体.
 *
 * @param {{ id?: string, model?: string, message?: any, finishReason?: any, usage?: any }} input 各段
 * @returns {any} Responses 响应体
 */
export function buildResponsesPayload(input: {
  id?: string
  model?: string
  message?: any
  finishReason?: any
  usage?: any
}): any {
  const output = outputItemsFromMessage(input.message)
  const text = typeof input.message?.content === 'string' ? input.message.content : ''
  const status = statusFromFinishReason(input.finishReason)
  return {
    id: input.id || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: status.status,
    ...(status.incomplete_details ? { incomplete_details: status.incomplete_details } : {}),
    model: input.model || '',
    output,
    output_text: text,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    error: null,
    incomplete_details: status.incomplete_details ?? null,
    usage: {
      input_tokens: input.usage?.prompt_tokens ?? 0,
      output_tokens: input.usage?.completion_tokens ?? 0,
      total_tokens: input.usage?.total_tokens ?? 0,
    },
  }
}

/**
 * 从 chat 的 SSE 正文里聚合出最终 message 与 usage.
 *
 * 上游是流式(官方链路 stream 恒为 true), 而非流式的 Responses 请求需要一份
 * 完整 JSON, 所以先把 SSE 收成一条 message 再翻译.
 *
 * @param {string} sse chat SSE 正文
 * @returns {{ message: any, usage: any, id: string | null, finishReason: any }}
 */
export function aggregateChatSse(sse: string) {
  let content = ''
  let id: string | null = null
  let finishReason: any = null
  let usage: any = null
  const byIndex = new Map<number, any>()
  for (const line of String(sse || '').split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === '[DONE]') continue
    let chunk: any
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    if (typeof chunk?.id === 'string' && chunk.id) id = chunk.id
    if (chunk?.usage && typeof chunk.usage === 'object') usage = chunk.usage
    const choice = chunk?.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta || choice.message
    if (typeof delta?.content === 'string') content += delta.content
    const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
    for (const call of calls) {
      const index = Number.isInteger(call?.index) ? call.index : 0
      const prev = byIndex.get(index) || {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      }
      if (typeof call?.id === 'string' && call.id) prev.id = call.id
      const fn = call?.function || {}
      if (typeof fn.name === 'string' && fn.name) prev.function.name = fn.name
      if (typeof fn.arguments === 'string') prev.function.arguments += fn.arguments
      byIndex.set(index, prev)
    }
  }
  const toolCalls = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((c) => c.function.name)
  const message: any = { role: 'assistant', content }
  if (toolCalls.length) message.tool_calls = toolCalls
  return { message, usage, id, finishReason }
}
