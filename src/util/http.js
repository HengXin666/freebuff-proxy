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

export function newIds() {
  return {
    runId: randomUUID(),
    clientId: `freebuff-proxy-${randomUUID().slice(0, 8)}`,
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
