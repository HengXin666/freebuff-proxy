/**
 * 首字节耗时（TTFB）剖析：首次请求 vs 热请求。
 *
 * 目的：量化"首次耗时有点久"，并把每一段可观测的耗时归因到具体上游调用。
 * 用法: node test/repro-firstbyte.mjs [上游每次调用延迟ms] [是否 spread]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { AccountRuntimes } from '../src/app-context.js'
import { startServer } from '../src/server.js'
import { configureLogger } from '../src/util/log.js'
import { saveAccountUser } from '../src/auth-store.js'

configureLogger({ level: 'error' })
const UPSTREAM_MS = Number(process.argv[2] || 150)
const MODE = process.argv[3] === 'spread' ? 'spread' : 'sticky'

const originalFetch = globalThis.fetch
/** 上游调用流水（用于归因首字节前的串行往返）。 */
const calls = []
function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.includes('127.0.0.1') || u.includes('localhost')) return originalFetch(url, init)
  const method = (init.method || 'GET').toUpperCase()
  const headers = init.headers || {}
  const auth = headers.Authorization || headers.authorization || headers['x-codebuff-api-key'] || ''
  const token = String(auth).replace('Bearer ', '').trim()
  // 所有上游调用都带固定延迟，模拟真实网络 RTT
  await sleep(UPSTREAM_MS)

  if (u.includes('/api/v1/freebuff/session') && method === 'POST') {
    const model = headers['x-freebuff-model'] || 'deepseek/deepseek-v4-flash'
    calls.push({ t: Date.now(), kind: 'session:POST' })
    const rateLimit = {
      model, limit: 6, period: 'pacific_day',
      resetAt: '2026-08-09T07:00:00.000Z', windowHours: 24, recentCount: 1,
    }
    return jsonRes({
      status: 'active', instanceId: 'inst-' + Math.random().toString(36).slice(2), model,
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      remainingMs: 3600_000, accessTier: 'full',
      rateLimit, rateLimitsByModel: { [model]: rateLimit },
    })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'GET') {
    calls.push({ t: Date.now(), kind: 'session:GET' })
    return jsonRes({ status: 'none', accessTier: 'full' })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'DELETE') {
    calls.push({ t: Date.now(), kind: 'session:DELETE' })
    return jsonRes({ status: 'none' })
  }
  if (u.includes('/api/v1/agent-runs') && method === 'POST') {
    const body = JSON.parse(init.body || '{}')
    // START 在**首字节之前**（阻塞）；FINISH 是 best-effort、不阻塞首字节
    // （proxy.js 里是 `void finishAgentRun(...)`），必须分开统计，否则会
    // 误以为上游被调了两次。
    calls.push({ t: Date.now(), kind: 'agent-runs:' + (body.action || '?') })
    if (body.action === 'START') return jsonRes({ runId: '00000000-0000-4000-8000-000000000001' })
    return jsonRes({ ok: true })
  }
  if (u.includes('/api/v1/chat/completions')) {
    calls.push({ t: Date.now(), kind: 'chat:POST' })
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        let i = 0
        const emit = () => {
          if (i >= 3) { controller.close(); return }
          controller.enqueue(enc.encode('data: {"x":"' + i + '"}\n\n'))
          i++
          setTimeout(emit, 50)
        }
        emit()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return originalFetch(url, init)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-firstbyte-'))
saveAccountUser(dir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
saveAccountUser(dir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
const config = loadConfig()
config.server.host = '127.0.0.1'
config.server.port = 0
config.server.apiKeys = ['sk-test']
config.upstream.credentialsDir = dir
config.session.pollIntervalSec = 3600
const runtimes = new AccountRuntimes(config, {
  getAccountConcurrency: () => 2,
  getSchedulingMode: () => MODE,
})
const server = await startServer({
  config, runtimes,
  ...(() => { const rt = runtimes.getAny(); return { authToken: rt.authToken, authSource: rt.source, authEmail: rt.email, upstream: rt.upstream, sessions: rt.sessions } })(),
})
const port = server.address().port

async function ttfb(label) {
  calls.length = 0
  const t0 = Date.now()
  const res = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const tHeaders = Date.now()
  const reader = res.body.getReader()
  const first = await reader.read()
  const tFirst = Date.now()
  // 读干
  let done = false
  while (!done) { const r = await reader.read(); done = r.done }
  const tEnd = Date.now()
  const streamKinds = calls.map((c) => c.kind + '@+' + (c.t - t0) + 'ms')
  console.log(label)
  console.log('  响应头:', (tHeaders - t0) + 'ms | 首字节:', (tFirst - t0) + 'ms | 完成:', (tEnd - t0) + 'ms')
  console.log('  首字节前上游调用(' + streamKinds.filter((k) => Number(k.split('@+')[1].replace('ms', '')) <= (tFirst - t0)).length + '):', streamKinds.join(', '))
  return { ttfb: tFirst - t0 }
}

console.log('=== 上游每次调用延迟 ' + UPSTREAM_MS + 'ms, 模式 ' + MODE + ' ===')
await ttfb('[1] 首次请求（冷启动：无热 session）')
await ttfb('[2] 紧接着第二次（应复用热 session）')
await ttfb('[3] 第三次（热）')
// 空闲释放后再次请求：默认 idle_release_sec=60s 会早退 DELETE 掉会话，
// 于是"隔一会儿再来一条"会重新走一遍冷路径 —— 这是**日常最常付**的那段。
config.session.idleReleaseSec = 0
const rt = runtimes.getAny()
console.log('\n[4] 主动释放会话后再请求（模拟空闲释放后的下一条）')
await rt.sessions.releaseWhenIdle({ force: true }).catch(() => {})
await ttfb('[4] 释放后第一条（重新 admit）')
await ttfb('[5] 释放后第二条（又热了）')

globalThis.fetch = originalFetch
await runtimes.shutdown()
server.close()
fs.rmSync(dir, { recursive: true, force: true })
