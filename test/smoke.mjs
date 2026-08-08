import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { AccountRuntimes } from '../src/app-context.js'
import { startServer } from '../src/server.js'
import { configureLogger } from '../src/util/log.js'
import { requireModelId } from '../src/model.js'
import { saveAccountUser } from '../src/auth-store.js'
import {
  ensureFreebuffSystemMessages,
  normalizeReasoningFields,
  FREEBUFF_SYSTEM_OPENING,
} from '../src/free-mode.js'
import {
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
} from '../src/upstream/client.js'
import { extractConversationKey } from '../src/proxy.js'

configureLogger({ level: 'error' })

const originalFetch = globalThis.fetch
let calls = []
/** @type {'ok' | 'gate_once' | 'rate_limit_a' | 'rate_limit_completion'} */
let mockMode = 'ok'
let sessionPosts = 0
let completionAttempts = 0

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.includes('127.0.0.1') || u.includes('localhost')) {
    return originalFetch(url, init)
  }
  const method = (init.method || 'GET').toUpperCase()
  const headers = init.headers || {}
  calls.push({ url: u, method, headers, body: init.body })

  if (u.includes('/api/v1/me')) {
    return jsonRes({ id: 'u1', email: 'a@b.c' })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'POST') {
    sessionPosts++
    const model =
      headers['x-freebuff-model'] ||
      headers['X-Freebuff-Model'] ||
      'deepseek/deepseek-v4-flash'
    // Multi-account: token-a is rate-limited on admit
    const auth =
      headers.Authorization ||
      headers.authorization ||
      headers['x-codebuff-api-key'] ||
      ''
    if (mockMode === 'rate_limit_a' && String(auth).includes('token-a')) {
      return jsonRes(
        {
          status: 'rate_limited',
          message: 'quota',
          retryAfterMs: 60_000,
        },
        429,
      )
    }
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
    return jsonRes({
      status: 'active',
      instanceId: `inst-${sessionPosts}`,
      model,
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      remainingMs: 3600_000,
      accessTier: 'full',
      rateLimit,
      rateLimitsByModel: { [model]: rateLimit },
    })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'GET') {
    return jsonRes({ status: 'none', accessTier: 'full' })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'DELETE') {
    return jsonRes({ status: 'none' })
  }
  if (u.includes('/api/v1/agent-runs') && method === 'POST') {
    const body = JSON.parse(init.body || '{}')
    if (body.action === 'START') {
      return jsonRes({ runId: '00000000-0000-4000-8000-000000000001' })
    }
    if (body.action === 'FINISH') {
      return jsonRes({ ok: true })
    }
    return jsonRes({ error: 'bad action' }, 400)
  }
  if (u.includes('/api/v1/chat/completions')) {
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'deepseek/deepseek-v4-flash')
    assert.equal(body.codebuff_metadata.cost_mode, 'free')
    assert.ok(body.codebuff_metadata.freebuff_instance_id)
    assert.equal(
      body.codebuff_metadata.run_id,
      '00000000-0000-4000-8000-000000000001',
    )
    assert.ok(Array.isArray(body.messages))
    assert.equal(body.messages[0].role, 'system')
    assert.ok(
      String(body.messages[0].content).startsWith(FREEBUFF_SYSTEM_OPENING),
    )
    const userMsg = body.messages.find((m) => m.role === 'user')
    assert.equal(userMsg?.content, 'hello')
    assert.ok(headers.Authorization || headers.authorization)
    assert.ok(headers['x-codebuff-api-key'] || headers['X-Codebuff-Api-Key'])

    completionAttempts++
    // First completion fails with recoverable gate; second succeeds.
    if (mockMode === 'gate_once' && completionAttempts === 1) {
      return jsonRes(
        { error: 'session_superseded', message: 'taken over' },
        409,
      )
    }
    // Account a is free-mode rate limited at the completions layer (not admit).
    const compAuth =
      headers.Authorization ||
      headers.authorization ||
      headers['x-codebuff-api-key'] ||
      ''
    if (
      mockMode === 'rate_limit_completion' &&
      String(compAuth).includes('token-a')
    ) {
      return jsonRes(
        {
          error: 'free_mode_rate_limited',
          message:
            'Free mode rate limit exceeded (30 minutes limit). Try again in 1 minute.',
        },
        429,
        { 'retry-after': '60' },
      )
    }

    if (body.stream) {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(
            enc.encode(
              'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n',
            ),
          )
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return jsonRes({
      id: 'c1',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
    })
  }
  return jsonRes({ error: 'unexpected ' + u }, 500)
}

function jsonRes(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

// --- unit: free-mode helpers ---
{
  const msgs = ensureFreebuffSystemMessages([
    { role: 'user', content: 'hi' },
  ])
  assert.equal(msgs[0].role, 'system')
  assert.ok(msgs[0].content.startsWith(FREEBUFF_SYSTEM_OPENING))

  const already = ensureFreebuffSystemMessages([
    { role: 'system', content: `${FREEBUFF_SYSTEM_OPENING}\nextra` },
    { role: 'user', content: 'x' },
  ])
  assert.equal(already[0].content, `${FREEBUFF_SYSTEM_OPENING}\nextra`)

  const prefixed = ensureFreebuffSystemMessages([
    { role: 'system', content: 'Be brief.' },
  ])
  assert.ok(prefixed[0].content.startsWith(FREEBUFF_SYSTEM_OPENING))
  assert.match(prefixed[0].content, /Be brief/)

  const r = normalizeReasoningFields({
    reasoning_effort: 'max',
    reasoning: { effort: 'low', other: 1 },
  })
  assert.equal(r.reasoning_effort, undefined)
  assert.equal(r.reasoning.effort, 'high')
  assert.equal(r.reasoning.other, 1)
}

// --- unit: gate helpers ---
{
  assert.equal(
    extractGateError({ error: 'session_superseded' }, 409),
    'session_superseded',
  )
  assert.equal(isSessionRecoverableGate('session_superseded'), true)
  assert.equal(isSessionRecoverableGate('session_expired'), true)
  assert.equal(isSessionRecoverableGate('nope'), false)

  // account-level rate-limit codes (chat completions 429) → switch account
  assert.equal(
    extractRateLimitError({ error: 'free_mode_rate_limited' }),
    'free_mode_rate_limited',
  )
  assert.equal(
    extractRateLimitError({ error: { code: 'rate_limited' } }),
    'rate_limited',
  )
  assert.equal(extractRateLimitError({ code: 'spend_limited' }), 'spend_limited')
  assert.equal(extractRateLimitError({ status: 'ip_capped' }), 'ip_capped')
  assert.equal(extractRateLimitError({ error: 'session_superseded' }), null)
  assert.equal(extractRateLimitError({ error: 'free_mode_cli_required' }), null)
  assert.equal(extractRateLimitError(null), null)
}

// --- unit: 会话 key 提取（conversation_id / thread_id 优先于恒定的 client_id） ---
{
  const mk = (meta, extra = {}) => ({ codebuff_metadata: meta, ...extra })
  assert.equal(
    extractConversationKey(
      mk({ client_id: 'install-1', conversation_id: 'conv-a' }),
      {},
    ),
    'conv-a',
  )
  assert.equal(
    extractConversationKey(mk({ client_id: 'install-1', thread_id: 'thread-b' }), {}),
    'thread-b',
  )
  // client_id（安装 ID，恒定）不参与会话 key，否则所有会话共享同一个 key
  assert.equal(extractConversationKey(mk({ client_id: 'install-1' }), {}), null)
  assert.equal(extractConversationKey({ conversation_id: 'cv' }, {}), 'cv')
  assert.equal(extractConversationKey({}, { 'x-conversation-id': 'xc' }), 'xc')
  // user（终端用户标识，sub2api 等转换层常传恒定值）不作为会话 key
  assert.equal(extractConversationKey({ user: 'u1' }, {}), null)
  assert.equal(extractConversationKey({}, {}), null)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-'))
saveAccountUser(tmpDir, {
  id: 'u1',
  email: 'smoke@example.com',
  name: 'Smoke',
  authToken: 'token-smoke-1',
})

const config = loadConfig()
config.server.host = '127.0.0.1'
config.server.port = 0
config.server.apiKeys = ['sk-test']
config.upstream.credentialsDir = tmpDir
config.session.pollIntervalSec = 3600
config.limits.maxConcurrentRequests = 2

const runtimes = new AccountRuntimes(config)
const server = await startServer({
  config,
  runtimes,
  ...(() => {
    const rt = runtimes.getAny()
    return {
      authToken: rt.authToken,
      authSource: rt.source,
      authEmail: rt.email,
      upstream: rt.upstream,
      sessions: rt.sessions,
    }
  })(),
})
const port = server.address().port
const base = `http://127.0.0.1:${port}`

function chat(body, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

// model required
{
  const res = await chat({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(res.status, 400)
  const j = await res.json()
  assert.equal(j.error.code, 'model_required')
}

// happy path non-stream
{
  calls = []
  sessionPosts = 0
  completionAttempts = 0
  mockMode = 'ok'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    temperature: 0.2,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  const j = await res.json()
  assert.equal(j.choices[0].message.content, 'hi')
  assert.ok(
    calls.some((c) => c.url.includes('/freebuff/session') && c.method === 'POST'),
  )
  assert.ok(calls.some((c) => c.url.includes('/chat/completions')))
}

// stream
{
  mockMode = 'ok'
  completionAttempts = 0
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)
  assert.match(text, /hi/)
}

// models auth + list
{
  const res = await fetch(`${base}/v1/models`)
  assert.equal(res.status, 401)
}
{
  const res = await fetch(`${base}/v1/models`, {
    headers: { authorization: 'Bearer sk-test' },
  })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.object, 'list')
  assert.ok(j.data.length > 0)
  assert.ok(j.data.some((m) => m.id === 'openai/gpt-5.6-luna'))
}

// /api/v1 is not public
{
  const res = await fetch(`${base}/api/v1/me`, {
    headers: { authorization: 'Bearer sk-test' },
  })
  assert.equal(res.status, 404)
}

assert.equal(requireModelId('  openai/gpt-5.6-luna  '), 'openai/gpt-5.6-luna')
assert.equal(requireModelId(''), null)

// recoverable gate: exactly one re-admit (session POST again), one extra completion
{
  // Force fresh session path by releasing
  await runtimes.get('smoke@example.com').sessions.release()
  calls = []
  sessionPosts = 0
  completionAttempts = 0
  mockMode = 'gate_once'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  const j = await res.json()
  assert.equal(j.choices[0].message.content, 'hi')
  // First admit + one force re-admit on retry (not double)
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  assert.equal(completionAttempts, 2)
  mockMode = 'ok'
}

// multi-account: A rate_limited → B succeeds
{
  const multiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-multi-'))
  saveAccountUser(multiDir, {
    id: 'a',
    email: 'a@example.com',
    authToken: 'token-a',
  })
  saveAccountUser(multiDir, {
    id: 'b',
    email: 'b@example.com',
    authToken: 'token-b',
  })
  const multiConfig = loadConfig()
  multiConfig.server.host = '127.0.0.1'
  multiConfig.server.port = 0
  multiConfig.server.apiKeys = ['sk-test']
  multiConfig.upstream.credentialsDir = multiDir
  multiConfig.session.pollIntervalSec = 3600
  const multiRuntimes = new AccountRuntimes(multiConfig)
  const multiServer = await startServer({
    config: multiConfig,
    runtimes: multiRuntimes,
    ...(() => {
      const rt = multiRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const multiPort = multiServer.address().port
  mockMode = 'rate_limit_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${multiPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  // At least one failed admit (A) and one success (B)
  assert.ok(sessionPosts >= 2)
  const accounts = multiRuntimes.list()
  const a = accounts.find((x) => x.email === 'a@example.com')
  assert.equal(a.available, false)
  assert.equal(a.cooldownCode, 'rate_limited')
  // quota from admit is surfaced on the row
  const b = accounts.find((x) => x.email === 'b@example.com')
  assert.equal(b.quota.byModel['deepseek/deepseek-v4-flash'].limit, 6)
  assert.equal(b.quota.byModel['deepseek/deepseek-v4-flash'].recentCount, 1)
  // request distribution stats present
  assert.ok(b.requests >= 1)
  await multiRuntimes.shutdown()
  multiServer.close()
  fs.rmSync(multiDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// completions 返回 free_mode_rate_limited → 冷却当前账号并换号重试一次
{
  const rlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-rlcomp-'))
  saveAccountUser(rlDir, {
    id: 'a',
    email: 'a@example.com',
    authToken: 'token-a',
  })
  saveAccountUser(rlDir, {
    id: 'b',
    email: 'b@example.com',
    authToken: 'token-b',
  })
  const rlConfig = loadConfig()
  rlConfig.server.host = '127.0.0.1'
  rlConfig.server.port = 0
  rlConfig.server.apiKeys = ['sk-test']
  rlConfig.upstream.credentialsDir = rlDir
  rlConfig.session.pollIntervalSec = 3600
  const rlRuntimes = new AccountRuntimes(rlConfig)
  const rlServer = await startServer({
    config: rlConfig,
    runtimes: rlRuntimes,
    ...(() => {
      const rt = rlRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const rlPort = rlServer.address().port
  mockMode = 'rate_limit_completion'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${rlPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  // a 完成被 429 后换到 b 重试：2 次 session POST、2 次 completions
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  assert.equal(completionAttempts, 2)
  const rlAccounts = rlRuntimes.list()
  const rlA = rlAccounts.find((x) => x.email === 'a@example.com')
  assert.equal(rlA.available, false)
  assert.equal(rlA.cooldownCode, 'free_mode_rate_limited')
  // 冷却时长采用上游 retry-after（60s）
  const cd = rlRuntimes.cooldowns.get('a@example.com')
  assert.ok(
    cd.until - Date.now() >= 58_000,
    `cooldown should honor retry-after 60s, got ${cd.until - Date.now()}ms`,
  )
  // 可观测性：响应头标明实际账号；换号后是 b
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  await rlRuntimes.shutdown()
  rlServer.close()
  fs.rmSync(rlDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// cooldown: model_unavailable is per-model, not whole account
{
  const pool = new AccountRuntimes(config)
  pool.markCooldown(
    'smoke@example.com',
    { code: 'model_unavailable', retryAfterMs: 60_000 },
    'openai/gpt-5.6-luna',
  )
  assert.equal(
    pool.isCoolingDown('smoke@example.com', 'openai/gpt-5.6-luna'),
    true,
  )
  assert.equal(
    pool.isCoolingDown('smoke@example.com', 'deepseek/deepseek-v4-flash'),
    false,
  )
  pool.markCooldown('smoke@example.com', {
    code: 'banned',
    retryAfterMs: 1000,
  })
  assert.equal(pool.isCoolingDown('smoke@example.com', 'any'), true)
  const cd = pool.cooldowns.get('smoke@example.com')
  assert.ok(cd.until - Date.now() > 60_000) // banned floors to 1 day
}

// --- unit: user store + web sessions ---
{
  const { UserStore } = await import('../src/web/user-store.js')
  const { WebSessionStore } = await import('../src/web/session-store.js')
  const us = new UserStore(path.join(tmpDir, 'users.json'))
  assert.equal(us.all().length, 0)
  const u = us.create({ username: 'Alice', password: 'secret123', role: 'user' })
  assert.equal(u.username, 'alice')
  assert.ok(u.apiKey.startsWith('sk-fb-'))
  assert.equal(us.verifyPassword('alice', 'wrong'), null)
  const good = us.verifyPassword('alice', 'secret123')
  assert.equal(good.username, 'alice')
  assert.equal(us.getByApiKey(u.apiKey).username, 'alice')
  const newKey = us.resetApiKey('alice')
  assert.ok(newKey !== u.apiKey)
  us.setSticky('alice', { stickyMode: 'pin', pinnedEmail: 'a@example.com' })
  assert.equal(us.getByUsername('alice').stickyMode, 'pin')
  us.recordStickySuccess('alice', 'b@example.com') // pin mode → no learn
  assert.equal(us.getByUsername('alice').lastStickyEmail, null)
  us.setSticky('alice', { stickyMode: 'auto' })
  us.recordStickySuccess('alice', 'b@example.com')
  assert.equal(us.getByUsername('alice').lastStickyEmail, 'b@example.com')
  // persistence across instances
  const us2 = new UserStore(path.join(tmpDir, 'users.json'))
  assert.equal(us2.getByUsername('alice').lastStickyEmail, 'b@example.com')
  us2.delete('alice')
  assert.equal(us2.getByUsername('alice'), null)

  const ws = new WebSessionStore(path.join(tmpDir, 'web-sessions.json'), 60_000)
  const tok = ws.create('alice')
  assert.equal(ws.get(tok), 'alice')
  ws.destroy(tok)
  assert.equal(ws.get(tok), null)
}

// --- sticky: preferredEmail tried first, falls back when cooling ---
{
  const stickyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-sticky-'))
  saveAccountUser(stickyDir, {
    id: 'a',
    email: 'sticky-a@example.com',
    authToken: 'token-a',
  })
  saveAccountUser(stickyDir, {
    id: 'b',
    email: 'sticky-b@example.com',
    authToken: 'token-b',
  })
  const stickyConfig = loadConfig()
  stickyConfig.upstream.credentialsDir = stickyDir
  stickyConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(stickyConfig)
  mockMode = 'ok'
  sessionPosts = 0
  const rt1 = await pool.acquireForModel('deepseek/deepseek-v4-flash', {
    preferredEmail: 'sticky-b@example.com',
  })
  assert.equal(rt1.email, 'sticky-b@example.com')
  const rt2 = await pool.acquireForModel('deepseek/deepseek-v4-flash', {
    preferredEmail: 'sticky-b@example.com',
  })
  assert.equal(rt2.email, 'sticky-b@example.com')
  pool.markCooldown('sticky-b@example.com', {
    code: 'rate_limited',
    retryAfterMs: 60_000,
  })
  const rt3 = await pool.acquireForModel('deepseek/deepseek-v4-flash', {
    preferredEmail: 'sticky-b@example.com',
  })
  assert.equal(rt3.email, 'sticky-a@example.com')
  await pool.shutdown()
  fs.rmSync(stickyDir, { recursive: true, force: true })
}

// --- per-account proxy (多代理粘性: 账号绑定专属出口) ---
{
  const pDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-acc-'))
  saveAccountUser(pDir, {
    id: 'pa',
    email: 'pa@example.com',
    authToken: 'token-pa',
    proxy: 'http://127.0.0.1:7890',
  })
  saveAccountUser(pDir, { id: 'pb', email: 'pb@example.com', authToken: 'token-pb' })
  const pConfig = loadConfig()
  pConfig.upstream.credentialsDir = pDir
  pConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(pConfig)

  // runtime uses the per-account proxy
  const rtA = pool.get('pa@example.com')
  assert.equal(rtA.proxy, 'http://127.0.0.1:7890')
  assert.equal(rtA.effectiveProxy, 'http://127.0.0.1:7890')

  // rows surface proxy + effectiveProxy
  const rows = pool.list()
  const rowA = rows.find((x) => x.email === 'pa@example.com')
  assert.equal(rowA.proxy, 'http://127.0.0.1:7890')
  assert.equal(rowA.effectiveProxy, 'http://127.0.0.1:7890')
  assert.equal(rows.find((x) => x.email === 'pb@example.com').proxy, null)
  assert.equal(rows.find((x) => x.email === 'pb@example.com').effectiveProxy, null)

  // proxy change → cached runtime recreated with the new proxy
  pool.get('pa@example.com').sessions.quota = { byModel: {}, rateLimit: null, updatedAt: 'x' }
  const before = pool.get('pa@example.com')
  const file = path.join(pDir, 'pa@example.com.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.proxy = null
  fs.writeFileSync(file, JSON.stringify(raw))
  const after = pool.get('pa@example.com')
  assert.notEqual(after, before)
  assert.equal(after.proxy, null)

  // createUpstreamClient honors opts.proxy without throwing
  const { createUpstreamClient } = await import('../src/upstream/client.js')
  const cli = createUpstreamClient(pConfig, 'tok', { proxy: 'http://127.0.0.1:7890' })
  assert.ok(cli)
  await pool.shutdown()
  fs.rmSync(pDir, { recursive: true, force: true })
}

// --- 全局代理池：稳定哈希分配 + 账号覆盖优先 ---
{
  const poolConfig = loadConfig()
  poolConfig.upstream.proxies = [
    'http://p1.example:7890',
    'http://p2.example:7890',
    'http://p3.example:7890',
  ]
  const { createUpstreamClient } = await import('../src/upstream/client.js')
  const a1 = createUpstreamClient(poolConfig, 'tok', { accountId: 'a@example.com' })
  const a2 = createUpstreamClient(poolConfig, 'tok', { accountId: 'a@example.com' })
  const b = createUpstreamClient(poolConfig, 'tok', { accountId: 'b@example.com' })
  // 同账号稳定同一代理
  assert.equal(a1.proxyUrl, a2.proxyUrl)
  assert.ok(a1.proxyUrl.startsWith('http://p'))
  // 不同账号可能落到不同代理（池内成员之一）
  assert.ok(poolConfig.upstream.proxies.includes(a1.proxyUrl))
  assert.ok(poolConfig.upstream.proxies.includes(b.proxyUrl))
  // 账号显式代理优先于全局池
  const c = createUpstreamClient(poolConfig, 'tok', {
    accountId: 'a@example.com',
    proxy: 'http://explicit:9999',
  })
  assert.equal(c.proxyUrl, 'http://explicit:9999')
  // 无池无显式 → 直连（null）
  const plain = createUpstreamClient(loadConfig(), 'tok', { accountId: 'x@example.com' })
  assert.equal(plain.proxyUrl, null)
}

// --- web api: probe 只读刷新 session/额度缓存 ---
{
  const wDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-probe-'))
  saveAccountUser(wDir, { id: 'w', email: 'w@example.com', authToken: 'token-w' })
  const wConfig = loadConfig()
  wConfig.server.host = '127.0.0.1'
  wConfig.server.port = 0
  wConfig.server.apiKeys = ['sk-test']
  wConfig.upstream.credentialsDir = wDir
  wConfig.session.pollIntervalSec = 3600
  const { UserStore } = await import('../src/web/user-store.js')
  const { WebSessionStore } = await import('../src/web/session-store.js')
  const { LoginFlowManager } = await import('../src/web/login-flows.js')
  const { ProxyStore } = await import('../src/web/proxy-store.js')
  const userStore = new UserStore(path.join(wDir, 'users.json'))
  const webSessions = new WebSessionStore(path.join(wDir, 'web-sessions.json'), 3600_000)
  userStore.create({ username: 'admin', password: 'secret123', role: 'admin' })
  const loginFlows = new LoginFlowManager({
    file: path.join(wDir, 'login-flows.json'),
    credentialsDir: wDir,
    config: wConfig,
  })
  const proxyStore = new ProxyStore(path.join(wDir, 'proxies.json'))
  const poolUrls = ['http://p1.example:7890', 'http://p2.example:7890']
  const wruntimes = new AccountRuntimes(wConfig)
  const wserver = await startServer({
    config: wConfig,
    runtimes: wruntimes,
    authToken: null,
    authSource: null,
    authEmail: null,
    upstream: null,
    sessions: null,
    userStore,
    webSessions,
    loginFlows,
    proxyStore,
  })
  const wport = wserver.address().port
  const lr = await fetch(`http://127.0.0.1:${wport}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret123' }),
  })
  assert.equal(lr.status, 200)
  const cookie = lr.headers.get('set-cookie').split(';')[0]
  const pr = await fetch(`http://127.0.0.1:${wport}/api/accounts/probe`, {
    method: 'POST',
    headers: { cookie },
  })
  assert.equal(pr.status, 200)
  const pj = await pr.json()
  assert.equal(pj.results.length, 1)
  assert.equal(pj.results[0].ok, true)
  assert.equal(pj.accounts[0].email, 'w@example.com')
  // mock GET 返回 status none → 探测后 session 状态可见
  assert.equal(pj.accounts[0].session.status, 'none')
  // 代理管理 API：GET 空池 → POST 保存（持久化 + 立即生效）→ GET 返回
  {
    const g1 = await fetch(`http://127.0.0.1:${wport}/api/proxy`, { headers: { cookie } })
    assert.equal(g1.status, 200)
    assert.deepEqual((await g1.json()).proxies, [])

    const post = await fetch(`http://127.0.0.1:${wport}/api/proxy`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ proxies: ['http://p1.example:7890', 'http://p2.example:7890', '  '] }),
    })
    assert.equal(post.status, 200)
    const pj = await post.json()
    assert.deepEqual(pj.proxies, ['http://p1.example:7890', 'http://p2.example:7890'])
    assert.ok(pj.note)

    // 持久化到 /data/proxies.json，且运行配置已更新
    const saved = JSON.parse(fs.readFileSync(path.join(wDir, 'proxies.json'), 'utf8'))
    assert.deepEqual(saved.proxies, ['http://p1.example:7890', 'http://p2.example:7890'])
    assert.deepEqual(wConfig.upstream.proxies, ['http://p1.example:7890', 'http://p2.example:7890'])

    // 新 runtime 使用新池（invalidateProxies 后重建）
    const rt = wruntimes.get('w@example.com')
    assert.ok(poolUrls.includes(rt.effectiveProxy))

    const g2 = await fetch(`http://127.0.0.1:${wport}/api/proxy`, { headers: { cookie } })
    assert.deepEqual((await g2.json()).proxies, ['http://p1.example:7890', 'http://p2.example:7890'])

    // 清空 → 全局池空
    await fetch(`http://127.0.0.1:${wport}/api/proxy`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ proxies: [] }),
    })
    assert.deepEqual(wConfig.upstream.proxies, [])
  }

  // proxy test: 未配置代理 → 空结果
  const pt1 = await fetch(`http://127.0.0.1:${wport}/api/proxy/test`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(pt1.status, 200)
  const ptj1 = await pt1.json()
  assert.equal(ptj1.results.length, 0)
  assert.ok(ptj1.note)
  // proxy test: 死代理 → ok:false + 错误信息（真连接尝试，localhost 立即拒绝）
  const pt2 = await fetch(`http://127.0.0.1:${wport}/api/proxy/test`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ proxy: 'http://127.0.0.1:9' }),
  })
  assert.equal(pt2.status, 200)
  const ptj2 = await pt2.json()
  assert.equal(ptj2.results.length, 1)
  assert.equal(ptj2.results[0].ok, false)
  assert.equal(ptj2.results[0].proxy, 'http://127.0.0.1:9')
  assert.ok(ptj2.results[0].error)
  loginFlows.shutdown()
  await wruntimes.shutdown()
  wserver.close()
  fs.rmSync(wDir, { recursive: true, force: true })
}

// --- quota: extraction + quota-aware load balancing ---
{
  const qDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-quota-'))
  saveAccountUser(qDir, { id: 'qa', email: 'qa@example.com', authToken: 'token-qa' })
  saveAccountUser(qDir, { id: 'qb', email: 'qb@example.com', authToken: 'token-qb' })
  const qConfig = loadConfig()
  qConfig.upstream.credentialsDir = qDir
  qConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(qConfig)
  const mkQuota = (model, limit, used) => {
    const rl = { model, limit, period: 'pacific_day', resetAt: '2026-08-09T07:00:00.000Z', recentCount: used }
    return { byModel: { [model]: rl }, rateLimit: rl, updatedAt: new Date().toISOString() }
  }
  const pa = pool.get('qa@example.com')
  const pb = pool.get('qb@example.com')
  pa.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 5)
  pb.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 1)

  // 限额模型（luna）：剩余额度多的账号优先
  const order = pool.candidateEmails('openai/gpt-5.6-luna')
  assert.equal(order[0], 'qb@example.com', `expected qb first, got ${order}`)

  // 限额模型：已用满被大幅降权
  pa.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 6)
  const order2 = pool.candidateEmails('openai/gpt-5.6-luna')
  assert.equal(order2[0], 'qb@example.com', `expected qb first after exhaustion, got ${order2}`)

  // 不限量模型（flash/mimo）：配额不影响选号（不因已用/上限切号）
  pa.sessions.quota = mkQuota('deepseek/deepseek-v4-flash', 6, 6)
  pb.sessions.quota = mkQuota('deepseek/deepseek-v4-flash', 6, 6)
  const orderFlash = pool.candidateEmails('deepseek/deepseek-v4-flash')
  // 无配额惩罚，仅轮询偏移 → 字典序 qa 在前
  assert.equal(orderFlash[0], 'qa@example.com', `flash must ignore quota, got ${orderFlash}`)

  // list() surfaces quota + requests；flash 条目被标注 unlimited
  pa.sessions.quota = {
    byModel: {
      'openai/gpt-5.6-luna': mkQuota('openai/gpt-5.6-luna', 6, 5).byModel['openai/gpt-5.6-luna'],
      'deepseek/deepseek-v4-flash': mkQuota('deepseek/deepseek-v4-flash', 6, 6).byModel['deepseek/deepseek-v4-flash'],
    },
    rateLimit: null,
    updatedAt: new Date().toISOString(),
  }
  pb.sessions.quota = {
    byModel: {
      'openai/gpt-5.6-luna': mkQuota('openai/gpt-5.6-luna', 6, 1).byModel['openai/gpt-5.6-luna'],
      'deepseek/deepseek-v4-flash': mkQuota('deepseek/deepseek-v4-flash', 6, 6).byModel['deepseek/deepseek-v4-flash'],
    },
    rateLimit: null,
    updatedAt: new Date().toISOString(),
  }
  const rows = pool.list()
  const rowB = rows.find((x) => x.email === 'qb@example.com')
  assert.equal(rowB.quota.byModel['openai/gpt-5.6-luna'].recentCount, 1)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].unlimited, true)
  assert.equal(rowB.quota.byModel['openai/gpt-5.6-luna'].unlimited, undefined)
  assert.equal(typeof rowB.requests, 'number')
  await pool.shutdown()
  fs.rmSync(qDir, { recursive: true, force: true })
}

// --- 会话级负载均衡：不同会话按轮询+最少会话数摊分，同一会话固定账号 ---
{
  const convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-conv-'))
  saveAccountUser(convDir, { id: 'da', email: 'da@example.com', authToken: 'token-da' })
  saveAccountUser(convDir, { id: 'db', email: 'db@example.com', authToken: 'token-db' })
  saveAccountUser(convDir, { id: 'dc', email: 'dc@example.com', authToken: 'token-dc' })
  const convConfig = loadConfig()
  convConfig.server.host = '127.0.0.1'
  convConfig.server.port = 0
  convConfig.server.apiKeys = ['sk-test']
  convConfig.upstream.credentialsDir = convDir
  convConfig.session.pollIntervalSec = 3600
  const convRuntimes = new AccountRuntimes(convConfig)
  const convServer = await startServer({
    config: convConfig,
    runtimes: convRuntimes,
    ...(() => {
      const rt = convRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const convPort = convServer.address().port

  // unit: 新会话按最少会话数+轮询摊开，覆盖全部账号；同一会话返回同一账号
  const picks = new Map()
  for (let i = 1; i <= 12; i++) {
    const key = `conv-${i}`
    picks.set(key, convRuntimes.conversationPreferredEmail(key))
  }
  const used = new Set(picks.values())
  assert.equal(used.size, 3, `12 个会话应摊到全部 3 个账号, got ${[...used]}`)
  // 平均分配：12 个新会话应 4/4/4（轮询+最少会话，而不是哈希碰撞堆在一个账号）
  const dist = new Map()
  for (const email of picks.values()) {
    dist.set(email, (dist.get(email) || 0) + 1)
  }
  assert.deepEqual(
    [...dist.values()].sort((a, b) => a - b),
    [4, 4, 4],
    `12 个新会话应 4/4/4 平均分配, got ${JSON.stringify([...dist])}`,
  )
  for (let i = 1; i <= 12; i++) {
    const key = `conv-${i}`
    assert.equal(convRuntimes.conversationPreferredEmail(key), picks.get(key))
  }
  // recordConversation 覆盖哈希种子（会话回落后固定到新账号）
  convRuntimes.recordConversation('conv-1', 'db@example.com')
  assert.equal(convRuntimes.conversationPreferredEmail('conv-1'), 'db@example.com')
  // 冷却中的账号不参与新会话的分配
  convRuntimes.markCooldown('da@example.com', {
    code: 'rate_limited',
    retryAfterMs: 60_000,
  })
  const fresh = new Set()
  for (let i = 100; i <= 130; i++) {
    fresh.add(convRuntimes.conversationPreferredEmail(`fresh-${i}`))
  }
  assert.ok(!fresh.has('da@example.com'), '冷却账号不应作为新会话种子')
  convRuntimes.clearCooldown('da@example.com')

  // integration: 12 个不同 client_id 新会话 → 平均分配到 3 个账号
  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  for (let i = 1; i <= 12; i++) {
    const res = await fetch(`http://127.0.0.1:${convPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        codebuff_metadata: { conversation_id: `conv-${i}` },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
  }
  const reqByEmail = new Map(convRuntimes.list().map((a) => [a.email, a.requests]))
  for (const email of ['da@example.com', 'db@example.com', 'dc@example.com']) {
    assert.ok(
      (reqByEmail.get(email) || 0) >= 1,
      `${email} 应至少命中 1 次请求, got ${reqByEmail.get(email)}`,
    )
  }

  // integration: 同一会话连续 3 次 → 只增长同一个账号
  const before = new Map(convRuntimes.list().map((a) => [a.email, a.requests]))
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`http://127.0.0.1:${convPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        codebuff_metadata: { conversation_id: 'conv-3' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
  }
  const after = new Map(convRuntimes.list().map((a) => [a.email, a.requests]))
  const delta = [...after.entries()]
    .map(([email, n]) => [email, n - (before.get(email) || 0)])
    .filter(([, n]) => n > 0)
  assert.equal(delta.length, 1, `同一会话应只增长一个账号, got ${JSON.stringify(delta)}`)
  assert.equal(delta[0][1], 3)

  await convRuntimes.shutdown()
  convServer.close()
  fs.rmSync(convDir, { recursive: true, force: true })
}

// 无会话ID 的请求（纯池子选号）：轮询均分，不因“活跃 session”一直压在一个账号
{
  const rrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-rr-'))
  saveAccountUser(rrDir, { id: 'ra', email: 'ra@example.com', authToken: 'token-ra' })
  saveAccountUser(rrDir, { id: 'rb', email: 'rb@example.com', authToken: 'token-rb' })
  saveAccountUser(rrDir, { id: 'rc', email: 'rc@example.com', authToken: 'token-rc' })
  const rrConfig = loadConfig()
  rrConfig.server.host = '127.0.0.1'
  rrConfig.server.port = 0
  rrConfig.server.apiKeys = ['sk-test']
  rrConfig.upstream.credentialsDir = rrDir
  rrConfig.session.pollIntervalSec = 3600
  const rrRuntimes = new AccountRuntimes(rrConfig)
  const rrServer = await startServer({
    config: rrConfig,
    runtimes: rrRuntimes,
    ...(() => {
      const rt = rrRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const rrPort = rrServer.address().port
  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  // 9 个无会话 key 的请求：轮询 a→b→c→a→b→c…，每个账号 3 次，
  // 而不是第一个拿到 session 的账号被活跃 session 加分持续吸走全部请求。
  for (let i = 0; i < 9; i++) {
    const res = await fetch(`http://127.0.0.1:${rrPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
  }
  const rrByEmail = new Map(
    rrRuntimes.list().map((a) => [a.email, a.requests]),
  )
  for (const email of ['ra@example.com', 'rb@example.com', 'rc@example.com']) {
    assert.equal(
      rrByEmail.get(email),
      3,
      `${email} 应收到 3 个轮询请求, got ${rrByEmail.get(email)}`,
    )
  }
  await rrRuntimes.shutdown()
  rrServer.close()
  fs.rmSync(rrDir, { recursive: true, force: true })
}

// sub2api 场景：恒定的 user 字段 + 无任何会话 id → 仍按池子轮询，不钉死在固定 user 的账号
{
  const subDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-sub2api-'))
  saveAccountUser(subDir, { id: 'sa', email: 'sa@example.com', authToken: 'token-sa' })
  saveAccountUser(subDir, { id: 'sb', email: 'sb@example.com', authToken: 'token-sb' })
  saveAccountUser(subDir, { id: 'sc', email: 'sc@example.com', authToken: 'token-sc' })
  const subConfig = loadConfig()
  subConfig.server.host = '127.0.0.1'
  subConfig.server.port = 0
  subConfig.server.apiKeys = ['sk-test']
  subConfig.upstream.credentialsDir = subDir
  subConfig.session.pollIntervalSec = 3600
  const subRuntimes = new AccountRuntimes(subConfig)
  const subServer = await startServer({
    config: subConfig,
    runtimes: subRuntimes,
    ...(() => {
      const rt = subRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const subPort = subServer.address().port
  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const seenAccounts = new Map()
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`http://127.0.0.1:${subPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        user: 'sub2api-fixed-user', // 恒定 user，不应成为会话 key
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    const acc = res.headers.get('x-freebuff-proxy-account')
    seenAccounts.set(acc, (seenAccounts.get(acc) || 0) + 1)
    // 恒定 user 场景不应有 conv-key（user 不再作为会话 key）
    assert.equal(res.headers.get('x-freebuff-proxy-conv-key'), null)
  }
  for (const email of ['sa@example.com', 'sb@example.com', 'sc@example.com']) {
    assert.equal(
      seenAccounts.get(email),
      2,
      `${email} 应收到 2 个轮询请求, got ${seenAccounts.get(email)}`,
    )
  }
  await subRuntimes.shutdown()
  subServer.close()
  fs.rmSync(subDir, { recursive: true, force: true })
}

await runtimes.shutdown()
server.close()
globalThis.fetch = originalFetch
fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('smoke ok')
