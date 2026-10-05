/**
 - 线路小工具: JSON 响应 + SSE 聚合 -- 从 cli-bridge/serve.ts 逐字搬出后合并.
 - 两者都是"进出的字节形态"处理, 放在一处便于对照.
 */

/**
 - 写一个 JSON 响应(含正确的 content-length).
 - @param {import('node:http').ServerResponse} res 响应对象
 - @param {number} code HTTP 状态码
 - @param {any} obj 响应体(会被 JSON.stringify)
 * @returns {void} 无返回值
 */
export function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 - 把上游的 SSE 流式响应聚合成一次性结果.
 - @param {string} text SSE 原文
 - @returns {{ content: string, toolCalls: any[], id: string|null, reasoning: string }|null} 聚合结果;不是 SSE(或无有效块)时返回 null
 */
export function aggregateSse(text) {
  const src = String(text || '');
  if (!src.includes('data:') && !src.startsWith('{')) return null
  let content = ''
  let reasoning = ''
  let id = null
  /** @type {any[]} */
  const toolCalls = []
  let sawChunk = false
  for (const line of src.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let j = null
    try { j = JSON.parse(payload) } catch { continue }
    if (!j || typeof j !== 'object') continue
    sawChunk = true
    if (j.id && !id) id = j.id
    for (const c of j.choices || []) {
      const d = c.delta || {}
      if (typeof d.content === 'string') content += d.content
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? toolCalls.length
          if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (tc.id) toolCalls[i].id = tc.id
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
        }
      }
    }
  }
  if (!sawChunk) return null
  return { content, toolCalls: toolCalls.filter(Boolean), id, reasoning }
}
