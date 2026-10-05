/**
 * /v1/responses ---- Responses 协议的入口(常见协议, 下游 harness 在用).
 *
 * 做法: 翻成 chat 请求 -> 用合成 req/res 驱动同一个 chatHandler -> 把它的输出
 * 翻回 Responses. 会话调度/账号锁/换号重试/上游形态/工具承载全在 chat 那条链上,
 * 复制第二份必然漂移, 所以这里不重写链路, 只做协议翻译.
 *
 * 协议真值取自 dsh 自身实现(@earendil-works/pi-ai 的 openai-responses):
 * 请求 /v1/responses 带 model / input / stream / store 与扁平 tools;
 * 响应是 output 数组, 工具调用是 function_call item.
 *
 * 上游只有 /api/v1/chat/completions(见 docs/reverse/20 白名单), 因此这里
 * 是纯协议适配, 不引入任何新的上游请求.
 */
import { sendJson } from '../../../util/http.ts'
import { readRequestBody } from '../../../util/http.ts'
import { logger } from '../../../util/log.ts'
import { createCaptureResponse, syntheticChatRequest } from './capture.ts'
import { chatRequestFromResponses } from './request.ts'
import { aggregateChatSse, buildResponsesPayload } from './translate.ts'
import { sseEventsFromChatChunk, sseFinalEvents } from './stream.ts'

/**
 * 把 chat 链路写出的响应翻成 Responses 形态并下发.
 *
 * @param {any} res 真实下游响应
 * @param {{ status: number, headers: Record<string, any>, body: string }} captured chat 链路产出
 * @param {{ stream: boolean, model?: string }} opts 本次请求形态
 * @returns {void} 无返回值
 */
function relayChatAsResponses(res: any, captured: any, opts: any) {
  const upstreamErr = captured.status >= 400
  if (upstreamErr) {
    // 错误体沿用 chat 侧的结构(下游按 message 展示), 只把 HTTP 码透传.
    // 这里刻意不翻译成 Responses 的 error 形状: chat 链路已经给出可读原因,
    // 再包一层只会把真实原因埋掉.
    sendJson(res, captured.status, safeJson(captured.body))
    return
  }
  if (opts.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const state: any = { seq: 0, textStarted: false, itemSeq: 0 }
    let text = ''
    for (const line of String(captured.body || '').split('\n')) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (!payload || payload === '[DONE]') continue
      let chunk: any
      try {
        chunk = JSON.parse(payload)
      } catch {
        continue
      }
      const events = sseEventsFromChatChunk(chunk, state)
      if (events) text += events
    }
    text += sseFinalEvents(state)
    res.end(text)
    return
  }
  const agg = aggregateChatSse(captured.body || '')
  sendJson(
    res,
    200,
    buildResponsesPayload({
      id: agg.id ? `resp_${agg.id}` : undefined,
      model: opts.model,
      message: agg.message,
      finishReason: agg.finishReason,
      usage: agg.usage,
    }),
  )
}

/**
 * JSON 文本安全解析(解析失败时原样包成 error 结构, 不抛).
 *
 * @param {string} text 响应体文本
 * @returns {any} 解析结果
 */
function safeJson(text: any) {
  try {
    return JSON.parse(String(text || '{}'))
  } catch {
    return { error: { message: String(text || ''), type: 'upstream_error' } }
  }
}

/**
 * 处理一次 Responses 请求.
 *
 * @param {any} chatHandler 既有 chat 处理器(由 proxy.ts 注入, 与它同址避免成环)
 * @param {any} req 下游请求
 * @param {any} res 下游响应
 * @param {number} [timeoutMs] 读体上限(毫秒, 0 = 不设)
 * @returns {Promise<void>} 无返回值
 */
export async function handleResponses(
  chatHandler: any,
  req: any,
  res: any,
  timeoutMs = 0,
) {
  let raw: any
  try {
    raw = await readRequestBody(req, undefined, timeoutMs)
  } catch (err: any) {
    if (err?.code === 'client_aborted') return
    const status = err?.statusCode === 413 ? 413 : 408
    sendJson(res, status, {
      error: {
        message:
          status === 413 ? 'Request body too large' : 'Timed out reading request body',
        type: 'invalid_request_error',
      },
    })
    return
  }
  let body: any
  try {
    body = JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    sendJson(res, 400, {
      error: { message: 'Invalid JSON body', type: 'invalid_request_error' },
    })
    return
  }

  const translated = chatRequestFromResponses(body)
  logger.info('responses request translated to chat', {
    model: translated.body?.model,
    messages: translated.body?.messages?.length ?? 0,
    tools: Array.isArray(translated.body?.tools) ? translated.body.tools.length : 0,
    stream: translated.stream,
  })

  // 合成 req/res 必须成对使用: chat 链路从 req 读体, 往 res 写响应.
  const syntheticReq = syntheticChatRequest(JSON.stringify(translated.body), req)
  const { res: capture, captured } = createCaptureResponse()
  try {
    await chatHandler(syntheticReq, capture)
  } catch (err: any) {
    logger.warn('responses: chat chain threw', {
      error: err instanceof Error ? err.message : String(err),
    })
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: 'upstream_error',
        },
      })
    }
    return
  }
  const result = captured()
  logger.info('responses: chat chain replied', {
    status: result.status,
    bytes: result.body.length,
  })
  relayChatAsResponses(res, result, {
    stream: translated.stream,
    model: translated.body?.model,
  })
}
