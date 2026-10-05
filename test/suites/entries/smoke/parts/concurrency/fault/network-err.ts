/**
 * concurrency: 网络层错误换号
 *
 * fetch 抛异常时同账号重试一次再换号.
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

// 网络错误(fetch 抛异常)→ 换号重试,最终成功
{
  const netDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-net-'))
  saveAccountUser(netDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(netDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const netConfig = loadConfig()
  netConfig.server.host = '127.0.0.1'
  netConfig.server.port = 0
  netConfig.server.apiKeys = ['sk-test']
  netConfig.upstream.credentialsDir = netDir
  netConfig.session.pollIntervalSec = 3600
  const netRuntimes = new AccountRuntimes(netConfig)
  const netServer = await startServer({
    config: netConfig,
    runtimes: netRuntimes,
    ...(() => {
      const rt = netRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const netPort = netServer.address().port
  state.mockMode = 'network_err_a'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${netPort}/v1/chat/completions`, {
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
  assert.equal(state.sessionPosts, 2, `expected 2 session POSTs, got ${state.sessionPosts}`)
  await netRuntimes.shutdown()
  netServer.close()
  fs.rmSync(netDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
