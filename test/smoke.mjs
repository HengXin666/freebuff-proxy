import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { AccountRuntimes } from '../src/app-context.js'
import { startServer } from '../src/server.js'
import { configureLogger } from '../src/util/log.js'
import { requireModelId } from '../src/model.js'
import { saveAccountUser, listAccounts, readAccountUser } from '../src/auth-store.js'
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

configureLogger({ level: 'error' })

const originalFetch = globalThis.fetch
let calls = []
/** @type {'ok' | 'gate_once' | 'rate_limit_a' | 'rate_limit_completion' | 'err_500_a' | 'capacity_once' | 'capacity_all' | 'run_500_a' | 'network_err_a' | 'gate_twice_a'} */
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
      const runAuth =
        headers.Authorization ||
        headers.authorization ||
        headers['x-codebuff-api-key'] ||
        ''
      if (mockMode === 'run_500_a' && String(runAuth).includes('token-a')) {
        return jsonRes({ error: 'internal_error', message: 'run boom' }, 500)
      }
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
    if (mockMode === 'err_500_a' && String(compAuth).includes('token-a')) {
      return jsonRes({ error: 'internal_error', message: 'boom' }, 500)
    }
    // free_mode_capacity_deferred：瞬时容量排队，换号重试不冷却
    if (mockMode === 'capacity_once' && completionAttempts === 1) {
      return jsonRes(
        {
          error: 'free_mode_capacity_deferred',
          message:
            'Free mode is briefly at capacity; your request will be retried automatically.',
        },
        429,
      )
    }
    if (mockMode === 'capacity_all') {
      return jsonRes(
        {
          error: 'free_mode_capacity_deferred',
          message:
            'Free mode is briefly at capacity; your request will be retried automatically.',
        },
        429,
      )
    }
    // 同账号连续 gate 失败（session_superseded ×2）→ 升级换号
    if (
      mockMode === 'gate_twice_a' &&
      String(compAuth).includes('token-a') &&
      completionAttempts <= 2
    ) {
      return jsonRes({ error: 'session_superseded', message: 'taken over' }, 409)
    }
    // 网络层错误（fetch 抛异常）→ 换号重试
    if (mockMode === 'network_err_a' && String(compAuth).includes('token-a')) {
      throw new Error('ECONNRESET: socket hang up')
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
  await runtimes.get('u1').sessions.release()
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
  const cd = rlRuntimes.cooldowns.get('a')
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
    'u1',
    { code: 'model_unavailable', retryAfterMs: 60_000 },
    'openai/gpt-5.6-luna',
  )
  assert.equal(
    pool.isCoolingDown('u1', 'openai/gpt-5.6-luna'),
    true,
  )
  assert.equal(
    pool.isCoolingDown('u1', 'deepseek/deepseek-v4-flash'),
    false,
  )
  pool.markCooldown('u1', {
    code: 'banned',
    retryAfterMs: 1000,
  })
  assert.equal(pool.isCoolingDown('u1', 'any'), true)
  const cd = pool.cooldowns.get('u1')
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
  // persistence across instances
  const us2 = new UserStore(path.join(tmpDir, 'users.json'))
  assert.equal(us2.getByUsername('alice').username, 'alice')
  us2.delete('alice')
  assert.equal(us2.getByUsername('alice'), null)

  const ws = new WebSessionStore(path.join(tmpDir, 'web-sessions.json'), 60_000)
  const tok = ws.create('alice')
  assert.equal(ws.get(tok), 'alice')
  ws.destroy(tok)
  assert.equal(ws.get(tok), null)
}

// --- unit: 强制轮询 —— 每次 acquire 按账号轮流，冷却账号跳过 ---
{
  const rrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-rr-unit-'))
  saveAccountUser(rrDir, { id: 'a', email: 'rr-a@example.com', authToken: 'token-a' })
  saveAccountUser(rrDir, { id: 'b', email: 'rr-b@example.com', authToken: 'token-b' })
  saveAccountUser(rrDir, { id: 'c', email: 'rr-c@example.com', authToken: 'token-c' })
  const rrConfig = loadConfig()
  rrConfig.upstream.credentialsDir = rrDir
  rrConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(rrConfig)
  mockMode = 'ok'
  sessionPosts = 0
  // a → b → c → a → b …（强制轮询，不因配额/会话粘性把请求吸回同一账号）
  const emails = []
  for (let i = 0; i < 6; i++) {
    const rt = await pool.acquireForModel('deepseek/deepseek-v4-flash')
    emails.push(rt.email)
  }
  assert.deepEqual(
    emails,
    [
      'rr-a@example.com',
      'rr-b@example.com',
      'rr-c@example.com',
      'rr-a@example.com',
      'rr-b@example.com',
      'rr-c@example.com',
    ],
    `强制轮询应严格轮流, got ${JSON.stringify(emails)}`,
  )
  // 冷却中的账号跳过：b 冷却后 a → c → a → c
  pool.markCooldown('b', {
    code: 'rate_limited',
    retryAfterMs: 60_000,
  })
  const next = []
  for (let i = 0; i < 4; i++) {
    const rt = await pool.acquireForModel('deepseek/deepseek-v4-flash')
    next.push(rt.email)
  }
  assert.deepEqual(
    next,
    ['rr-a@example.com', 'rr-c@example.com', 'rr-a@example.com', 'rr-c@example.com'],
    `冷却账号应被跳过, got ${JSON.stringify(next)}`,
  )
  await pool.shutdown()
  fs.rmSync(rrDir, { recursive: true, force: true })
}

// --- regression: GitHub/Google 同一邮箱但 id 不同 → 两个账号并存，不互相覆盖 ---
{
  const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-dup-'))
  // 模拟 GitHub 登录 + Google 登录（同一邮箱、不同 Freebuff id）
  saveAccountUser(dupDir, { id: 'github-u1', email: 'same@example.com', name: 'GitHub', authToken: 'token-gh' })
  saveAccountUser(dupDir, { id: 'google-u1', email: 'same@example.com', name: 'Google', authToken: 'token-google' })
  let rows = listAccounts(dupDir)
  assert.equal(rows.length, 2, `同邮箱不同 id 应并存, got ${JSON.stringify(rows.map((r) => r.id))}`)
  assert.equal(rows.filter((r) => r.email === 'same@example.com').length, 2)
  assert.ok(rows.some((r) => r.id === 'github-u1') && rows.some((r) => r.id === 'google-u1'))
  // 各自独立文件，互不覆盖
  assert.ok(fs.existsSync(path.join(dupDir, 'github-u1.json')))
  assert.ok(fs.existsSync(path.join(dupDir, 'google-u1.json')))
  // 重登 GitHub（同 id）→ 只更新 GitHub 那份，Google 那份原样保留
  saveAccountUser(dupDir, { id: 'github-u1', email: 'same@example.com', name: 'GitHub', authToken: 'token-gh-2' })
  rows = listAccounts(dupDir)
  assert.equal(rows.length, 2)
  assert.equal(readAccountUser(dupDir, 'github-u1').authToken, 'token-gh-2')
  assert.equal(readAccountUser(dupDir, 'google-u1').authToken, 'token-google')
  // 轮询选号能分别选中两个账号（各获得一次）
  const dupConfig = loadConfig()
  dupConfig.upstream.credentialsDir = dupDir
  dupConfig.session.pollIntervalSec = 3600
  const dupPool = new AccountRuntimes(dupConfig)
  mockMode = 'ok'
  sessionPosts = 0
  const seen = []
  for (let i = 0; i < 2; i++) {
    const rt = await dupPool.acquireForModel('deepseek/deepseek-v4-flash')
    seen.push(rt.key)
  }
  assert.deepEqual(
    [...seen].sort(),
    ['github-u1', 'google-u1'],
    `两个同邮箱账号都应被轮询到, got ${JSON.stringify(seen)}`,
  )
  await dupPool.shutdown()
  fs.rmSync(dupDir, { recursive: true, force: true })
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
  const rtA = pool.get('pa')
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
  pool.get('pa').sessions.quota = { byModel: {}, rateLimit: null, updatedAt: 'x' }
  const before = pool.get('pa')
  const file = path.join(pDir, 'pa.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.proxy = null
  fs.writeFileSync(file, JSON.stringify(raw))
  const after = pool.get('pa')
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
    const rt = wruntimes.get('w')
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

// --- quota: extraction + display；选号是强制轮询，不受配额加权影响 ---
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
  const pa = pool.get('qa')
  const pb = pool.get('qb')
  pa.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 5)
  pb.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 1)

  // 强制轮询：即使 qa 剩余额度更少/更多，选号顺序也只按轮询指针走（qa → qb）
  const order = pool.candidateKeys('openai/gpt-5.6-luna')
  assert.deepEqual(order, ['qa', 'qb'], `expected strict round-robin, got ${order}`)

  // 已用满也不影响选号（429 会走冷却换号兜底，而不是选号阶段加权）
  pa.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 6)
  const order2 = pool.candidateKeys('openai/gpt-5.6-luna')
  assert.deepEqual(order2, ['qa', 'qb'], `exhaustion must not alter round-robin, got ${order2}`)

  // list() surfaces the live quota unchanged, including flash daily limits
  pa.sessions.quota = {
    byModel: {
      'openai/gpt-5.6-luna': mkQuota('openai/gpt-5.6-luna', 6, 5).byModel['openai/gpt-5.6-luna'],
      'deepseek/deepseek-v4-flash': mkQuota('deepseek/deepseek-v4-flash', 6, 6).byModel['deepseek/deepseek-v4-flash'],
      'mimo/mimo-v2.5': mkQuota('mimo/mimo-v2.5', 6, 4.8).byModel['mimo/mimo-v2.5'],
    },
    rateLimit: null,
    updatedAt: new Date().toISOString(),
  }
  pb.sessions.quota = {
    byModel: {
      'openai/gpt-5.6-luna': mkQuota('openai/gpt-5.6-luna', 6, 1).byModel['openai/gpt-5.6-luna'],
      'deepseek/deepseek-v4-flash': mkQuota('deepseek/deepseek-v4-flash', 6, 6).byModel['deepseek/deepseek-v4-flash'],
      'mimo/mimo-v2.5': mkQuota('mimo/mimo-v2.5', 6, 4.8).byModel['mimo/mimo-v2.5'],
    },
    rateLimit: null,
    updatedAt: new Date().toISOString(),
  }
  const rows = pool.list()
  const rowB = rows.find((x) => x.email === 'qb@example.com')
  assert.equal(rowB.quota.byModel['openai/gpt-5.6-luna'].recentCount, 1)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].limit, 6)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].recentCount, 6)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].unlimited, undefined)
  assert.equal(rowB.quota.byModel['mimo/mimo-v2.5'].limit, 6)
  assert.equal(rowB.quota.byModel['mimo/mimo-v2.5'].recentCount, 4.8)
  assert.equal(rowB.quota.byModel['mimo/mimo-v2.5'].unlimited, undefined)
  assert.equal(rowB.quota.byModel['openai/gpt-5.6-luna'].unlimited, undefined)
  assert.equal(typeof rowB.requests, 'number')
  await pool.shutdown()
  fs.rmSync(qDir, { recursive: true, force: true })
}

// --- 强制轮询：同一 conversation_id 也轮流换账号（上游无状态，不做会话分组） ---
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

  // integration: 同一会话 key 连续 6 次 → 每个账号恰好 2 次（严格轮流，不钉死在单一账号）
  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const seen = []
  let res
  for (let i = 0; i < 6; i++) {
    res = await fetch(`http://127.0.0.1:${convPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        codebuff_metadata: { conversation_id: 'same-thread-forever' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    seen.push(res.headers.get('x-freebuff-proxy-account'))
  }
  assert.deepEqual(
    seen,
    [
      'da@example.com',
      'db@example.com',
      'dc@example.com',
      'da@example.com',
      'db@example.com',
      'dc@example.com',
    ],
    `恒定会话 key 也必须严格轮询换号, got ${JSON.stringify(seen)}`,
  )
  // 同一会话不应再回传会话 key 响应头（无会话分组概念）
  assert.equal(res.headers.get('x-freebuff-proxy-conv-key'), null)

  // 冷却中的账号在轮到它时被跳过
  convRuntimes.markCooldown('db', {
    code: 'rate_limited',
    retryAfterMs: 60_000,
  })
  const afterCool = []
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`http://127.0.0.1:${convPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        codebuff_metadata: { conversation_id: 'same-thread-forever' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    afterCool.push(res.headers.get('x-freebuff-proxy-account'))
  }
  assert.ok(!afterCool.includes('db@example.com'), '冷却账号应被跳过')

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
    // 无会话分组：请求头也不回传 conv-key
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

// 上游 500 报错 → 冷却当前账号并换号重试
{
  const e5Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-e500-'))
  saveAccountUser(e5Dir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(e5Dir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const e5Config = loadConfig()
  e5Config.server.host = '127.0.0.1'
  e5Config.server.port = 0
  e5Config.server.apiKeys = ['sk-test']
  e5Config.upstream.credentialsDir = e5Dir
  e5Config.session.pollIntervalSec = 3600
  const e5Runtimes = new AccountRuntimes(e5Config)
  const e5Server = await startServer({
    config: e5Config,
    runtimes: e5Runtimes,
    ...(() => {
      const rt = e5Runtimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const e5Port = e5Server.address().port
  mockMode = 'err_500_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${e5Port}/v1/chat/completions`, {
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
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  assert.equal(completionAttempts, 2)
  const e5Accounts = e5Runtimes.list()
  const e5a = e5Accounts.find((x) => x.email === 'a@example.com')
  assert.equal(e5a.available, false)
  assert.equal(e5a.cooldownCode, 'internal_error')
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  await e5Runtimes.shutdown()
  e5Server.close()
  fs.rmSync(e5Dir, { recursive: true, force: true })
  mockMode = 'ok'
}

// free_mode_capacity_deferred → 换号重试且不冷却（瞬时容量，不是账号级故障）
{
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-cap-'))
  saveAccountUser(capDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(capDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const capConfig = loadConfig()
  capConfig.server.host = '127.0.0.1'
  capConfig.server.port = 0
  capConfig.server.apiKeys = ['sk-test']
  capConfig.upstream.credentialsDir = capDir
  capConfig.session.pollIntervalSec = 3600
  const capRuntimes = new AccountRuntimes(capConfig)
  const capServer = await startServer({
    config: capConfig,
    runtimes: capRuntimes,
    ...(() => {
      const rt = capRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const capPort = capServer.address().port
  mockMode = 'capacity_once'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${capPort}/v1/chat/completions`, {
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
  // 换到 b 成功；a 被 capacity 命中但【不】冷却
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  const capAccounts = capRuntimes.list()
  assert.equal(
    capAccounts.find((x) => x.email === 'a@example.com').available,
    true,
    'capacity_deferred 不应冷却账号',
  )
  assert.equal(capAccounts.find((x) => x.email === 'b@example.com').available, true)
  await capRuntimes.shutdown()
  capServer.close()
  fs.rmSync(capDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// 所有账号 capacity_deferred → 返回错误但【全部不冷却】（下次请求继续可轮询）
{
  const capDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-cap2-'))
  saveAccountUser(capDir2, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(capDir2, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const capConfig2 = loadConfig()
  capConfig2.server.host = '127.0.0.1'
  capConfig2.server.port = 0
  capConfig2.server.apiKeys = ['sk-test']
  capConfig2.upstream.credentialsDir = capDir2
  capConfig2.session.pollIntervalSec = 3600
  const capRuntimes2 = new AccountRuntimes(capConfig2)
  const capServer2 = await startServer({
    config: capConfig2,
    runtimes: capRuntimes2,
    ...(() => {
      const rt = capRuntimes2.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const capPort2 = capServer2.address().port
  mockMode = 'capacity_all'
  sessionPosts = 0
  completionAttempts = 0
  const res2 = await fetch(`http://127.0.0.1:${capPort2}/v1/chat/completions`, {
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
  assert.equal(res2.status, 429)
  const capAccounts2 = capRuntimes2.list()
  assert.equal(
    capAccounts2.every((x) => x.available),
    true,
    '全部 capacity_deferred 也不应冷却任何账号',
  )
  await capRuntimes2.shutdown()
  capServer2.close()
  fs.rmSync(capDir2, { recursive: true, force: true })
  mockMode = 'ok'
}

// startAgentRun 500 → 冷却当前账号换下一个，最终成功
{
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-run500-'))
  saveAccountUser(runDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(runDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const runConfig = loadConfig()
  runConfig.server.host = '127.0.0.1'
  runConfig.server.port = 0
  runConfig.server.apiKeys = ['sk-test']
  runConfig.upstream.credentialsDir = runDir
  runConfig.session.pollIntervalSec = 3600
  const runRuntimes = new AccountRuntimes(runConfig)
  const runServer = await startServer({
    config: runConfig,
    runtimes: runRuntimes,
    ...(() => {
      const rt = runRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const runPort = runServer.address().port
  mockMode = 'run_500_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${runPort}/v1/chat/completions`, {
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
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  const runAccounts = runRuntimes.list()
  const runA = runAccounts.find((x) => x.email === 'a@example.com')
  assert.equal(runA.available, false)
  assert.equal(runA.cooldownCode, 'start_agent_run_failed')
  await runRuntimes.shutdown()
  runServer.close()
  fs.rmSync(runDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// 网络错误（fetch 抛异常）→ 换号重试，最终成功
{
  const netDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-net-'))
  saveAccountUser(netDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(netDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const netConfig = loadConfig()
  netConfig.server.host = '127.0.0.1'
  netConfig.server.port = 0
  netConfig.server.apiKeys = ['sk-test']
  netConfig.upstream.credentialsDir = netDir
  netConfig.session.pollIntervalSec = 3600
  const netRuntimes = new AccountRuntimes(netConfig)
  const netServer = await startServer({
    config: netConfig,
    runtimes: netRuntimes,
    ...(() => {
      const rt = netRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const netPort = netServer.address().port
  mockMode = 'network_err_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${netPort}/v1/chat/completions`, {
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
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  await netRuntimes.shutdown()
  netServer.close()
  fs.rmSync(netDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// 同账号 gate 连续失败两次 → 升级为换号，最终成功
{
  const g2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-gate2-'))
  saveAccountUser(g2Dir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(g2Dir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const g2Config = loadConfig()
  g2Config.server.host = '127.0.0.1'
  g2Config.server.port = 0
  g2Config.server.apiKeys = ['sk-test']
  g2Config.upstream.credentialsDir = g2Dir
  g2Config.session.pollIntervalSec = 3600
  const g2Runtimes = new AccountRuntimes(g2Config)
  const g2Server = await startServer({
    config: g2Config,
    runtimes: g2Runtimes,
    ...(() => {
      const rt = g2Runtimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const g2Port = g2Server.address().port
  mockMode = 'gate_twice_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${g2Port}/v1/chat/completions`, {
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
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  // a 两次 gate（1 次会话 + 1 次同号 re-admit），b 一次 → 3 次 session POST、3 次 completions
  assert.equal(sessionPosts, 3, `expected 3 session POSTs, got ${sessionPosts}`)
  assert.equal(completionAttempts, 3, `expected 3 completions, got ${completionAttempts}`)
  const g2Accounts = g2Runtimes.list()
  const g2a = g2Accounts.find((x) => x.email === 'a@example.com')
  assert.equal(g2a.available, false)
  assert.equal(g2a.cooldownCode, 'session_superseded')
  await g2Runtimes.shutdown()
  g2Server.close()
  fs.rmSync(g2Dir, { recursive: true, force: true })
  mockMode = 'ok'
}

await runtimes.shutdown()
server.close()
globalThis.fetch = originalFetch
fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('smoke ok')
