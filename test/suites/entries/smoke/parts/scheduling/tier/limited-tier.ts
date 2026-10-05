/**
 * scheduling: limited 档位不是封锁
 *
 * VPN / 非 allowlist 国家可用但受限, 判成封锁会把可用账号判死.
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

// limited 档位(accessTier: limited + anonymous_network)不是封锁:
// 官方源码写明 "everywhere else, and any VPN, is limited access" ---- 它只是
// 模型集合变小,Freebucks 25→20,账号可用.判成封锁 = 把可用账号判死并白烧额度.
{
  const ltDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-limited-'))
  saveAccountUser(ltDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  const ltConfig = loadConfig()
  ltConfig.server.host = '127.0.0.1'
  ltConfig.server.port = 0
  ltConfig.server.apiKeys = ['sk-test']
  ltConfig.upstream.credentialsDir = ltDir
  ltConfig.session.pollIntervalSec = 3600
  const ltRuntimes = new AccountRuntimes(ltConfig)
  const ltServer = await startServer({
    config: ltConfig,
    runtimes: ltRuntimes,
    ...(() => {
      const rt = ltRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const ltPort = ltServer.address().port
  state.mockMode = 'limited_tier'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${ltPort}/v1/chat/completions`, {
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
  const ltBody = await res.json()
  assert.equal(res.status, 200, 'limited 档位必须可用，不是封锁: ' + JSON.stringify(ltBody))
  const ltSnap = ltRuntimes.get('a').sessions.getSnapshot()
  assert.equal(ltSnap?.status, 'active', 'limited 档位下会话必须正常建立')
  assert.equal(
    ltRuntimes.list().find((x) => x.email === 'a@example.com')?.available,
    true,
    'limited 档位的账号不能被判成不可用',
  )
  await ltRuntimes.shutdown()
  ltServer.close()
  fs.rmSync(ltDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
