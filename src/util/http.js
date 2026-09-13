import { randomUUID } from 'node:crypto'

export function readBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization
  if (!header || typeof header !== 'string') return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

/**
 * 读取请求体。
 *
 * **必须有超时**：客户端/SDK 声明了 Content-Length 却中途停止发送（进程被杀、
 * 网络中断、连接半开）时，`for await (const chunk of req)` 会永远不返回。
 * 这个 await 发生在全局请求闸门**已经占住槽位之后**，于是每来这样一个请求就
 * 永久吃掉一个并发名额；攒满 maxConcurrentRequests 个之后，整个服务不再接单，
 * 而进程 CPU/日志/控制台完全正常——只有重启才恢复。超时即放弃该请求（408），
 * 让槽位归还。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limitBytes]
 * @param {number} [timeoutMs] <=0 表示不设超时（仅测试用）
 */
export async function readRequestBody(
  req,
  limitBytes = 32 * 1024 * 1024,
  timeoutMs = 0,
) {
  const chunks = []
  let total = 0
  let timer = null
  let timedOut = false
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      // 摧毁连接，让 for-await 立刻以 'aborted'/'error' 结束，而不是继续干等。
      req.destroy(new Error('request body read timeout'))
    }, timeoutMs)
    if (timer.unref) timer.unref()
  }
  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > limitBytes) {
        const err = new Error('Request body too large')
        err.statusCode = 413
        throw err
      }
      chunks.push(chunk)
    }
  } catch (err) {
    if (timedOut) {
      const e = new Error('Request body read timeout')
      e.statusCode = 408
      e.code = 'body_read_timeout'
      throw e
    }
    // 客户端在读 body 期间断开（SDK 取消/超时自杀）：不是服务端故障，
    // 标记成 400 让上层安静收场——不要当成 unhandled error 打 error 级日志。
    if (
      err &&
      (err.code === 'ECONNRESET' ||
        err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        err.message === 'aborted')
    ) {
      const e = new Error('Client aborted while sending request body')
      e.statusCode = 400
      e.code = 'client_aborted'
      throw e
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
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
    'cf-worker',
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
    // x-freebuff-* 由代理自己按官方 CLI 形态设置（session POST 带 model、
    // GET/DELETE 带 instance id、chat 两者都不带）。下游客户端若自带这些头，
    // 透传上游就是"代理形态"指纹（参考项目 ADR-0012 反封控契约）。
    if (key.startsWith('x-freebuff-')) continue
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
