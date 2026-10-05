/**
 * concurrency: 同账号连续 gate 失败
 *
 * 连续两次 session_superseded 才升级换号.
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

// 同账号 gate 连续失败两次 → 升级为换号,最终成功
{
  const g2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-gate2-'))
  saveAccountUser(g2Dir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(g2Dir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const g2Config = loadConfig()
  g2Config.server.host = '127.0.0.1'
  g2Config.server.port = 0
  g2Config.server.apiKeys = ['sk-test']
  g2Config.upstream.credentialsDir = g2Dir
  g2Config.session.pollIntervalSec = 3600
  const g2Runtimes = new AccountRuntimes(g2Config)
  const g2Server = await startServer({
    config: g2Config,
    runtimes: g2Runtimes,
    ...(() => {
      const rt = g2Runtimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const g2Port = g2Server.address().port
  state.mockMode = 'gate_twice_a'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${g2Port}/v1/chat/completions`, {
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
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  // a 两次 gate(1 次会话 + 1 次同号 re-admit),b 一次 → 3 次 session POST,3 次 completions
  assert.equal(state.sessionPosts, 3, `expected 3 session POSTs, got ${state.sessionPosts}`)
  assert.equal(state.completionAttempts, 3, `expected 3 completions, got ${state.completionAttempts}`)
  const g2Accounts = g2Runtimes.list()
  const g2a = g2Accounts.find((x) => x.email === 'a@example.com')
  assert.equal(g2a.available, false)
  assert.equal(g2a.cooldownCode, 'session_superseded')
  await g2Runtimes.shutdown()
  g2Server.close()
  fs.rmSync(g2Dir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
