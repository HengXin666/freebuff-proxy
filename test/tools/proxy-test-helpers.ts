/**
 * 真实 HTTP mock 上游(供"真实代理链路"测试使用).
 *
 * 复用 smoke.mjs 的模块级计数器与 mockMode;通过 opts 传入闭包共享.
 * 行为与 smoke.mjs 全局 fetch mock 的 ok/hold_once 路径保持一致.
 *
 * 实现已按端点拆进 ./test/helpers/mock-routes.ts;本文件是薄门面,
 * 所以 test/smoke.mjs 的 './proxy-test-helpers.ts' 调用面完全不变.
 */
import http from 'node:http'
import {
  handleAdmission,
  handleAgentRuns,
  handleChatCompletions,
  handleSession,
  makeJson,
} from '../helpers/mock-routes.ts'

/**
 * @param {{sessionPosts: () => number, bumpSessionPosts: () => void,
 *   bumpSessionDeletes: () => void, completionAttempts: () => number,
 *   bumpCompletionAttempts: () => void, getMockMode: () => string,
 *   holdStreamControllers: unknown[]}} state 共享状态
 * @returns {Promise<{server: import('node:http').Server, port: number}>} mock 上游地址
 */
export async function createMockUpstreamServer(state) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const raw = Buffer.concat(chunks)
      const bodyText = raw.length ? raw.toString('utf8') : ''
      const u = new URL(req.url, 'http://x')
      const method = req.method || 'GET'
      const path = u.pathname
      const json = makeJson(res)
      const ctx = { state, json, req, res, method, path, bodyText }
      try {
        if (path === '/api/v1/me') {
          return json({ id: 'u1', email: 'a@b.c' })
        }
        if (handleAdmission(ctx)) return
        if (handleSession(ctx)) return
        if (handleAgentRuns(ctx)) return
        if (handleChatCompletions(ctx)) return
        json({ error: 'unexpected ' + path }, 500)
      } catch (err) {
        json({ error: String(err) }, 500)
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

/**
 * 最小 HTTP 转发代理:把绝对形式请求转发到目标主机(供"真实代理链路"测试).
 * @returns {Promise<{server: import('node:http').Server, port: number}>} 代理地址
 */
export async function createForwardProxy() {
  const server = http.createServer((req, res) => {
    let target
    try {
      target = new URL(req.url, 'http://x')
    } catch {
      res.writeHead(400)
      return res.end('bad proxy url')
    }
    const proxyReq = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end('proxy error')
    })
    req.pipe(proxyReq)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

/**
 * 把一个 web 流整块读成 Buffer.
 * @param {ReadableStream} stream 流
 * @returns {Promise<Buffer>} 全部字节
 */
export async function streamToBuffer(stream) {
  const reader = stream.getReader()
  const parts = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(Buffer.from(value))
  }
  return Buffer.concat(parts)
}
