/**
 * 网页通道 transport —— Freebuff 网页端（freebuff.com）的 /api/chat/stream。
 *
 * 为什么需要第二条通道：`accessTier: 'limited'`（非 allowlist 国家 / 任何 VPN）
 * 下，CLI 通道 `POST codebuff.com/api/v1/chat/completions` 对全部 limited 目录
 * 模型返回 503 "The model is temporarily unavailable"。而**同一账号、同一出口
 * IP**换网页通道完全正常 —— 所以那是通道选择问题，不是 IP 问题。
 *
 * 协议形态全部来自线上实测（官方公共仓库不含 `web/` 目录）：
 *   POST https://freebuff.com/api/chat/stream
 *   Cookie: __Secure-next-auth.session-token=<authToken>
 *   body: { threadId, content, model, reasoningEffort, images, attachments }
 *   响应: SSE，事件 meta / reasoning_delta / delta / suggestions / title / done
 *
 * ⚠️ cookie 名必须带 `__Secure-` 前缀。实测 `next-auth.session-token`（无前缀）
 * 与 `Authorization: Bearer` 都返回 401 "Please sign in to chat"。
 *
 * 判据与取舍见
 * .agents/notes/proposed/architecture/2026-09-30-web-chat-stream-transport.md
 */
import { logger } from '../util/log.js'

/** 网页通道的会话 cookie 名（带 __Secure- 前缀才是线上真值）。 */
export const WEB_SESSION_COOKIE = '__Secure-next-auth.session-token'

/** 网页端模型 id 没有供应商前缀（deepseek-v4-flash）。 */
export function toWebModelId(modelId) {
  if (typeof modelId !== 'string') return modelId
  const idx = modelId.indexOf('/')
  return idx > 0 ? modelId.slice(idx + 1) : modelId
}

/** 反方向：deepseek-v4-flash → deepseek/deepseek-v4-flash（按已知目录还原）。 */
export function fromWebModelId(webId, knownIds = []) {
  if (typeof webId !== 'string') return webId
  if (webId.includes('/')) return webId
  const hit = knownIds.find((id) => id.endsWith('/' + webId))
  return hit || webId
}

/** SSE 事件类型（实测全集）。 */
export const WEB_EVENT_TYPES = [
  'meta',
  'reasoning_delta',
  'delta',
  'suggestions',
  'title',
  'done',
]

/**
 * 把 OpenAI 的 messages 映射成网页通道的 { threadId, content }。
 *
 * 网页通道的多轮靠**服务端 threadId**（实测 R1 说名字、R2 能答出），
 * 不是靠客户端重发历史。所以只取最后一条 user 消息作为 content，
 * 历史不重发 —— 重发反而会与服务端已有线程重复。
 *
 * @param {{ threadId?: string|null, messages: Array<{role:string,content:any}> }} params
 * @returns {{ threadId: string|null, content: string }}
 */
export function toWebChatRequest({ threadId, messages }) {
  const list = Array.isArray(messages) ? messages : []
  let content = ''
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m && m.role === 'user') {
      content = extractText(m.content)
      break
    }
  }
  return { threadId: threadId || null, content }
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * 网页通道的鉴权头（cookie 形态）。
 * @param {string} token CLI/网页签发的 authToken
 * @returns {Record<string,string>}
 */
export function webChatHeaders(token) {
  return {
    'content-type': 'application/json',
    cookie: `${WEB_SESSION_COOKIE}=${token};`,
  }
}

/**
 * 解析 /api/chat/stream 的 SSE 流，产出归一化的增量事件。
 *
 * 用法：拿到 fetch 的 ReadableStream 后喂进来，逐条回调。
 * @param {AsyncIterable<Uint8Array>} body
 * @param {(ev: { type: string, [k: string]: any }) => void} onEvent
 * @returns {Promise<{ threadId: string|null, text: string, reasoning: string, done: boolean }>}
 */
export async function consumeWebStream(body, onEvent) {
  const decoder = new TextDecoder()
  let buf = ''
  let threadId = null
  let text = ''
  let reasoning = ''
  let done = false

  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') {
        if (payload === '[DONE]') done = true
        continue
      }
      let ev
      try {
        ev = JSON.parse(payload)
      } catch {
        continue
      }
      if (!ev || typeof ev !== 'object') continue
      if (ev.type === 'meta' && ev.threadId) threadId = ev.threadId
      if (ev.type === 'delta' && typeof ev.text === 'string') text += ev.text
      if (ev.type === 'reasoning_delta' && typeof ev.text === 'string') {
        reasoning += ev.text
      }
      if (ev.type === 'done') done = true
      try {
        onEvent?.(ev)
      } catch {
        // 回调异常不应中断解析
      }
    }
  }
  // 收尾：残留缓冲区里可能还有一条未换行结尾的事件
  const tail = buf.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload && payload !== '[DONE]') {
      try {
        const ev = JSON.parse(payload)
        if (ev?.type === 'meta' && ev.threadId) threadId = ev.threadId
        if (ev?.type === 'delta' && typeof ev.text === 'string') text += ev.text
        if (ev?.type === 'done') done = true
        onEvent?.(ev)
      } catch {
        /* ignore */
      }
    }
  }
  if (!done) {
    logger.debug('web stream ended without done event', { threadId })
  }
  return { threadId, text, reasoning, done }
}
