/**
 * concurrency: 幽灵连接
 *
 * 上游流 idle 超时(zero bytes 未落地 → 换号; partial bytes 已落地 → 冷却当前账号).
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { state } from '../../../../../smoke/state.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- 幽灵连接:上游流 idle 超时(zero bytes 未落地)→ 换号重试 ---
{
  const stDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-stall-'))
  saveAccountUser(stDir, { id: 'sa', email: 'sa@example.com', authToken: 'token-sa' })
  saveAccountUser(stDir, { id: 'sb', email: 'sb@example.com', authToken: 'token-sb' })
  const stConfig = loadConfig()
  stConfig.server.host = '127.0.0.1'
  stConfig.server.port = 0
  stConfig.server.apiKeys = ['sk-test']
  stConfig.upstream.credentialsDir = stDir
  stConfig.session.pollIntervalSec = 3600
  stConfig.limits.streamIdleTimeoutSec = 1

  const stRuntimes = new AccountRuntimes(stConfig)
  const stServer = await startServer({
    config: stConfig,
    runtimes: stRuntimes,
    ...(() => {
      const rt = stRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const stPort = stServer.address().port

  // spa 的流式响应只开不关(幽灵连接,一个字节都不吐)→ 连接被掐断而不是永远挂着
  state.mockMode = 'stall_zero'
  state.sessionPosts = 0
  state.completionAttempts = 0
  const started = Date.now()
  let stRes
  try {
    stRes = await fetch(`http://127.0.0.1:${stPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
    })
    let stBody = ''
    try { stBody = await stRes.text() } catch { stBody = '' }
    assert.ok(
      stBody.trim() === '' || stBody.includes('hi') || stBody.includes('hello'),
      `unexpected body: ${stBody.slice(0, 60)}`,
    )
  } catch (fetchErr) {
    // 连接被掐断导致 fetch 直接失败也符合预期（不挂死即可）
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed < 30_000, `stall zero test took too long: ${elapsed}ms`)

  // 幽灵连接(流 idle 超时被掐断)→ 账号短暂冷却(stallCooldownSec 默认 30s):
  // 该账号刚被掐断过一条卡死链路,下一请求应切到另一个账号,而不是继续撞同一条链路.
  state.mockMode = 'ok'
  const stRes2 = await fetch(`http://127.0.0.1:${stPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(stRes2.status, 200, await stRes2.clone().text())
  assert.ok(stRes2.headers.get('x-freebuff-proxy-account'), 'expected an account')
  assert.equal(state.sessionPosts, 2, `stall 后应切换到另一账号重新 admit, got ${state.sessionPosts}`)
  assert.equal(
    stRuntimes.list().find((x) => x.email === 'sa@example.com').available,
    false,
    '被掐断的账号应短暂冷却',
  )
  await stRuntimes.shutdown()
  stServer.close()
  fs.rmSync(stDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}

// --- 幽灵连接:上游流 idle 超时(partial bytes 已落地)→ 冷却当前账号 + 断开连接 ---
//   后续请求应切到另一个可用账号
{
  const spDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-stall-partial-'))
  saveAccountUser(spDir, { id: 'spa', email: 'spa@example.com', authToken: 'token-spa' })
  saveAccountUser(spDir, { id: 'spb', email: 'spb@example.com', authToken: 'token-spb' })
  const spConfig = loadConfig()
  spConfig.server.host = '127.0.0.1'
  spConfig.server.port = 0
  spConfig.server.apiKeys = ['sk-test']
  spConfig.upstream.credentialsDir = spDir
  spConfig.session.pollIntervalSec = 3600
  spConfig.limits.streamIdleTimeoutSec = 1
  // stallCooldownSec=0:关闭掐断后的冷却(保留旧行为可配置)----验证该开关
  // 关闭时,幽灵连接只断开连接,下一请求仍可复用同一会话
  spConfig.limits.stallCooldownSec = 0

  const spRuntimes = new AccountRuntimes(spConfig)
  const spServer = await startServer({
    config: spConfig,
    runtimes: spRuntimes,
    ...(() => {
      const rt = spRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const spPort = spServer.address().port

  // 第一个请求打到 spa:partial stall(已下发部分字节后卡死)→ 连接被掐断,
  // 客户端收到截断的 SSE 而不是永远挂着
  state.mockMode = 'stall_partial'
  state.sessionPosts = 0
  state.completionAttempts = 0
  const spStart = Date.now()
  const spRes1 = await fetch(`http://127.0.0.1:${spPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  let spText1 = ''
  try { spText1 = await spRes1.text() } catch { spText1 = '' }
  assert.ok(
    spText1.trim() === '' || spText1.includes('hi'),
    `expected truncated SSE body, got: ${spText1.slice(0, 60)}`,
  )
  assert.ok(Date.now() - spStart < 30_000, `partial stall test took too long: ${Date.now() - spStart}ms`)

  // 幽灵连接不冷却同账号(只是断开连接);第二个请求仍可复用同一会话
  state.mockMode = 'ok'
  const spRes2 = await fetch(`http://127.0.0.1:${spPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(spRes2.status, 200, await spRes2.clone().text())
  const spAccount = spRes2.headers.get('x-freebuff-proxy-account')
  assert.ok(spAccount, `expected an account, got empty`)
  assert.equal(state.sessionPosts, 1, `should reuse one session, got ${state.sessionPosts}`)

  await spRuntimes.shutdown()
  spServer.close()
  fs.rmSync(spDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
