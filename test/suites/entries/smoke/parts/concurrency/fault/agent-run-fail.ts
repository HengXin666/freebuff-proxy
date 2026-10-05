/**
 * concurrency: startAgentRun 失败
 *
 * 500 / 403 两种 agent-run 失败都算账号级故障.
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

// startAgentRun 500 → 冷却当前账号换下一个,最终成功
{
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-run500-'))
  saveAccountUser(runDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(runDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const runConfig = loadConfig()
  runConfig.server.host = '127.0.0.1'
  runConfig.server.port = 0
  runConfig.server.apiKeys = ['sk-test']
  runConfig.upstream.credentialsDir = runDir
  runConfig.session.pollIntervalSec = 3600
  const runRuntimes = new AccountRuntimes(runConfig)
  const runServer = await startServer({
    config: runConfig,
    runtimes: runRuntimes,
    ...(() => {
      const rt = runRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const runPort = runServer.address().port
  state.mockMode = 'run_500_a'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${runPort}/v1/chat/completions`, {
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
  const runAccounts = runRuntimes.list()
  const runA = runAccounts.find((x) => x.email === 'a@example.com')
  assert.equal(runA.available, false)
  assert.equal(runA.cooldownCode, 'start_agent_run_failed')
  await runRuntimes.shutdown()
  runServer.close()
  fs.rmSync(runDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}

// startAgentRun 403(start_agent_run_failed,非账号级封禁 code)→ 也应冷却
// 当前账号换下一个,最终成功(回归:403 不在换号条件内,曾不换号,首次即报错给用户)
{
  const run403Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-run403-'))
  saveAccountUser(run403Dir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(run403Dir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const run403Config = loadConfig()
  run403Config.server.host = '127.0.0.1'
  run403Config.server.port = 0
  run403Config.server.apiKeys = ['sk-test']
  run403Config.upstream.credentialsDir = run403Dir
  run403Config.session.pollIntervalSec = 3600
  const run403Runtimes = new AccountRuntimes(run403Config)
  const run403Server = await startServer({
    config: run403Config,
    runtimes: run403Runtimes,
    ...(() => {
      const rt = run403Runtimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const run403Port = run403Server.address().port
  state.mockMode = 'run_403_a'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${run403Port}/v1/chat/completions`, {
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
  const run403Accounts = run403Runtimes.list()
  const run403A = run403Accounts.find((x) => x.email === 'a@example.com')
  assert.equal(run403A.available, false)
  assert.equal(run403A.cooldownCode, 'start_agent_run_failed')
  await run403Runtimes.shutdown()
  run403Server.close()
  fs.rmSync(run403Dir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
