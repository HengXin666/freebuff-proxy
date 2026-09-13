#!/usr/bin/env node
/**
 * 截图用 mock 上游：实现 freebuff-proxy 需要的那几个 /api/v1/* 端点，
 * 返回一份「真实感」的账号池快照（额度/Freebucks/会话/封禁都有内容）。
 *
 * 只用于生成 README 截图，绝不连真实上游、不消耗任何额度。
 * 用法: node scripts/screenshot-mock-upstream.mjs <port>
 */
import http from 'node:http'

const port = Number(process.argv[2] || 18999)
const now = Date.now()

/** Pacific 午夜（America/Los_Angeles）下一次重置时刻。 */
function nextPacificMidnight() {
  const d = new Date()
  d.setUTCHours(7, 0, 0, 0) // PDT = UTC-7
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString()
}
const RESET_AT = nextPacificMidnight()

/** 单价（FB/小时）——与上游 freebucks.prices 同口径。 */
const PRICES = {
  'deepseek/deepseek-v4-flash': 25,
  'mimo/mimo-v2.5': 10,
  'openai/gpt-5.6-luna': 20,
  'z-ai/glm-5.3-flash': 5,
  'google/gemini-3.8-flash': 50,
  'upstage/solar-pro4': 0,
}

/** 账号处境：正在调度（热 session）/ 余额偏低 / 已封禁。 */
const ACCOUNTS = {
  'tok-alice': {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'alice@example.com',
    name: 'alice',
    active: true,
    session: { model: 'deepseek/deepseek-v4-flash', remainingMs: 41 * 60_000 },
    // 余额 >= flash 单价(25) → 买得起，归「正在调度」而不是「额度不足」
    freebucks: { dailyRemaining: 25, dailyLimit: 25, balance: 25 },
  },
  'tok-bob': {
    id: '00000000-0000-4000-8000-000000000002',
    email: 'bob@example.com',
    name: 'bob',
    banned: true,
  },
  'tok-carol': {
    id: '00000000-0000-4000-8000-000000000003',
    email: 'carol@example.com',
    name: 'carol',
    active: false,
    // 余额 12：买得起最便宜模型(5 FB)但低于低额度阈值(15) → 归「低额度」
    freebucks: { dailyRemaining: 12, dailyLimit: 25, balance: 12 },
  },
}

function tokenOf(req) {
  const h = req.headers
  return h['x-codebuff-api-key'] || h['X-Codebuff-Api-Key'] ||
    String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '')
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function rateLimitFor(model) {
  const limits = { 'deepseek/deepseek-v4-flash': 6, 'mimo/mimo-v2.5': 10, 'upstage/solar-pro4': 0 }
  return {
    model,
    entitlementBreakdown: { base: 6, referral: 0, streak: 0 },
    limit: limits[model] ?? 6,
    period: 'pacific_day',
    resetTimeZone: 'America/Los_Angeles',
    resetAt: RESET_AT,
    windowHours: 24,
    recentCount: model === 'mimo/mimo-v2.5' ? 4 : model === 'upstage/solar-pro4' ? 0 : 2,
    pool: model === 'upstage/solar-pro4' ? 'freebucks' : 'limited',
    poolLabel: model === 'upstage/solar-pro4' ? '免费' : '池空',
  }
}

/** 会话 + freebucks 载荷；banned 账号返回 403 body。 */
function sessionPayload(acct) {
  if (acct.banned) {
    return { status: 'banned', message: 'This account has been banned from free mode.' }
  }
  const model = acct.session?.model || 'deepseek/deepseek-v4-flash'
  const fb = acct.freebucks || { dailyRemaining: 0, dailyLimit: 0, balance: 0 }
  const active = Boolean(acct.active)
  const payload = {
    status: active ? 'active' : 'none',
    accessTier: 'full',
    freebucks: {
      balance: fb.balance,
      daily: { limit: fb.dailyLimit, spent: fb.dailyLimit - fb.dailyRemaining, remaining: fb.dailyRemaining, resetAt: RESET_AT },
      resetAt: RESET_AT,
      resetTimeZone: 'America/Los_Angeles',
      prices: PRICES,
    },
    rateLimitsByModel: {
      'deepseek/deepseek-v4-flash': rateLimitFor('deepseek/deepseek-v4-flash'),
      'mimo/mimo-v2.5': rateLimitFor('mimo/mimo-v2.5'),
      'upstage/solar-pro4': rateLimitFor('upstage/solar-pro4'),
    },
  }
  if (!active) return payload
  return {
    ...payload,
    instanceId: 'inst-' + acct.name,
    model,
    admittedAt: new Date(now - 19 * 60_000).toISOString(),
    expiresAt: new Date(now + acct.session.remainingMs).toISOString(),
    remainingMs: acct.session.remainingMs,
    rateLimit: rateLimitFor(model),
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const p = u.pathname
  const acct = ACCOUNTS[tokenOf(req)]

  if (p === '/api/v1/me') {
    if (!acct) return json(res, { error: 'unauthorized' }, 401)
    return json(res, { id: acct.id, email: acct.email, name: acct.name })
  }
  if (p === '/api/v1/freebuff/session') {
    if (!acct) return json(res, { error: 'unauthorized' }, 401)
    const payload = sessionPayload(acct)
    if (acct.banned) return json(res, payload, 403)
    if (req.method === 'DELETE') return json(res, { status: 'ended' })
    return json(res, payload)
  }
  if (p === '/api/v1/agent-runs') {
    if (!acct) return json(res, { error: 'unauthorized' }, 401)
    return json(res, { runId: '00000000-0000-4000-8000-0000000000ff' })
  }
  if (p === '/api/v1/chat/completions') {
    if (!acct) return json(res, { error: 'unauthorized' }, 401)
    const reply =
      '我是 Buffy，跑在 Freebuff 免费模式上的编码助手。\n\n' +
      '我可以读写代码、执行命令、查资料。当前会话由 freebuff-proxy 转发，' +
      '账号池会自动挑选可用的免费账号并复用热 session。'
    if (req.method !== 'POST') return json(res, { error: 'method' }, 405)
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let stream = false
      try { stream = Boolean(JSON.parse(raw).stream) } catch {}
      if (!stream) {
        return json(res, {
          id: 'chatcmpl-demo',
          object: 'chat.completion',
          model: 'deepseek/deepseek-v4-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const enc = (o) => 'data: ' + JSON.stringify(o) + '\n\n'
      res.write(enc({ id: 'chatcmpl-demo', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] }))
      for (const chunk of reply.match(/[\s\S]{1,12}/g) || []) {
        res.write(enc({ id: 'chatcmpl-demo', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunk } }] }))
      }
      res.write(enc({ id: 'chatcmpl-demo', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  return json(res, { error: 'not_found', path: p }, 404)
})

server.listen(port, '127.0.0.1', () => {
  console.log('[mock-upstream] listening on http://127.0.0.1:' + port)
})