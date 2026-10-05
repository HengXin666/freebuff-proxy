/**
 * concurrency: 热 session 复用
 *
 * 同模型活跃 session 优先复用, 创建才扣额度.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { state } from '../../../../../smoke/state.ts'
import { jsonRes } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 无会话ID 的并发请求:粘性调度 + 每账号并发上限 1 → 全部挤在同一账号上排队,
// 不主动开新账号(换号 = 多买一条 Freebucks 计费会话)
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
  rrConfig.limits.maxConcurrentRequests = 24
  const rrRuntimes = new AccountRuntimes(rrConfig, {
    getAccountConcurrency: () => 1,
  })

  // 慢流 mock:每流 ~300ms,保证并发期间锁一直占用,选号结果确定
  let rrActive = 0
  let rrActiveMax = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return origFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        let closed = false
        rrActive++
        if (rrActive > rrActiveMax) rrActiveMax = rrActive
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            async function emit(i) {
              if (i >= 20 || closed) {
                rrActive = Math.max(0, rrActive - 1)
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
            rrActive = Math.max(0, rrActive - 1)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return jsonRes({
        id: 'c1', object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      })
    }
    return origFetch(url, init)
  }

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
  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.completionAttempts = 0
  const concurrent = await Promise.all(
    Array.from({ length: 9 }, () => fetch(`http://127.0.0.1:${rrPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })),
  )
  const rrAccounts = []
  for (const res of concurrent) {
    assert.equal(res.status, 200, await res.clone().text())
    rrAccounts.push(res.headers.get('x-freebuff-proxy-account'))
  }
  // 粘性优先:9 条并发全部挤在 ra 上(有界排队),单账号同时最多 1 条流,
  // 不为了并发去启用从未用过的 rb / rc
  assert.deepEqual(
    [...new Set(rrAccounts)],
    ['ra@example.com'],
    `并发请求应粘在同一账号, got ${JSON.stringify(rrAccounts)}`,
  )
  assert.equal(state.sessionPosts, 1, `只应 admit 一次, got ${state.sessionPosts}`)
  assert.equal(rrActiveMax, 1, `单账号并发上限 1 → 上游并发峰值应为 1, got ${rrActiveMax}`)
  const rrRows = rrRuntimes.list()
  assert.equal(rrRows.find((r) => r.key === 'ra').used, true, 'ra 应标记已用')
  assert.equal(rrRows.find((r) => r.key === 'rb').used, false, 'rb 不应被启用')
  assert.equal(rrRows.find((r) => r.key === 'rc').used, false, 'rc 不应被启用')
  // 满员账号仍排在未用过账号之前(先排队;只有排队超时被 skipKeys 排除后才溢出)
  assert.deepEqual(
    rrRuntimes.candidateKeys('deepseek/deepseek-v4-flash'),
    ['ra', 'rb', 'rc'],
    '满员的已用账号应排在未用过账号之前',
  )
  assert.deepEqual(
    rrRuntimes.candidateKeys('deepseek/deepseek-v4-flash', {
      skipKeys: new Set(['ra']),
    }),
    ['rb', 'rc'],
    '排队超时后应把该账号排除，溢出到下一个',
  )

  globalThis.fetch = origFetch
  await rrRuntimes.shutdown()
  rrServer.close()
  fs.rmSync(rrDir, { recursive: true, force: true })
}
