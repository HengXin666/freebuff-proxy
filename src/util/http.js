import { randomUUID } from 'node:crypto'

export function readBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization
  if (!header || typeof header !== 'string') return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

export async function readRequestBody(req, limitBytes = 32 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) {
      const err = new Error('Request body too large')
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

/**
 * SDK-faithful 13-char base36 client id（对齐官方 CLI：
 * `Math.random().toString(36).substring(2, 15)`）。
 *
 * 风控关键：上游 cf-worker-signals.ts 的 looksLikeProxyClientId 会把
 * `sess:`/`run:` 前缀、`wf-<8hex>` 等自定义形态指纹为代理客户端。
 * 绝不能带 freebuff-proxy 等自有前缀——必须长得像官方 SDK 随机 id。
 * @returns {string} 13 位 base36
 */
export function generateClientId() {
  // 每字符 0-9a-z；36^13 ≈ 1.7e20，与 Math.random() 双精度 53 位随机
  // 粒度对齐即可（官方也是 Math.random 伪随机，非加密）。
  let out = ''
  for (let i = 0; i < 13; i++) {
    out += Math.floor(Math.random() * 36).toString(36)
  }
  return out
}

export function newIds() {
  return {
    runId: randomUUID(),
    clientId: generateClientId(),
  }
}

export function filterRequestHeaders(headers) {
  const skip = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'authorization',
    // hop-by-hop
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'upgrade',
    // 代理/自动化识别头（对齐 trefeon stealth.SanitizeHeaders proxyHeaders）：
    // 真实客户端从不发这些；下游若带（ingress 反代/代理链注入），透传上游
    // 就是自报代理身份，必须剥离。
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-forwarded-host',
    'x-real-ip',
    'x-proxy-user-ip',
    'via',
    'x-via',
    'proxy-connection',
    'x-proxy-agent',
    'x-request-id',
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-ray',
    'cf-visitor',
    'true-client-ip',
    'x-originating-ip',
    'x-remote-ip',
    'x-remote-addr',
    'x-client-ip',
    'x-host',
    'x-correlation-id',
    'x-trace-id',
    'x-amzn-trace-id',
    'x-cache',
    'x-served-by',
  ])
  /** @type {Record<string, string>} */
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue
    const key = k.toLowerCase()
    if (skip.has(key)) continue
    if (key.startsWith('x-freebuff-proxy-')) continue
    out[key] = Array.isArray(v) ? v.join(',') : String(v)
  }
  return out
}

export function filterResponseHeaders(headers) {
  const skip = new Set([
    'connection',
    'transfer-encoding',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'content-encoding', // we may re-stream raw; undici usually decodes
  ])
  /** @type {Record<string, string>} */
  const out = {}
  headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (skip.has(k)) return
    out[k] = value
  })
  return out
}

export function parseCookies(header) {
  const out = {}
  if (!header || typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`)
  if (opts.path) parts.push(`Path=${opts.path}`)
  if (opts.httpOnly !== false) parts.push('HttpOnly')
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`)
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}
