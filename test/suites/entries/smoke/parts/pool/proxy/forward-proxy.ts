/**
 * pool: 转发代理
 *
 * 真实转发代理链路上的出口与降级.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { state } from '../../../../../smoke/state.ts'
import { waitFor } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 排队等锁期间发生代理切换 → 请求无冷却重新选号,不撞已失效旧 runtime
// 真实代理链路:本地 mock 上游 + 本地转发代理(单代理池必须真的走代理,回归 issue #5)
{
  const { createMockUpstreamServer, createForwardProxy } = await import('../../../../../../tools/proxy-test-helpers.ts')
  const qDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-queue-switch-'))
  saveAccountUser(qDir, { id: 'qa', email: 'qa@example.com', authToken: 'token-qa' })
  const holdResponses = []
  const releaseQHolds = () => {
    for (const hres of holdResponses.splice(0)) {
      try {
        hres.write('data: [DONE]\n\n')
        hres.end()
      } catch {
        // ignore
      }
    }
  }
  const qUpstream = await createMockUpstreamServer({
    sessionPosts: () => state.sessionPosts,
    bumpSessionPosts: () => { state.sessionPosts++ },
    bumpSessionDeletes: () => { state.sessionDeletes++ },
    completionAttempts: () => state.completionAttempts,
    bumpCompletionAttempts: () => { state.completionAttempts++ },
    getMockMode: () => state.mockMode,
    holdStreamControllers: state.holdStreamControllers,
    holdResponses,
  })
  const qProxy = await createForwardProxy()
  const qConfig = loadConfig()
  qConfig.server.host = '127.0.0.1'
  qConfig.server.port = 0
  qConfig.server.apiKeys = ['sk-test']
  qConfig.upstream.credentialsDir = qDir
  qConfig.upstream.apiBase = `http://127.0.0.1:${qUpstream.port}`
  qConfig.session.pollIntervalSec = 3600
  qConfig.limits.accountMaxConcurrency = 1
  const qRuntimes = new AccountRuntimes(qConfig)
  const qServer = await startServer({
    config: qConfig,
    runtimes: qRuntimes,
    ...(() => {
      const rt = qRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const qBase = `http://127.0.0.1:${qServer.address().port}`

  state.mockMode = 'hold_once'
  state.sessionPosts = 0
  state.sessionDeletes = 0
  state.completionAttempts = 0
  const oldRt = qRuntimes.get('qa')
  // A:占住账号唯一并发槽(流保持打开)
  const resA = await fetch(`${qBase}/v1/chat/completions`, {
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
  })
  assert.equal(resA.status, 200)
  assert.equal(oldRt.sessions.inFlightCount(), 1)
  // B:开始后会在 chat 锁上排队
  const resBPromise = fetch(`${qBase}/v1/chat/completions`, {
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
  })
  await new Promise((r) => setTimeout(r, 150))
  // 等待期间切换代理池 → 旧 runtime 被顶替(单代理池,真实本地代理)
  qConfig.upstream.proxies = [`http://127.0.0.1:${qProxy.port}`]
  await qRuntimes.invalidateProxies()
  assert.equal(qRuntimes.isCurrentRuntime(oldRt), false)
  // 放行 A;B 拿到锁后应检测到 runtime 已过期 → 无冷却重新选号 → 走新出口成功
  releaseQHolds()
  await resA.text()
  const resB = await resBPromise
  assert.equal(resB.status, 200, await resB.clone().text())
  assert.match(await resB.text(), /data: \[DONE\]/)
  assert.equal(state.sessionPosts, 2, 'B 应在新 runtime 上 admit 新 session')
  // A 的旧 session 由优雅回收释放
  await waitFor('排队切换后旧 session 优雅释放', () => state.sessionDeletes >= 1)

  await qRuntimes.shutdown()
  qServer.close()
  qUpstream.server.close()
  qProxy.server.close()
  fs.rmSync(qDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
