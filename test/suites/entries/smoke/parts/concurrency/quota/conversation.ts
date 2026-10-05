/**
 * scheduling: conversation_id 不参与选号
 *
 * 同模型热 session 始终复用, 会话记忆不决定账号.
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

// --- session-first:conversation_id 不参与选号,同模型热 session 始终复用 ---
{
  const convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-conv-'))
  saveAccountUser(convDir, { id: 'da', email: 'da@example.com', authToken: 'token-da' })
  saveAccountUser(convDir, { id: 'db', email: 'db@example.com', authToken: 'token-db' })
  saveAccountUser(convDir, { id: 'dc', email: 'dc@example.com', authToken: 'token-dc' })
  const convConfig = loadConfig()
  convConfig.server.host = '127.0.0.1'
  convConfig.server.port = 0
  convConfig.server.apiKeys = ['sk-test']
  convConfig.upstream.credentialsDir = convDir
  convConfig.session.pollIntervalSec = 3600
  const convRuntimes = new AccountRuntimes(convConfig)
  const convServer = await startServer({
    config: convConfig,
    runtimes: convRuntimes,
    ...(() => {
      const rt = convRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const convPort = convServer.address().port

  // 同一会话 key 连续 6 次只创建并复用一个上游 session.
  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const seen = []
  let res
  for (let i = 0; i < 6; i++) {
    res = await fetch(`http://127.0.0.1:${convPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        codebuff_metadata: { conversation_id: 'same-thread-forever' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    seen.push(res.headers.get('x-freebuff-proxy-account'))
  }
  assert.deepEqual(
    seen,
    [
      'da@example.com',
      'da@example.com',
      'da@example.com',
      'da@example.com',
      'da@example.com',
      'da@example.com',
    ],
    `恒定会话 key 应复用热 session, got ${JSON.stringify(seen)}`,
  )
  assert.equal(state.sessionPosts, 1, `expected one admission, got ${state.sessionPosts}`)
  // 同一会话不应再回传会话 key 响应头(无会话分组概念)
  assert.equal(res.headers.get('x-freebuff-proxy-conv-key'), null)

  // 当前账号冷却后才切到下一个账号,并复用新 session.
  convRuntimes.markCooldown('da', {
    code: 'rate_limited',
    retryAfterMs: 60_000,
  })
  const afterCool = []
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`http://127.0.0.1:${convPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        codebuff_metadata: { conversation_id: 'same-thread-forever' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    afterCool.push(res.headers.get('x-freebuff-proxy-account'))
  }
  assert.deepEqual(afterCool, ['db@example.com', 'db@example.com'])
  assert.equal(state.sessionPosts, 2, `failover should add one admission, got ${state.sessionPosts}`)

  await convRuntimes.shutdown()
  convServer.close()
  fs.rmSync(convDir, { recursive: true, force: true })
}
