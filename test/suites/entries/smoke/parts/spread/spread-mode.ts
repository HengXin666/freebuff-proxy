/**
 * spread: 并发优先模式
 *
 * 满员立刻换号, 启用第二个账号.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../src/config.ts'
import { startServer } from '../../../../../../src/server.ts'
import { state } from '../../../../smoke/state.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- regression: 调度模式 spread(并发优先)→ 满员立刻换号, 启用第二个账号 ---
// 场景: 设了[每账号并发 2]时 4 个在途不应全挤在一个账号上. spread 模式下
// 排序把"有空闲槽位"提到最前, 满员账号不再压住空闲账号; 且 busy 必须排在
// used 之前("已用但满员"不能压住"空闲但从未用过"的号).
{
  const sdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-spread-'))
  saveAccountUser(sdDir, { id: 'sda', email: 'sda@example.com', authToken: 'token-sda' })
  saveAccountUser(sdDir, { id: 'sdb', email: 'sdb@example.com', authToken: 'token-sdb' })
  const sdConfig = loadConfig()
  sdConfig.server.host = '127.0.0.1'
  sdConfig.server.port = 0
  sdConfig.server.apiKeys = ['sk-test']
  sdConfig.upstream.credentialsDir = sdDir
  sdConfig.session.pollIntervalSec = 3600
  sdConfig.limits.maxConcurrentRequests = 12
  let sdMode = 'spread'
  const sdRuntimes = new AccountRuntimes(sdConfig, {
    getAccountConcurrency: () => 2,
    getSchedulingMode: () => sdMode,
  })
  const sdServer = await startServer({
    config: sdConfig,
    runtimes: sdRuntimes,
    ...(() => {
      const rt = sdRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const sdPort = sdServer.address().port

  // 按账号分别统计并发峰值: 断言的是"单账号不超过上限"(全局 4 路是预期的,
  // 两个账号各 2 路).
  const sdActiveByToken = new Map()
  const sdPeakByToken = new Map()
  const sdOrigFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return sdOrigFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        const headers = init.headers || {}
        const token =
          (headers.Authorization || headers.authorization || 'unknown')
            .replace('Bearer ', '')
        let closed = false
        const bump = (d) => {
          const cur = Math.max(0, (sdActiveByToken.get(token) || 0) + d)
          sdActiveByToken.set(token, cur)
          if (cur > (sdPeakByToken.get(token) || 0)) sdPeakByToken.set(token, cur)
        }
        bump(1)
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            async function emit(i) {
              if (i >= 20 || closed) {
                bump(-1)
                if (!closed) controller.close()
                return
              }
              controller.enqueue(enc.encode(`data: {"x":"${i}"}\n\n`))
              await new Promise((r) => setTimeout(r, 100))
              emit(i + 1)
            }
            emit(0)
          },
          cancel() {
            closed = true
            bump(-1)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
    }
    return sdOrigFetch(url, init)
  }

  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.completionAttempts = 0
  // 4 个并发流,每账号上限 2 → spread 必须铺到两个账号上(各 2 路)
  const sdReqs = Array.from({ length: 4 }, () =>
    fetch(`http://127.0.0.1:${sdPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
  )
  const sdResponses = await Promise.all(sdReqs)
  const sdAccounts = []
  for (const r of sdResponses) {
    assert.equal(r.status, 200, await r.clone().text())
    sdAccounts.push(r.headers.get('x-freebuff-proxy-account'))
  }
  const sdByEmail = {}
  for (const a of sdAccounts) sdByEmail[a] = (sdByEmail[a] || 0) + 1
  // 核心断言:4 路并发 + 上限 2 → 两个账号各 2 路(不再全挤在一个号上)
  assert.equal(Object.keys(sdByEmail).length, 2, `spread 应铺到 2 个账号, got ${JSON.stringify(sdByEmail)}`)
  assert.equal(sdByEmail['sda@example.com'] || 0, 2, `sda 应 2 路, got ${JSON.stringify(sdByEmail)}`)
  assert.equal(sdByEmail['sdb@example.com'] || 0, 2, `sdb 应 2 路, got ${JSON.stringify(sdByEmail)}`)
  // 每个账号的峰值都必须 <= 上限 2(并发真的铺开了,但没超上限)
  for (const [token, peak] of sdPeakByToken) {
    assert.ok(peak <= 2, `账号 ${token} 并发峰值应 <=2, got ${peak}`)
  }
  assert.equal(sdPeakByToken.size, 2, '两个账号都应被真正用上')
  // 两个账号各 admit 一次(每账号一条会话,不多买)
  assert.equal(state.sessionPosts, 2, `两个账号各 admit 一次, got ${state.sessionPosts}`)

  globalThis.fetch = sdOrigFetch
  await sdRuntimes.shutdown()
  sdServer.close()
  fs.rmSync(sdDir, { recursive: true, force: true })
}
