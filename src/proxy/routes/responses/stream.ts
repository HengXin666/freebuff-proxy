/**
 * chat SSE -> Responses SSE 事件.
 *
 * 流式形态下客户端逐事件消费(见 dsh 的 pi-ai openai-responses 解析分支),
 * 这里负责把 chat 的增量分片翻成它认识的事件名与字段.
 */

/**
 * 文本增量的三个事件(首次先补 item 与 content_part).
 *
 * 累积全文: 收尾事件要带完整文本, 只发 delta 而 done 给空串会让客户端
 * 拿不到最终内容.
 *
 * @param {any} delta chat 分片的 delta
 * @param {any} state 流内游标(原地更新)
 * @param {(type: string, obj: any) => void} emit 事件写出器
 * @returns {void} 无返回值
 */
function emitTextDelta(delta: any, state: any, emit: any): void {
  if (typeof delta?.content !== 'string' || !delta.content) return
  if (!state.textStarted) {
    state.textStarted = true
    state.textIndex = state.itemSeq++
    emit('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: state.textIndex,
      item: { type: 'message', id: 'msg_0', role: 'assistant', status: 'in_progress', content: [] },
    })
    emit('response.content_part.added', {
      type: 'response.content_part.added',
      output_index: state.textIndex,
      content_index: 0,
      item_id: 'msg_0',
      part: { type: 'output_text', text: '', annotations: [] },
    })
  }
  state.text = (state.text || '') + delta.content
  emit('response.output_text.delta', {
    type: 'response.output_text.delta',
    output_index: state.textIndex,
    content_index: 0,
    item_id: 'msg_0',
    delta: delta.content,
  })
}

/**
 * 工具调用增量: 首次为该 index 补 output_item.added, 之后只发参数增量.
 *
 * 累积 name 与 arguments: 收尾 item 要带完整调用, 只发 delta 而 done 给空
 * 会让客户端收到一个无名或空参的调用, 无法派发.
 *
 * @param {any[]} calls chat 分片里的 tool_calls
 * @param {any} state 流内游标(原地更新)
 * @param {(type: string, obj: any) => void} emit 事件写出器
 * @returns {void} 无返回值
 */
function emitToolCallDeltas(calls: any[], state: any, emit: any): void {
  if (!state.calls) state.calls = {}
  for (const call of calls) {
    const index = Number.isInteger(call?.index) ? call.index : 0
    const key = `call${index}`
    if (!state.calls[key]) {
      const outputIndex = state.itemSeq++
      state.calls[key] = {
        callId: call?.id || `call_${index}`,
        outputIndex,
        name: '',
        arguments: '',
      }
      emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: {
          type: 'function_call',
          id: `${state.calls[key].callId}|fc_${index}`,
          call_id: state.calls[key].callId,
          name: call?.function?.name || '',
          arguments: '',
          status: 'in_progress',
        },
      })
    }
    const slot = state.calls[key]
    if (call?.function?.name && !slot.name) slot.name = call.function.name
    const args = call?.function?.arguments
    if (typeof args === 'string' && args) {
      slot.arguments += args
      emit('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: slot.outputIndex,
        item_id: `${slot.callId}|fc_${index}`,
        delta: args,
      })
    }
  }
}

/**
 * chat 的一个 SSE 分片 -> Responses 的 SSE 事件文本(可多行).
 *
 * 事件名与字段逐条对齐 pi-ai 的解析分支; 不认识的 chat 分片一律不产出事件
 * ---- 编一个客户端不认的事件比不发更糟.
 *
 * @param {any} chunk 已解析的 chat SSE 分片
 * @param {{ seq: number, textStarted: boolean, itemSeq: number }} state 流内游标(原地更新)
 * @returns {string} SSE 事件文本(可能为空串)
 */
export function sseEventsFromChatChunk(chunk: any, state: any): string {
  const lines: string[] = []
  const emit = (type: string, obj: any) => {
    lines.push(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`)
  }
  const choice = chunk?.choices?.[0]
  if (chunk?.id && !state.started) {
    state.started = true
    state.responseId = chunk.id
    emit('response.created', {
      type: 'response.created',
      response: {
        id: state.responseId,
        object: 'response',
        status: 'in_progress',
        model: chunk.model || '',
        output: [],
      },
    })
  }
  emitTextDelta(choice?.delta, state, emit)
  emitToolCallDeltas(Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : [], state, emit)
  if (choice?.finish_reason) {
    state.finishReason = choice.finish_reason
  }
  if (chunk?.usage && typeof chunk.usage === 'object') state.usage = chunk.usage
  return lines.join('')
}

/**
 * 收尾时重建完整的 output 数组(文本 item + 各 function_call item).
 *
 * response.completed 里带 output 的客户端(非增量消费)直接读它, 给空数组
 * 等于告诉它这一轮什么都没产出.
 *
 * @param {any} state 流内游标
 * @returns {any[]} output items
 */
function fullOutputItems(state: any) {
  const items: any[] = []
  const text = typeof state?.text === 'string' ? state.text : ''
  if (text) {
    items.push({
      type: 'message',
      id: 'msg_0',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const [key, slot] of Object.entries(state?.calls || {})) {
    const index = Number(String(key).replace('call', '')) || 0
    const s = slot as any
    items.push({
      type: 'function_call',
      id: `${s.callId}|fc_${index}`,
      call_id: s.callId,
      name: s.name || '',
      arguments: s.arguments || '{}',
      status: 'completed',
    })
  }
  return items
}

/**
 * 流结束时补齐 done 系列事件并收尾.
 *
 * @param {any} state sseEventsFromChatChunk 更新过的游标
 * @returns {string} 收尾事件文本
 */
export function sseFinalEvents(state: any): string {
  const lines: string[] = []
  const emit = (type: string, obj: any) => {
    lines.push(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`)
  }
  const fullText = typeof state?.text === 'string' ? state.text : ''
  if (state?.textStarted) {
    emit('response.output_text.done', {
      type: 'response.output_text.done',
      output_index: state.textIndex,
      content_index: 0,
      item_id: 'msg_0',
      text: fullText,
    })
    emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: state.textIndex,
      item: {
        type: 'message',
        id: 'msg_0',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: fullText, annotations: [] }],
      },
    })
  }
  for (const [key, slot] of Object.entries(state?.calls || {})) {
    const index = Number(key.replace('call', '')) || 0
    const s = slot as any
    emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: s.outputIndex,
      item: {
        type: 'function_call',
        id: `${s.callId}|fc_${index}`,
        call_id: s.callId,
        name: s.name || '',
        arguments: s.arguments || '{}',
        status: 'completed',
      },
    })
  }
  const status = state?.finishReason === 'length' ? 'incomplete' : 'completed'
  emit('response.completed', {
    type: `response.${status}`,
    response: {
      id: state?.responseId || `resp_${Date.now()}`,
      object: 'response',
      status,
      output: fullOutputItems(state),
      output_text: fullText,
      ...(state?.usage
        ? {
            usage: {
              input_tokens: state.usage.prompt_tokens ?? 0,
              output_tokens: state.usage.completion_tokens ?? 0,
              total_tokens: state.usage.total_tokens ?? 0,
            },
          }
        : {}),
    },
  })
  return lines.join('')
}
