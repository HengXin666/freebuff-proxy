import http from 'node:http'

/**
 * 真实 HTTP mock 上游（供"真实代理链路"测试使用）：
 * 复用 smoke.mjs 的模块级计数器与 mockMode；通过 opts 传入闭包共享。
 * 行为与 smoke.mjs 全局 fetch mock 的 ok/hold_once 路径保持一致。
 * @param {{ sessionPosts: () => number, bumpSessionPosts: () => void, bumpSessionDeletes: () => void, completionAttempts: () => number, bumpCompletionAttempts: () => void, getMockMode: () => string, holdStreamControllers: unknown[] }} state
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
      const json = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      try {
        if (path === '/api/v1/me') {
          return json({ id: 'u1', email: 'a@b.c' })
        }
        if (path === '/api/v1/freebuff/session' && method === 'POST') {
          state.bumpSessionPosts()
          const model = req.headers['x-freebuff-model'] || 'deepseek/deepseek-v4-flash'
          const rateLimit = {
            model,
            entitlementBreakdown: { base: 6, referral: 0, streak: 0 },
            limit: 6,
            period: 'pacific_day',
            resetTimeZone: 'America/Los_Angeles',
            resetAt: '2026-08-09T07:00:00.000Z',
            windowHours: 24,
            recentCount: 1,
          }
          return json({
            status: 'active',
            instanceId: 'inst-' + state.sessionPosts(),
            model,
            admittedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            remainingMs: 3600_000,
            accessTier: 'full',
            rateLimit,
            rateLimitsByModel: { [model]: rateLimit },
          })
        }
        if (path === '/api/v1/freebuff/session' && method === 'GET') {
          return json({ status: 'none', accessTier: 'full' })
        }
        if (path === '/api/v1/freebuff/session' && method === 'DELETE') {
          state.bumpSessionDeletes()
          return json({ status: 'none' })
        }
        if (path === '/api/v1/agent-runs' && method === 'POST') {
          const body = JSON.parse(bodyText || '{}')
          if (body.action === 'START') {
            return json({ runId: '00000000-0000-4000-8000-000000000001' })
          }
          return json({ ok: true })
        }
        if (path === '/api/v1/chat/completions') {
          const body = JSON.parse(bodyText || '{}')
          state.bumpCompletionAttempts()
          if (state.getMockMode() === 'hold_once' && state.completionAttempts() === 1 && body.stream) {
            // 先发响应头 + 首 chunk，保持连接打开（模拟长流），
            // 由测试通过 state.holdResponses 显式释放（写 [DONE] 并结束）。
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n')
            state.holdResponses.push(res)
            return
          }
          if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.end('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
            return
          }
          return json({
            id: 'c1',
            object: 'chat.completion',
            choices: [{ message: { role: 'assistant', content: 'hi' } }],
          })
        }
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
 * 最小 HTTP 转发代理：把绝对形式请求转发到目标主机（供"真实代理链路"测试）。
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

async function streamToBuffer(stream) {
  const reader = stream.getReader()
  const parts = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(Buffer.from(value))
  }
  return Buffer.concat(parts)
}
