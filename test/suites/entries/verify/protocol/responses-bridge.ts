/**
 * /v1/responses 协议桥接的可证伪验证.
 *
 * 判据按"输入 -> 输出形态"设计, 每条都能被实现侧破坏证伪:
 *   ① 请求翻译: Responses 的 input items -> chat messages, 扁平 tools -> function 包装
 *   ② 非流式响应: chat JSON -> Responses output 数组
 *   ③ 流式响应: chat SSE 分片 -> response.* 事件, 且收尾事件带完整内容
 *   ④ 合成 req/res: 只实现链路真正调用的 API, 不该少
 *
 * 真值来源是 dsh 自身实现(@earendil-works/pi-ai 的 openai-responses):
 * 它读 output_text.done 的 text 与 function_call item 的 call_id|item_id.
 * 所以本测试断言的是"这些字段必须被填实", 不是"字段存在即可".
 *
 * 用法: node test/suites/entries/verify/protocol/responses-bridge.ts
 */
import {
  chatRequestFromResponses,
} from '../../../../../src/proxy/routes/responses/request.ts'
import {
  aggregateChatSse,
  buildResponsesPayload,
} from '../../../../../src/proxy/routes/responses/translate.ts'
import {
  sseEventsFromChatChunk,
  sseFinalEvents,
} from '../../../../../src/proxy/routes/responses/stream.ts'
import { createCaptureResponse, syntheticChatRequest } from '../../../../../src/proxy/routes/responses/capture.ts'

let n = 0
const ok = (cond: any, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  n += 1
}

// ── ① 请求翻译 ────────────────────────────────────────────────────
{
  const t = chatRequestFromResponses({
    model: 'DeepSeek V4.1 Flash',
    input: 'hi',
    stream: true,
    tools: [
      {
        type: 'function',
        name: 'bash',
        description: 'Run a bash command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
  })
  ok(t.body.model === 'DeepSeek V4.1 Flash', 'model 必须原样搬运')
  ok(t.body.messages.length === 1, 'string input 应变成一条 user 消息')
  ok(t.body.messages[0].role === 'user', 'string input 的角色是 user')
  ok(t.body.messages[0].content === 'hi', 'string input 的内容原样保留')
  // 扁平工具必须被包进 function: chat 侧要的是 {type, function:{name,...}}
  ok(Array.isArray(t.body.tools) && t.body.tools.length === 1, '工具应被搬运')
  ok(t.body.tools[0].function?.name === 'bash', '扁平工具必须包进 function.name')
  ok(
    t.body.tools[0].function?.parameters?.type === 'object',
    '扁平工具的 parameters 必须收进 function.parameters',
  )
  ok(t.stream === true, 'stream 标志来自请求')
}

// ── ①b 多轮: function_call / function_call_output 的 call_id 必须落到 tool_call_id ──
{
  const t = chatRequestFromResponses({
    model: 'm',
    input: [
      { role: 'user', content: 'list files' },
      { type: 'function_call', call_id: 'call_abc', name: 'bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call_abc', output: 'file_a.txt' },
    ],
  })
  const msgs = t.body.messages
  ok(msgs.length === 3, '三条 item 应产出三条消息')
  ok(
    msgs[1].role === 'assistant' && msgs[1].tool_calls[0].id === 'call_abc',
    'function_call 的 call_id 要成为 tool_call id',
  )
  ok(msgs[1].tool_calls[0].function.name === 'bash', 'function_call 的名字要保留')
  ok(msgs[2].role === 'tool', 'function_call_output 要变成 tool 消息')
  ok(msgs[2].tool_call_id === 'call_abc', 'tool_call_id 必须等于 call_id(否则模型看不到结果)')
}

// ── ①c output_text 内容块数组也要能取文本 ─────────────────────────
{
  const t = chatRequestFromResponses({
    model: 'm',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  })
  ok(t.body.messages[0].content === 'hello', '内容块数组要取出 text')
}

// ── ② 非流式: chat JSON -> Responses output ───────────────────────
{
  const payload = buildResponsesPayload({
    model: 'DeepSeek V4.1 Flash',
    message: { role: 'assistant', content: 'hi there' },
    finishReason: 'stop',
  })
  ok(payload.object === 'response', 'object 必须是 response')
  ok(payload.status === 'completed', 'stop 应映射为 completed')
  ok(payload.output.length === 1, '一条文本应产出一个 output item')
  ok(payload.output[0].type === 'message', '文本 item 是 message')
  ok(
    payload.output[0].content[0].type === 'output_text',
    '文本内容块类型是 output_text',
  )
  ok(payload.output[0].content[0].text === 'hi there', '文本要落在 output_text.text')
  ok(payload.output_text === 'hi there', '扁平 output_text 要同时给出')
}

// ── ②b 工具调用 -> function_call item, 且 id 是 call_id|item_id 两段式 ──
{
  const payload = buildResponsesPayload({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_x', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
    },
    finishReason: 'tool_calls',
  })
  const fc = payload.output.find((i: any) => i.type === 'function_call')
  ok(Boolean(fc), 'tool_calls 应产出 function_call item')
  ok(fc.call_id === 'call_x', 'call_id 必须原样给出(下一轮靠它对上)')
  ok(fc.id.includes('call_x') && fc.id.includes('|'), 'id 必须是 call_id|item_id 两段式')
  ok(fc.name === 'bash', 'name 要保留')
  ok(fc.arguments === '{"command":"ls"}', 'arguments 要保留原 JSON 字符串')
  // 工具调用不该被当成截断
  ok(payload.status === 'completed', '有工具调用不等于 incomplete')
}

// ── ②c length -> incomplete ──────────────────────────────────────
{
  const payload = buildResponsesPayload({ message: { content: 'x' }, finishReason: 'length' })
  ok(payload.status === 'incomplete', 'length 应映射为 incomplete')
}

// ── ③ 流式: chat 分片 -> response.* 事件 ──────────────────────────
{
  const state: any = { seq: 0, textStarted: false, itemSeq: 0 }
  let out = ''
  out += sseEventsFromChatChunk(
    { id: 'chatcmpl-1', model: 'm', choices: [{ delta: { content: 'Hi' } }] },
    state,
  )
  out += sseEventsFromChatChunk(
    { choices: [{ delta: { content: ' there' } }] },
    state,
  )
  out += sseEventsFromChatChunk({ choices: [{ finish_reason: 'stop' }] }, state)
  out += sseFinalEvents(state)

  ok(out.includes('event: response.created'), '首片要发 response.created')
  ok(out.includes('event: response.output_text.delta'), '文本增量要发 output_text.delta')
  ok(out.includes('response.output_text.done'), '收尾要发 output_text.done')
  ok(out.includes('response.completed'), '收尾要发 response.completed')

  // 关键: done 事件必须带完整文本(dsh 从它取最终内容)
  const doneLine = out
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6))
      } catch {
        return null
      }
    })
    .find((d) => d && d.type === 'response.output_text.done')
  ok(Boolean(doneLine), 'done 事件必须可解析')
  ok(doneLine.text === 'Hi there', `done 事件必须带完整文本, 实际 ${JSON.stringify(doneLine?.text)}`)

  // completed 里的 output 也要有内容(非增量消费读它)
  const completed = out
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6))
      } catch {
        return null
      }
    })
    .find((d) => d && String(d.type).startsWith('response.completed'))
  ok(Boolean(completed), 'completed 事件必须可解析')
  ok(
    completed.response.output.length === 1 &&
      completed.response.output[0].content[0].text === 'Hi there',
    'completed 必须带完整 output',
  )
}

// ── ③b 流式工具调用: item 与收尾都要带 name/arguments ─────────────
{
  const state: any = { seq: 0, textStarted: false, itemSeq: 0 }
  let out = ''
  out += sseEventsFromChatChunk(
    {
      id: 'c1',
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_y', function: { name: 'bash', arguments: '{"comm' } },
            ],
          },
        },
      ],
    },
    state,
  )
  out += sseEventsFromChatChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
    state,
  )
  out += sseEventsFromChatChunk({ choices: [{ finish_reason: 'tool_calls' }] }, state)
  out += sseFinalEvents(state)

  const events = out
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6))
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const added = events.find((e) => e.type === 'response.output_item.added')
  ok(added?.item?.type === 'function_call', '工具调用首片要发 function_call item')
  ok(added?.item?.call_id === 'call_y', 'item 的 call_id 要保留')

  const doneFc = events.find(
    (e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call',
  )
  ok(Boolean(doneFc), '收尾要有 function_call 的 item.done')
  ok(doneFc.item.name === 'bash', '收尾 item 必须带 name')
  ok(
    doneFc.item.arguments === '{"command":"ls"}',
    `收尾 item 必须带完整 arguments, 实际 ${JSON.stringify(doneFc?.item?.arguments)}`,
  )
  ok(doneFc.item.call_id === 'call_y', '收尾 item 必须带 call_id')
}

// ── ③c 非流式聚合: SSE -> 一条 message ───────────────────────────
{
  const sse = [
    'data: {"id":"c1","choices":[{"delta":{"content":"Hi"}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_z",'
      + '"function":{"name":"bash","arguments":"{\\"a\\":1}"}}]}}]}',
    '',
    'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const agg = aggregateChatSse(sse)
  ok(agg.message.content === 'Hi', '聚合要收全文本')
  ok(agg.message.tool_calls.length === 1, '聚合要收全工具调用')
  ok(agg.message.tool_calls[0].function.name === 'bash', '工具名要聚合出来')
  ok(agg.message.tool_calls[0].function.arguments === '{"a":1}', '工具参数分片要拼接')
  ok(agg.finishReason === 'tool_calls', 'finish_reason 要取到')
  ok(agg.usage?.prompt_tokens === 3, 'usage 要取到')
}

// ── ④ 合成 req/res ───────────────────────────────────────────────
{
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
  const fakeReq: any = { headers: { authorization: 'Bearer k' }, socket: { name: 'sock' } }
  const req = syntheticChatRequest(body, fakeReq)
  ok(typeof req[Symbol.asyncIterator] === 'function', '合成 req 必须可异步迭代(链路靠 for await 读体)')
  ok(req.headers['content-type'] === 'application/json', '合成 req 要声明 JSON 体')
  ok(req.method === 'POST', '合成 req 的 method 必须是 POST')
  ok(req.socket === fakeReq.socket, 'socket 必须复用真实请求(断开检测挂在它上面)')

  const { res, captured } = createCaptureResponse()
  res.setHeader('X-Test', '1')
  ok(res.getHeader('x-test') === '1', 'setHeader/getHeader 必须按小写名工作')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.write('ab')
  res.end('cd')
  const c = captured()
  ok(c.status === 200, 'writeHead 的 status 要能取回')
  ok(c.body === 'abcd', 'write 与 end 的块要按序拼接')
  ok(res.headersSent === true, 'headersSent 必须反映已发送状态')
  ok(res.write('x') === true, 'write 必须返回 true(否则管道会等永不到来的 drain)')
}

console.log(`responses 桥接验证通过(断言 ${n} 条)`)
