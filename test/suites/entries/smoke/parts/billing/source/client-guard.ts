/**
 * billing: 源码级防回归
 *
 * (SRC-GUARD) 变量遮蔽与被改名后的残留引用, 只在运行时特定分支才炸.
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

// --- 回归:客户端在"首字节前的静默等待"中断开 → 绝不钉死账号并发 ---
// 线上症状:跑着跑着完全不接单,只有重启才恢复.根因是调度阶段的等待
// (全局槽位 / 账号 chat 锁)完全不感知客户端断开:客户端(DSH/sub2api)早已
// 超时走人,代理却还在闷等,并且拿到账号锁后继续把整个上游流程跑完----
// 死请求占着账号并发(默认仅 2,且粘性调度把请求集中到同一账号),
// 攒够几个就再也没有新请求能拿到锁.
{
  const cgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-clientgone-'))
  saveAccountUser(cgDir, { id: 'cg', email: 'cg@example.com', authToken: 'token-cg' })
  const cgConfig = loadConfig()
  cgConfig.server.host = '127.0.0.1'
  cgConfig.server.port = 0
  cgConfig.server.apiKeys = ['sk-test']
  cgConfig.upstream.credentialsDir = cgDir
  cgConfig.session.pollIntervalSec = 3600
  // 单账号,并发 1:唯一槽位被占用后,第二个请求必须排队 ---- 正是线上场景.
  cgConfig.limits.accountMaxConcurrency = 1
  cgConfig.limits.streamIdleTimeoutSec = 1
  // 把账号锁等待拉长,确保"断开前"确实处于等待态(旧代码会一直等下去).
  cgConfig.limits.accountChatWaitMs = 120_000
  cgConfig.limits.schedulingBudgetMs = 60_000

  const cgRuntimes = new AccountRuntimes(cgConfig)
  const cgServer = await startServer({
    config: cgConfig,
    runtimes: cgRuntimes,
    ...(() => {
      const rt = cgRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const cgPort = cgServer.address().port

  state.mockMode = 'hold_once'
  state.sessionPosts = 0
  state.completionAttempts = 0

  // A:占住唯一并发槽(流被挂起保持打开)
  const resA = await fetch(`http://127.0.0.1:${cgPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hold' }],
    }),
  })
  assert.equal(resA.status, 200)
  await waitFor('A 应占住唯一并发槽', () => cgRuntimes.chatInFlight('cg') === 1)

  // B:用裸 socket 发第二个流式请求(要能在等待中途"拔线"----fetch 做不到),
  // 拿到账号锁之前就断开,模拟客户端等不住自行超时.
  const beforeAttempts = state.completionAttempts
  const rawSock = net.connect(cgPort, '127.0.0.1')
  const bodyStr = JSON.stringify({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'will-abort' }],
  })
  await new Promise((resolve, reject) => {
    rawSock.once('connect', resolve)
    rawSock.once('error', reject)
  })
  rawSock.write(
    'POST /v1/chat/completions HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${cgPort}\r\n` +
      'Authorization: Bearer sk-test\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(bodyStr)}\r\n` +
      'Connection: close\r\n\r\n' +
      bodyStr,
  )
  // 等 B 真正进入"排队等账号锁"状态,再断开.旧代码在这里会一直等到
  // accountChatWaitMs(120s)才对客户端超时;新代码感知断开立即退出.
  await new Promise((r) => setTimeout(r, 300))
  rawSock.destroy()

  // 关键断言:B 断开后,死请求不得继续推进上游请求.
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, 1_500))
  assert.equal(
    state.completionAttempts,
    beforeAttempts,
    '客户端断开后代理仍继续推进上游请求（死请求钉死账号并发）',
  )

  // 释放 A 的挂起流,确认账号并发能正常回归 0(槽位没有泄漏).
  releaseHoldStreams()
  try {
    await resA.text()
  } catch {
    /* 被 idle 掐断也符合预期 */
  }
  await waitFor(
    'A 结束后账号并发应回到 0（锁未泄漏）',
    () => cgRuntimes.chatInFlight('cg') === 0,
    8_000,
    25,
  )
  assert.ok(
    Date.now() - t0 < 20_000,
    `断开处理应快速收场, took ${Date.now() - t0}ms`,
  )

  await cgRuntimes.shutdown()
  cgServer.close()
  fs.rmSync(cgDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
