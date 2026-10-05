/**
 * pool: 接管的反例
 *
 * 防"余额 0 一律放行"的假绿: 清单里那条已付费会话绑的是别的模型时不得复用.
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

/* ================================================================
   同一账号的清单里有会话,但不是本次请求的模型 → 不得被误认成可接管
   ================================================================ */
{
  /**
   * - 反例(防"余额 0 一律放行"的假绿):清单里那条已付费会话绑的是别的模型,
   * 就没有任何"已付过钱,边际成本 0"的会话可用 ---- 余额 0 仍然必须被闸门拦住.
   *
   * - 若有人把 paidUpstream 写成"清单非空即放行",本用例立刻变红.
   */
  const MIS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-paid-mism-'))
  saveAccountUser(MIS_DIR, { id: 'p2', email: 'p2@example.com', authToken: 'token-p2' })
  const misConfig = loadConfig()
  misConfig.server.host = '127.0.0.1'
  misConfig.server.port = 0
  misConfig.server.apiKeys = ['sk-test']
  misConfig.upstream.credentialsDir = MIS_DIR
  misConfig.session.pollIntervalSec = 3600
  const misRuntimes = new AccountRuntimes(misConfig)
  const misServer = await startServer({
    config: misConfig,
    runtimes: misRuntimes,
    ...(() => {
      const rt = misRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const misPort = misServer.address().port

  state.mockPaidTakeover = {
    holderInstanceId: 'someone-elses-inst',
    // 清单绑另一个模型(上游 id 形式)
    model: 'mimo/mimo-v2.5',
    listed: true,
    freebucks: {
      balance: 0,
      daily: { limit: 25, remaining: 0 },
      prices: { 'deepseek/deepseek-v4-flash': 15 },
    },
  }
  state.mockMode = 'ok'
  state.calls = []
  /**
   * 先对一次账(等价于控制台点过[刷新]):本地既拿到"买不起"的 Freebucks,
   * 也拿到会话清单.该状态下手上有这条会话的快照.
   */
  await misRuntimes.get('p2').sessions.refresh()
  const misRes = await fetch(`http://127.0.0.1:${misPort}/v1/chat/completions`, {
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
  const misText = await misRes.clone().text()
  assert.equal(
    misRes.status,
    429,
    '清单里没有**本次请求模型**的已付费会话时，余额 0 仍须被闸门拦住：' + misText.slice(0, 300),
  )
  assert.ok(
    misText.includes('freebucks_exhausted'),
    '错误码必须是额度闸门（证明拦住它的正是那道闸门，而不是别的原因）：' +
      misText.slice(0, 300),
  )

  await misRuntimes.shutdown()
  misServer.close()
  fs.rmSync(MIS_DIR, { recursive: true, force: true })
  state.mockPaidTakeover = null
  state.mockMode = 'ok'
}
