/**
 * scheduling: 地理封锁
 *
 * 封锁判据夹在 200 回执里, 不能被归成 http_503 而冷却换号.
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

// [2026-10-01 金标准修正]status: 'active' 优先于 countryBlockReason.
//
// 真机抓包:官方 CLI 在完全相同的出口(JP / country_not_allowed /
// region_locked)下,服务端返回的就是 status: "active" + 可用
// instanceId.也就是说 countryBlockReason 是说明性字段(解释为什么模型集
// 变小),不是拒绝信号.
//
// 因此本条断言改为:active + terminal reason → 仍然可用(200).
// 只有没有 instanceId 的终态才是真封锁(见下面第二个用例).
// 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
{
  const cbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-country-'))
  saveAccountUser(cbDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(cbDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const cbConfig = loadConfig()
  cbConfig.server.host = '127.0.0.1'
  cbConfig.server.port = 0
  cbConfig.server.apiKeys = ['sk-test']
  cbConfig.upstream.credentialsDir = cbDir
  cbConfig.session.pollIntervalSec = 3600
  const cbRuntimes = new AccountRuntimes(cbConfig)
  const cbServer = await startServer({
    config: cbConfig,
    runtimes: cbRuntimes,
    ...(() => {
      const rt = cbRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const cbPort = cbServer.address().port
  state.mockMode = 'country_block'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${cbPort}/v1/chat/completions`, {
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
  const cbBody = await res.json()
  // 金标准:active + country_not_allowed = 可用(官方 CLI 实测拿到 active)
  assert.equal(
    res.status,
    200,
    'status:active + countryBlockReason 必须可用（官方实测如此）: ' + JSON.stringify(cbBody),
  )
  const cbActive = cbRuntimes.get('a').sessions.getSnapshot()
  assert.equal(cbActive?.status, 'active', 'active 回执必须被采纳为活会话')
  assert.ok(cbActive?.instanceId, '会话句柄必须保留')
  // 不换号:只应有一次 admit(换了号就会有第二次)
  assert.equal(
    state.sessionPosts,
    1,
    'country_blocked 是出口属性，换号只会白烧每个账号的额度; admit 次数=' + state.sessionPosts,
  )
  // 已付费的窗口必须还在:上游照常建会话照常扣费(一次 admit = 一整小时),
  // 所以句柄必须可寻址 ---- 否则 DELETE 不掉,退款也追不回,等于白扔一小时.
  const cbAccounts = cbRuntimes.list()
  const cbA = cbAccounts.find((x) => x.email === 'a@example.com')
  assert.equal(
    cbA?.session?.status,
    'active',
    '封锁不得抹掉已付费的会话窗口，否则那一小时白买: ' + JSON.stringify(cbA?.session),
  )
  // 控制台快照不暴露 instanceId(有意),真实状态要看 runtime 的 sessions
  const cbRt = cbRuntimes.get('a')
  const cbSnap = cbRt.sessions.getSnapshot()
  assert.ok(
    cbSnap?.instanceId,
    '会话句柄（instanceId）必须保留，否则无法 DELETE 腾槽位/追退款: ' + JSON.stringify(cbSnap),
  )
  assert.equal(cbSnap?.status, 'active', '那条已付费一小时的会话必须仍然活着')
  assert.ok(
    cbRt.sessions.hasLiveSlot(),
    '封锁不等于会话没了：槽位仍在，换出口后即可复用',
  )
  await cbRuntimes.shutdown()
  cbServer.close()
  fs.rmSync(cbDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
