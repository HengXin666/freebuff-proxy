/**
 * spread: 关 spread + 上限 3
 *
 * 满了换号, 不把并发钉死在一个账号.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../src/config.ts'
import { startServer } from '../../../../../../src/server.ts'
import { state } from '../../../../smoke/state.ts'
import { jsonRes } from '../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- regression: spread 关 + 并发上限 3 → 满了换号, 不把并发钉死在一个账号 ---
// 场景: 关闭免费模型分散(模型实际已收费), 上限设 3; 并发超出 3 时必须
// 换到下一个有空闲槽位的账号.
{
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-capspill-'))
  saveAccountUser(capDir, { id: 'cpa', email: 'cpa@example.com', authToken: 'token-cpa' })
  saveAccountUser(capDir, { id: 'cpb', email: 'cpb@example.com', authToken: 'token-cpb' })
  const capConfig = loadConfig()
  capConfig.server.host = '127.0.0.1'
  capConfig.server.port = 0
  capConfig.server.apiKeys = ['sk-test']
  capConfig.upstream.credentialsDir = capDir
  capConfig.session.pollIntervalSec = 3600
  capConfig.limits.maxConcurrentRequests = 12
  /**
   * - 必须显式把单账号并发上限设成 3(与下面"上游并发峰值应为 3"的断言一致).
   */
  capConfig.limits.accountMaxConcurrency = 3
  const capRuntimes = new AccountRuntimes(capConfig, {
    getAccountConcurrency: () => 3,   // 用户设置的每账号并发上限
  })
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

  let streamActive = 0
  let streamActiveMax = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return origFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        let closed = false
        streamActive++
        if (streamActive > streamActiveMax) streamActiveMax = streamActive
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            async function emit(i) {
              /**
               * - 帧数必须足够多:并发峰值是瞬时采样,
               * 若每条流只活 ~500ms,而排队放行本身有耗时,
               * 就可能出现"第 1 条已结束,第 3 条还没放行"的窗口,
               * 采样峰值只有 2 → 断言间歇性失败(不是实现缺陷).
               * 让每条流活 ~2s,三条必然同时在飞,峰值才稳定等于上限.
               */
              if (i >= 20 || closed) {
                streamActive = Math.max(0, streamActive - 1)
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
            streamActive = Math.max(0, streamActive - 1)
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

  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.completionAttempts = 0
  // 8 个并发流,上限 3 → 全部挤在 cpa(3 并行 + 其余排队),不启用第二个账号
  const capReqs = Array.from({ length: 8 }, () =>
    fetch(`http://127.0.0.1:${capPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
  )
  const capResponses = await Promise.all(capReqs)
  const capAccounts = []
  for (const r of capResponses) {
    assert.equal(r.status, 200, await r.clone().text())
    capAccounts.push(r.headers.get('x-freebuff-proxy-account'))
  }
  const byEmail = {}
  for (const a of capAccounts) byEmail[a] = (byEmail[a] || 0) + 1
  // 核心断言:粘性优先----8 条流全在 cpa 上(3 条并行 + 排队),
  // 不为了并发去启用从未用过的 cpb(换号 = 多买一条 Freebucks 计费会话)
  assert.deepEqual(byEmail, { 'cpa@example.com': 8 }, `应全部粘在 cpa, got ${JSON.stringify(byEmail)}`)
  assert.equal(state.sessionPosts, 1, `只应 admit 一次, got ${state.sessionPosts}`)
  assert.equal(streamActiveMax, 3, `单账号并发上限 3 → 上游并发峰值应为 3, got ${streamActiveMax}`)
  assert.equal(
    capRuntimes.list().find((r) => r.key === 'cpb').used,
    false,
    'cpb 不应被启用',
  )

  // 冷态顺序请求仍复用热 session(不无谓 admit):
  state.sessionPosts = 0
  const seq = await fetch(`http://127.0.0.1:${capPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(seq.status, 200, await seq.clone().text())
  assert.equal(state.sessionPosts, 0, `热 session 复用：顺序请求不应再 admit, got ${state.sessionPosts}`)

  globalThis.fetch = origFetch
  await capRuntimes.shutdown()
  capServer.close()
  fs.rmSync(capDir, { recursive: true, force: true })
}
