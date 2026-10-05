/**
 * concurrency: capacity_deferred 不冷却
 *
 * 瞬时容量排队, 同 session 重试即恢复.
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

// free_mode_capacity_deferred → 同一热 session 重试且不冷却
{
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-cap-'))
  saveAccountUser(capDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(capDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const capConfig = loadConfig()
  capConfig.server.host = '127.0.0.1'
  capConfig.server.port = 0
  capConfig.server.apiKeys = ['sk-test']
  capConfig.upstream.credentialsDir = capDir
  capConfig.session.pollIntervalSec = 3600
  const capRuntimes = new AccountRuntimes(capConfig)
  const capServer = await startServer({
    config: capConfig,
    runtimes: capRuntimes,
    ...(() => {
      const rt = capRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const capPort = capServer.address().port
  state.mockMode = 'capacity_once'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${capPort}/v1/chat/completions`, {
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
  // 同一 session 立即重试即可恢复, 不为瞬时容量再开一个 session.
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'a@example.com')
  assert.equal(state.sessionPosts, 1, `capacity retry should reuse session, got ${state.sessionPosts}`)
  const capAccounts = capRuntimes.list()
  assert.equal(
    capAccounts.find((x) => x.email === 'a@example.com').available,
    true,
    'capacity_deferred 不应冷却账号',
  )
  assert.equal(capAccounts.find((x) => x.email === 'b@example.com').available, true)
  await capRuntimes.shutdown()
  capServer.close()
  fs.rmSync(capDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}

// 持续 capacity_deferred → 返回错误但不冷却(下次请求仍可复用)
{
  const capDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-cap2-'))
  saveAccountUser(capDir2, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(capDir2, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const capConfig2 = loadConfig()
  capConfig2.server.host = '127.0.0.1'
  capConfig2.server.port = 0
  capConfig2.server.apiKeys = ['sk-test']
  capConfig2.upstream.credentialsDir = capDir2
  capConfig2.session.pollIntervalSec = 3600
  const capRuntimes2 = new AccountRuntimes(capConfig2)
  const capServer2 = await startServer({
    config: capConfig2,
    runtimes: capRuntimes2,
    ...(() => {
      const rt = capRuntimes2.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const capPort2 = capServer2.address().port
  state.mockMode = 'capacity_all'
  state.sessionPosts = 0
  state.completionAttempts = 0
  const res2 = await fetch(`http://127.0.0.1:${capPort2}/v1/chat/completions`, {
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
  assert.equal(res2.status, 429)
  const capAccounts2 = capRuntimes2.list()
  assert.equal(
    capAccounts2.every((x) => x.available),
    true,
    '全部 capacity_deferred 也不应冷却任何账号',
  )
  await capRuntimes2.shutdown()
  capServer2.close()
  fs.rmSync(capDir2, { recursive: true, force: true })
  state.mockMode = 'ok'
}
