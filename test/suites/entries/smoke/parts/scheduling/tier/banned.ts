/**
 * scheduling: 账号封禁
 *
 * 403 account_suspended 的处置与落盘.
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

// account_suspended(403,error 为字符串)必须归一为 banned:
// 冷却该账号并换号重试,绝不能当客户端 4xx 把错误甩给用户.
// 背景(2026-09-18 线上实测):上游对第三方客户端的封禁回的是
// 403 {"error":"account_suspended"}(error 是字符串,没有 code 字段);
// 不归一它就会落进"4xx 客户端错误不换号"分支,于是每个被封账号被反复复用.
{
  const banDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-ban-'))
  saveAccountUser(banDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(banDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const banConfig = loadConfig()
  banConfig.server.host = '127.0.0.1'
  banConfig.server.port = 0
  banConfig.server.apiKeys = ['sk-test']
  banConfig.upstream.credentialsDir = banDir
  banConfig.session.pollIntervalSec = 3600
  const banRuntimes = new AccountRuntimes(banConfig)
  const banServer = await startServer({
    config: banConfig,
    runtimes: banRuntimes,
    ...(() => {
      const rt = banRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const banPort = banServer.address().port
  state.mockMode = 'suspended_a'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${banPort}/v1/chat/completions`, {
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
  // token-a 被封 → 必须换到 token-b 成功,而不是把 403 甩给下游.
  assert.equal(res.status, 200, await res.clone().text())
  assert.ok(
    state.calls.filter((c) => c.url.includes('/chat/completions')).length >= 2,
    '封禁后必须换号重试',
  )
  // 被封账号被标记 banned(控制台分区与调度排除都靠它).
  const banAccounts = banRuntimes.list()
  const bannedA = banAccounts.find((x) => x.email === 'a@example.com')
  assert.equal(bannedA.banned, true, 'account_suspended 应归一为 banned')
  assert.equal(bannedA.available, false)
  await banRuntimes.shutdown()
  banServer.close()
  fs.rmSync(banDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
