/**
 * concurrency: 下游背压与账号卡死
 *
 * 客户端不读导致 idle 超时后账号锁必须释放; 在途流占死唯一槽位时其他连接要能换号.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { state } from '../../../../../smoke/state.ts'
import { releaseHoldStreams, waitFor } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// --- 幽灵连接:下游背压(客户端不读)→ idle 超时后账号锁必须释放 ---
//   回归:write() 返回 false 后裸等 drain(无 idle 定时器),客户端"活着但
//   不再读"(网络波动/卡顿)会永久挂起 → 账号 chat 锁占死,后续请求全部超时
{
  const bdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-backpressure-'))
  saveAccountUser(bdDir, { id: 'bda', email: 'bda@example.com', authToken: 'token-bda' })
  const bdConfig = loadConfig()
  bdConfig.server.host = '127.0.0.1'
  bdConfig.server.port = 0
  bdConfig.server.apiKeys = ['sk-test']
  bdConfig.upstream.credentialsDir = bdDir
  bdConfig.session.pollIntervalSec = 3600
  bdConfig.limits.streamIdleTimeoutSec = 1
  // 本用例只验证"背压 → idle 超时 → 锁释放",不验证掐断后冷却(由 stall_zero 覆盖)
  bdConfig.limits.stallCooldownSec = 0

  const bdRuntimes = new AccountRuntimes(bdConfig)
  const bdServer = await startServer({
    config: bdConfig,
    runtimes: bdRuntimes,
    ...(() => {
      const rt = bdRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const bdPort = bdServer.address().port

  // 原始 TCP 客户端:发请求后绝不读响应(窗口满 → 背压)
  state.mockMode = 'bigstall'
  state.sessionPosts = 0
  state.completionAttempts = 0
  const sock = net.connect(bdPort, '127.0.0.1')
  try {
    sock.setRecvBufferSize(1024) // 缩小接收窗口,尽快触发背压
  } catch {
    // 平台不支持则忽略
  }
  const bdBody = JSON.stringify({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  sock.write(
    `POST /v1/chat/completions HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${bdPort}\r\n` +
      `Authorization: Bearer sk-test\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(bdBody)}\r\n\r\n` +
      bdBody,
  )
  // 先等请求真正获取到账号锁(否则 waitFor(===0) 在锁未获取时就成立,空转通过)
  await waitFor(
    '背压请求应获取账号锁',
    () => bdRuntimes.chatInFlight('bda') === 1,
    10_000,
  )
  // 客户端不读响应 → 大块写触发下游背压;账号锁必须在 idle 超时(1s)后释放
  await waitFor(
    '背压卡死时账号锁应在 idle 超时后释放',
    () => bdRuntimes.chatInFlight('bda') === 0,
    10_000,
  )
  sock.destroy()

  // 锁已释放 → 下一个请求立即可用(不再排队超时)
  state.mockMode = 'ok'
  const bdRes = await fetch(`http://127.0.0.1:${bdPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(bdRes.status, 200, await bdRes.clone().text())
  await bdRes.text()

  await bdRuntimes.shutdown()
  bdServer.close()
  fs.rmSync(bdDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}

// --- 账号被卡死(在途流占死唯一并发槽)时,其他连接换号成功而不是全部超时 ---
{
  const waDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-wedge-'))
  saveAccountUser(waDir, { id: 'wa', email: 'wa@example.com', authToken: 'token-wa' })
  saveAccountUser(waDir, { id: 'wb', email: 'wb@example.com', authToken: 'token-wb' })
  const waConfig = loadConfig()
  waConfig.server.host = '127.0.0.1'
  waConfig.server.port = 0
  waConfig.server.apiKeys = ['sk-test']
  waConfig.upstream.credentialsDir = waDir
  waConfig.session.pollIntervalSec = 3600
  waConfig.limits.streamIdleTimeoutSec = 1
  waConfig.limits.accountMaxConcurrency = 1

  const waRuntimes = new AccountRuntimes(waConfig) // 默认粘性调度(集中用一个账号)
  const waServer = await startServer({
    config: waConfig,
    runtimes: waRuntimes,
    ...(() => {
      const rt = waRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const waPort = waServer.address().port
  const waChat = (model = 'deepseek/deepseek-v4-flash', stream = true) =>
    fetch(`http://127.0.0.1:${waPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hello' }] }),
    })

  state.mockMode = 'hold_once'
  state.sessionPosts = 0
  state.completionAttempts = 0
  // A:wa 占住唯一并发槽(hold 流保持打开)
  const resA = await waChat()
  assert.equal(resA.status, 200)
  assert.equal(waRuntimes.chatInFlight('wa'), 1, 'hold 流应占用 wa 的唯一并发槽')
  // B:立刻打第二个请求 → 粘性调度先在 wa 上有界排队;卡死的流会被 idle
  // 超时(1s)掐断释放槽位,B 随即在 wa 上成功,而不是全部超时.
  const t0 = Date.now()
  const resB = await waChat()
  assert.equal(resB.status, 200, await resB.clone().text())
  assert.equal(
    resB.headers.get('x-freebuff-proxy-account'),
    'wa@example.com',
    '粘性优先：卡死流被 idle 超时掐断后，排队请求仍在 wa 上完成',
  )
  assert.ok(Date.now() - t0 < 15_000, `排队应有界快速完成, took ${Date.now() - t0}ms`)
  await resB.text()
  // 放行 A 的 hold(可能已被 idle 超时掐断,容错)
  releaseHoldStreams()
  try { await resA.text() } catch { /* 被 idle 掐断也符合预期 */ }

  await waRuntimes.shutdown()
  waServer.close()
  fs.rmSync(waDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
