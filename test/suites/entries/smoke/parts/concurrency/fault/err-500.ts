/**
 * concurrency: 500 整号冷却
 *
 * 账号级故障连续换号, 验证新会话预算.
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

// 上游 500 报错 → 冷却当前账号并换号重试
{
  const e5Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-e500-'))
  saveAccountUser(e5Dir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(e5Dir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const e5Config = loadConfig()
  e5Config.server.host = '127.0.0.1'
  e5Config.server.port = 0
  e5Config.server.apiKeys = ['sk-test']
  e5Config.upstream.credentialsDir = e5Dir
  e5Config.session.pollIntervalSec = 3600
  const e5Runtimes = new AccountRuntimes(e5Config)
  const e5Server = await startServer({
    config: e5Config,
    runtimes: e5Runtimes,
    ...(() => {
      const rt = e5Runtimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const e5Port = e5Server.address().port
  state.mockMode = 'err_500_a'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${e5Port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(state.sessionPosts, 2, `expected 2 session POSTs, got ${state.sessionPosts}`)
  assert.equal(state.completionAttempts, 2)
  const e5Accounts = e5Runtimes.list()
  const e5a = e5Accounts.find((x) => x.email === 'a@example.com')
  assert.equal(e5a.available, false)
  assert.equal(e5a.cooldownCode, 'internal_error')
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  await e5Runtimes.shutdown()
  e5Server.close()
  fs.rmSync(e5Dir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
