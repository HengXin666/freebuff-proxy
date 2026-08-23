/**
 * 排验脚本：每账号并发上限 vs 多账号分配（复现/验证"满了还在同一账号堆并发"）
 *
 * 用法:
 *   node test/repro-concurrency.mjs spread 2 3 8        # 免费分散开(默认)，2 账号，上限 3，8 并发
 *   node test/repro-concurrency.mjs nospread 2 3 8      # 免费分散关（热 session 复用）
 *   node test/repro-concurrency.mjs spread 2 3 8 broken # 账号 B admit 一直失败（被冷却）
 *   node test/repro-concurrency.mjs nospread 2 3 8 seq  # 顺序请求（一个个来）：验证先共用 1 账号、满了才开新的
 *   node test/repro-concurrency.mjs nospread 2 3 8 mix  # 先 3 并发占满 A，再顺序来：验证满员即换号
 *
 * 输出: 账号分配 / 响应头账号序列 / 每账号流峰值 / 是否复现"全钉单账号"
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

const [,, modeArg = 'spread', accountsArg = '2', capArg = '3', reqsArg = '8', extraArg = '' ] = process.argv
const SPREAD = modeArg !== 'nospread'
const ACCOUNTS = Number(accountsArg)
const CAP = Number(capArg)
const REQS = Number(reqsArg)
const BROKEN_B = extraArg === 'broken'
const SEQ = extraArg === 'seq'
const MIX = extraArg === 'mix'

const originalFetch = globalThis.fetch
let sessionPosts = 0
let completionAttempts = 0
/** token -> 当前在途流数（按账号 token 区分） */
const activeByToken = new Map()
/** token -> 峰值 */
const peakByToken = new Map()

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const enc = new TextEncoder()
const STREAM_DELAY_MS = 300 // 每块间隔，决定单流时长

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.includes('127.0.0.1') || u.includes('localhost')) return originalFetch(url, init)
  const method = (init.method || 'GET').toUpperCase()
  const headers = init.headers || {}
  const auth = headers.Authorization || headers.authorization || headers['x-codebuff-api-key'] || ''
  const token = String(auth).replace('Bearer ', '').trim()

  if (u.includes('/api/v1/freebuff/session') && method === 'POST') {
    sessionPosts++
    if (BROKEN_B && token === 'token-b') {
      return jsonRes({ status: 'rate_limited', message: 'quota', retryAfterMs: 60_000 }, 429)
    }
    const model = headers['x-freebuff-model'] || 'deepseek/deepseek-v4-flash'
    const rateLimit = {
      model, entitlementBreakdown: { base: 6 }, limit: 6,
      period: 'pacific_day', resetTimeZone: 'America/Los_Angeles',
      resetAt: '2026-08-09T07:00:00.000Z', windowHours: 24, recentCount: 1,
    }
    return jsonRes({
      status: 'active', instanceId: `inst-${token}-${sessionPosts}`, model,
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      remainingMs: 3600_000, accessTier: 'full',
      rateLimit, rateLimitsByModel: { [model]: rateLimit },
    })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'GET') return jsonRes({ status: 'none', accessTier: 'full' })
  if (u.includes('/api/v1/freebuff/session') && method === 'DELETE') return jsonRes({ status: 'none' })
  if (u.includes('/api/v1/agent-runs') && method === 'POST') {
    const body = JSON.parse(init.body || '{}')
    if (body.action === 'START') return jsonRes({ runId: '00000000-0000-4000-8000-000000000001' })
    return jsonRes({ ok: true })
  }
  if (u.includes('/api/v1/chat/completions')) {
    completionAttempts++
    const cur = activeByToken.get(token) || 0
    activeByToken.set(token, cur + 1)
    peakByToken.set(token, Math.max(peakByToken.get(token) || 0, cur + 1))
    const stream = new ReadableStream({
      start(controller) {
        let i = 0
        const emit = () => {
          if (i >= 5) {
            activeByToken.set(token, (activeByToken.get(token) || 0) - 1)
            try { controller.close() } catch { /* ignore */ }
            return
          }
          controller.enqueue(enc.encode(`data: {"x":"${i}"}\n\n`))
          i++
          setTimeout(emit, STREAM_DELAY_MS)
        }
        emit()
      },
      cancel() {
        activeByToken.set(token, (activeByToken.get(token) || 0) - 1)
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  return originalFetch(url, init)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-repro-'))
for (let i = 0; i < ACCOUNTS; i++) {
  const letter = String.fromCharCode(97 + i)
  saveAccountUser(dir, { id: `k${letter}`, email: `acc-${letter}@example.com`, authToken: `token-${letter}` })
}

const config = loadConfig()
config.server.host = '127.0.0.1'
config.server.port = 0
config.server.apiKeys = ['sk-test']
config.upstream.credentialsDir = dir
config.session.pollIntervalSec = 3600
config.limits.maxConcurrentRequests = 64

const runtimes = new AccountRuntimes(config, {
  getAccountConcurrency: () => CAP,
  getSpreadFreeModels: () => SPREAD,
})
const server = await startServer({
  config,
  runtimes,
  ...(() => {
    const rt = runtimes.getAny()
    return {
      authToken: rt.authToken, authSource: rt.source, authEmail: rt.email,
      upstream: rt.upstream, sessions: rt.sessions,
    }
  })(),
})
const port = server.address().port

const startedAt = Date.now()
const fire = (i) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: `hello ${i}` }],
    }),
  }).then(async (r) => ({
    status: r.status,
    account: r.headers.get('x-freebuff-proxy-account'),
    elapsed: Date.now() - startedAt,
    body: (await r.text()).slice(0, 60),
  }))

let results
if (SEQ) {
  // 顺序请求：一个结束才开始下一个（间隔 10ms，保证上一个流已释放锁）
  results = []
  for (let i = 0; i < REQS; i++) {
    results.push(await fire(i))
    await new Promise((r) => setTimeout(r, 10))
  }
} else if (MIX) {
  // 先 CAP 个并发把 A 占满（不 await 完成，让流保持活跃），再顺序发剩余请求
  const head = Array.from({ length: CAP }, (_, i) => fire(i))
  await new Promise((r) => setTimeout(r, 150)) // 等 A 的在途流真正建立（锁已持有）
  const tail = []
  for (let i = CAP; i < REQS; i++) {
    tail.push(await fire(i))
    await new Promise((r) => setTimeout(r, 10))
  }
  results = [...(await Promise.all(head)), ...tail]
} else {
  results = await Promise.all(Array.from({ length: REQS }, (_, i) => fire(i)))
}
const elapsed = Date.now() - startedAt

const rows = runtimes.list().map((r) => ({
  email: r.email,
  inFlight: r.inFlight,
  concurrency: r.concurrency,
  requests: r.requests,
  cooling: r.available ? false : r.cooldownCode,
}))
const byAccount = {}
for (const r of results) {
  byAccount[r.account] = (byAccount[r.account] || 0) + 1
}

console.log(`\n=== 场景: spread=${SPREAD ? '开(默认)' : '关'} 账号数=${ACCOUNTS} 每账号并发上限=${CAP} 请求数=${REQS}${BROKEN_B ? ' B账号损坏(admit失败)' : ''} ===`)
console.log('账号分配:', byAccount)
console.log('响应头账号序列:', results.map((r) => r.account))
console.log('每账号流峰值(mock 观测):', Object.fromEntries([...peakByToken.entries()].map(([k, v]) => [k, v])))
console.log('账号状态(锁口径):', rows.map((r) => `${r.email}=${r.inFlight}/${r.concurrency} 请求${r.requests}${r.cooling ? ` 冷却:${r.cooling}` : ''}`).join(' | '))
console.log('总耗时:', elapsed, 'ms; 上游 admit 次数:', sessionPosts, '; chat 次数:', completionAttempts)
console.log('全部 200:', results.every((r) => r.status === 200))
if (results.some((r) => r.status !== 200)) {
  console.log('非 200 明细:', results.filter((r) => r.status !== 200).map((r) => ({ status: r.status, account: r.account, body: r.body, elapsed: r.elapsed })))
}

// 判定
const accountCount = Object.keys(byAccount).length
const overCap = [...peakByToken.entries()].filter(([, v]) => v > CAP)
// 顺序请求天然不会把账号打满（一个结束下一个才开始），"全钉单账号"不适用；
// 混合/并发模式才检查"满员是否换号"
const stuck =
  !SEQ && accountCount === 1 && REQS > ACCOUNTS * CAP && CAP > 1

console.log(`\n--- 结论 ---`)
console.log(`用了 ${accountCount}/${ACCOUNTS} 个账号; 单账号流峰值是否超上限: ${overCap.length ? JSON.stringify(overCap) : '否'}`)
if (SEQ) {
  console.log(accountCount === 1
    ? `✓ 顺序请求全部复用第 1 个账号的热 session（共 admit ${sessionPosts} 次）——符合"先共用、满了才开新"`
    : `✓ 顺序请求分散到 ${accountCount} 个账号`)
} else if (stuck) {
  console.log('⚠ 现象复现：请求全部钉在一个账号（符合用户描述）')
} else {
  console.log('✓ 未出现全钉单账号；请求按空闲槽位分散')
}

globalThis.fetch = originalFetch
await runtimes.shutdown()
server.close()
fs.rmSync(dir, { recursive: true, force: true })
