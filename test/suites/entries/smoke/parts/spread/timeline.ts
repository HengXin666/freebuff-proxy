/**
 * spread: 账号时间轴与会话临近过期
 *
 * 导入 / 凭证更新 / 累计调度时长持久化; 临近过期提前 re-admit.
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

// --- regression: 账号时间轴持久化(导入/凭证更新/累计调度时长)---
{
  const tsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-timeline-'))
  saveAccountUser(tsDir, { id: 'tsa', email: 'tsa@example.com', authToken: 'token-tsa' })
  const tsConfig = loadConfig()
  tsConfig.server.host = '127.0.0.1'
  tsConfig.server.port = 0
  tsConfig.server.apiKeys = ['sk-test']
  tsConfig.upstream.credentialsDir = tsDir
  tsConfig.session.pollIntervalSec = 3600
  const tsRuntimes = new AccountRuntimes(tsConfig, { getAccountConcurrency: () => 1 })
  // 导入时间:新账号应立刻有一个 importedAt(来自凭据文件创建时间)
  const tsRow = tsRuntimes.list().find((a) => a.key === 'tsa')
  assert.ok(tsRow, 'tsa 应在账号列表里')
  assert.ok(tsRow.importedAt, `importedAt 不应为空, got ${tsRow.importedAt}`)
  assert.equal(tsRow.scheduledMs, 0, '新账号累计调度时长应为 0')
  // 凭证更新时间:只有真的写了凭据才记录(导入路径会调用 markCredentialUpdated)
  assert.equal(tsRow.credentialUpdatedAt, null, '未调用前应为 null')
  tsRuntimes.markCredentialUpdated('tsa')
  const tsRow2 = tsRuntimes.list().find((a) => a.key === 'tsa')
  assert.ok(tsRow2.credentialUpdatedAt, `markCredentialUpdated 后应非空`)
  // 累计调度时长:模拟会话在途 1.2s 后归零
  const tsSessions = tsRuntimes.get('tsa').sessions
  tsSessions.beginRequest()
  assert.ok(tsSessions.currentSchedulingMs() >= 0, '在途时应有本轮调度时长')
  await new Promise((r) => setTimeout(r, 1200))
  const runningMs = tsSessions.currentSchedulingMs()
  assert.ok(runningMs >= 1000, `本轮运行时长应 >=1s, got ${runningMs}`)
  tsSessions.endRequest()
  tsRuntimes.flushState()
  const tsRow3 = tsRuntimes.list().find((a) => a.key === 'tsa')
  assert.ok(tsRow3.scheduledMs >= 1000, `累计调度时长应 >=1s, got ${tsRow3.scheduledMs}`)
  assert.equal(tsRow3.currentSchedulingMs, 0, '本轮结束后实时时长应归零')
  // 重启(同 dataDir 新建实例)后这些值必须还在 ---- 持久化的意义就在这里
  const tsRuntimes2 = new AccountRuntimes(tsConfig, { getAccountConcurrency: () => 1 })
  const tsRow4 = tsRuntimes2.list().find((a) => a.key === 'tsa')
  assert.ok(tsRow4.scheduledMs >= 1000, `重启后累计调度时长应保留, got ${tsRow4.scheduledMs}`)
  assert.ok(tsRow4.importedAt, '重启后导入时间应保留')
  assert.ok(tsRow4.credentialUpdatedAt, '重启后凭证更新时间应保留')
  // 起算点必须被清掉: 上一进程的起算点会让界面显示假的"本轮运行 3 天"
  assert.equal(tsRow4.schedulingSince, null, '重启后不应残留本轮起算点')
  await tsRuntimes2.shutdown()
  await tsRuntimes.shutdown()
  fs.rmSync(tsDir, { recursive: true, force: true })
}

// --- 会话临近过期:提前 re-admit 平滑切换(不再把新请求发到马上过期的会话)---
{
  const expDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-expire-'))
  saveAccountUser(expDir, { id: 'ea', email: 'ea@example.com', authToken: 'token-ea' })
  saveAccountUser(expDir, { id: 'eb', email: 'eb@example.com', authToken: 'token-eb' })
  const expConfig = loadConfig()
  expConfig.server.host = '127.0.0.1'
  expConfig.server.port = 0
  expConfig.server.apiKeys = ['sk-test']
  expConfig.upstream.credentialsDir = expDir
  expConfig.session.pollIntervalSec = 3600
  const expRuntimes = new AccountRuntimes(expConfig)
  const expServer = await startServer({
    config: expConfig,
    runtimes: expRuntimes,
    ...(() => {
      const rt = expRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const expPort = expServer.address().port
  const expChat = () => fetch(`http://127.0.0.1:${expPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })

  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.sessionDeletes = 0
  state.completionAttempts = 0
  // 会话有效期只有 30s < reAdmitLeadSec(60s):第二个请求必须提前换新会话
  state.sessionExpiryMs = 30_000
  const e1 = await expChat()
  assert.equal(e1.status, 200, await e1.clone().text())
  assert.equal(state.sessionPosts, 1)
  assert.equal(e1.headers.get('x-freebuff-proxy-account'), 'ea@example.com')
  // 多账号场景: 近过期会话在同一账号 re-admit 续期, 不换到 eb 新建 session
  const e2 = await expChat()
  assert.equal(e2.status, 200, await e2.clone().text())
  assert.equal(state.sessionPosts, 2, `近过期会话应提前 re-admit, got ${state.sessionPosts}`)
  assert.ok(state.sessionDeletes >= 1, 're-admit 前应先释放旧会话')
  assert.equal(e2.headers.get('x-freebuff-proxy-account'), 'ea@example.com')
  assert.equal(
    expRuntimes.list().find((x) => x.email === 'eb@example.com').requests,
    0,
    '近过期会话应在本账号续期，不换账号',
  )

  // 有效期恢复正常(1h > lead)后:e3 先把还差 30s 的旧会话换掉(第 3 次 admit),
  // e4 起新会话剩余 1h,不再重复 admit
  state.sessionExpiryMs = 3600_000
  const e3 = await expChat()
  assert.equal(e3.status, 200, await e3.clone().text())
  assert.equal(state.sessionPosts, 3, `切换后的请求应 admit 一次, got ${state.sessionPosts}`)
  const e4 = await expChat()
  assert.equal(e4.status, 200, await e4.clone().text())
  assert.equal(state.sessionPosts, 3, `正常有效期应复用会话, got ${state.sessionPosts}`)

  state.sessionExpiryMs = 3600_000
  await expRuntimes.shutdown()
  expServer.close()
  fs.rmSync(expDir, { recursive: true, force: true })
}
