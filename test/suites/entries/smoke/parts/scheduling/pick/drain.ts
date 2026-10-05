/**
 * scheduling: 粘性优先调度
 *
 * drain 而非 rotate: 集中用一个账号, 未用过的排最后.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { state } from '../../../../../smoke/state.ts'
import { releaseHoldStreams } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 流量切换(代理池变更)不得掐断在途 SSE:旧 runtime 优雅回收
{
  const pDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-drain-'))
  saveAccountUser(pDir, { id: 'pa', email: 'pa@example.com', authToken: 'token-pa' })
  const pConfig = loadConfig()
  pConfig.server.host = '127.0.0.1'
  pConfig.server.port = 0
  pConfig.server.apiKeys = ['sk-test']
  pConfig.upstream.credentialsDir = pDir
  pConfig.session.pollIntervalSec = 3600
  const pRuntimes = new AccountRuntimes(pConfig)
  const pServer = await startServer({
    config: pConfig,
    runtimes: pRuntimes,
    ...(() => {
      const rt = pRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const pBase = `http://127.0.0.1:${pServer.address().port}`
  const oldRt = pRuntimes.get('pa')

  state.mockMode = 'hold_once'
  state.sessionPosts = 0
  state.sessionDeletes = 0
  state.completionAttempts = 0
  const res = await fetch(`${pBase}/v1/chat/completions`, {
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
  assert.equal(res.status, 200)
  assert.equal(oldRt.sessions.inFlightCount(), 1)

  // 切换代理池:立即让位,但旧流不能被掐断
  pConfig.upstream.proxies = ['http://p1.example:7890']
  await pRuntimes.invalidateProxies()
  assert.equal(pRuntimes.isCurrentRuntime(oldRt), false)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(state.sessionDeletes, 0, '代理切换不得在流在途时删除旧 session')

  // 旧流正常结束 ---- 但会话不删.
  //
  // 代理切换是系统内部的运维动作, 不是用户对某条会话的显式意图; 而这条会话
  // 仍在已付费的一小时内(admit 时买断整小时, 早退不退 Freebucks).
  // 所以让位只让出 runtime, 那张已付款的一小时留给调度层复用(下次请求按
  // holderFor 接管)或到点自然过期 ---- 见 src/session/release/release.ts 的
  // releaseWhenIdle 与 .agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md.
  releaseHoldStreams()
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(
    state.sessionDeletes,
    0,
    '代理切换不得删除仍在付费时段内的会话（那一小时已实付，DELETE 不退钱）',
  )
  assert.equal(state.sessionPosts, 1, '切换本身不应新增 admit（新请求才走新出口）')

  await pRuntimes.shutdown()
  pServer.close()
  fs.rmSync(pDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
