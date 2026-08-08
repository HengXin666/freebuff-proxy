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
  isSessionRecoverableGate,
} from '../src/upstream/client.js'

configureLogger({ level: 'error' })

const originalFetch = globalThis.fetch
let calls = []
/** @type {'ok' | 'gate_once' | 'rate_limit_a'} */
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
    return jsonRes({
      status: 'active',
      instanceId: `inst-${sessionPosts}`,
      model,
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      remainingMs: 3600_000,
      accessTier: 'full',
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

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
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
  await multiRuntimes.shutdown()
  multiServer.close()
  fs.rmSync(multiDir, { recursive: true, force: true })
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

await runtimes.shutdown()
server.close()
globalThis.fetch = originalFetch
fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('smoke ok')
