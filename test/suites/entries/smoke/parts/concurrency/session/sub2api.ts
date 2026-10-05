/**
 * concurrency: 溢出换号
 *
 * 并发上限是溢出阈值而不是换号阈值.
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

// sub2api 场景:恒定 user 不参与选号,仍复用同模型热 session
{
  const subDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-sub2api-'))
  saveAccountUser(subDir, { id: 'sa', email: 'sa@example.com', authToken: 'token-sa' })
  saveAccountUser(subDir, { id: 'sb', email: 'sb@example.com', authToken: 'token-sb' })
  saveAccountUser(subDir, { id: 'sc', email: 'sc@example.com', authToken: 'token-sc' })
  const subConfig = loadConfig()
  subConfig.server.host = '127.0.0.1'
  subConfig.server.port = 0
  subConfig.server.apiKeys = ['sk-test']
  subConfig.upstream.credentialsDir = subDir
  subConfig.session.pollIntervalSec = 3600
  const subRuntimes = new AccountRuntimes(subConfig)
  const subServer = await startServer({
    config: subConfig,
    runtimes: subRuntimes,
    ...(() => {
      const rt = subRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const subPort = subServer.address().port
  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const seenAccounts = new Map()
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`http://127.0.0.1:${subPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        user: 'sub2api-fixed-user', // 恒定 user，不应成为会话 key
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    const acc = res.headers.get('x-freebuff-proxy-account')
    seenAccounts.set(acc, (seenAccounts.get(acc) || 0) + 1)
    // 无会话分组:请求头也不回传 conv-key
    assert.equal(res.headers.get('x-freebuff-proxy-conv-key'), null)
  }
  assert.equal(seenAccounts.get('sa@example.com'), 6)
  assert.equal(seenAccounts.get('sb@example.com'), undefined)
  assert.equal(seenAccounts.get('sc@example.com'), undefined)
  assert.equal(state.sessionPosts, 1, `expected one admission, got ${state.sessionPosts}`)
  await subRuntimes.shutdown()
  subServer.close()
  fs.rmSync(subDir, { recursive: true, force: true })
}
