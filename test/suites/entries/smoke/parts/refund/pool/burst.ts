/**
 * refund: 突发请求与全池买不起
 *
 * 13 个并发请求的场景; 全池买不起时不得白轮 maxAttempts.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { SessionManager } from '../../../../../../../src/session-manager.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ================================================================
   全池额度耗尽 = 终态:一次收场,不白轮 maxAttempts 轮
   ================================================================ */
{
  /**
   * 场景: 13 个客户端请求, 每个都要遍历全部账号查额度, 每轮刷数十条日志.
   *
   * - 判据: 单位级断言 freebucksFor 对"余额 0 + 单价 15"判买不起, 且 reason
   * - 是 daily_exhausted(聚合终态的判据来源).
   */
  const calls = []
  const up = {
    freebuffSession: async (method) => {
      calls.push(method)
      return { status: 'none' }
    },
  }
  const sm = new SessionManager({
    upstream: up,
    config: { session: { reAdmitOnExpire: true, reAdmitLeadSec: 60, freeModelReAdmitLeadSec: 60 }, limits: {} },
    accountKey: 'terminal-exhausted',
  })
  // 账号快照:余额 0,单价 15 → 买不起
  sm.freebucks = { balance: 0, daily: { limit: 25, remaining: 0, resetAt: null }, prices: { 'm-00032eaeec': 15 } }
  const fb = sm.freebucksFor('m-00032eaeec')
  assert.equal(fb.affordable, false, '对照前提：该账号应被判买不起')
  assert.equal(fb.reason, 'daily_exhausted', `原因应为日池耗尽，got ${fb.reason}`)
}

/* ================================================================
   全池额度耗尽 → 抛出的错误必须带 terminalExhausted(外层据此一次收场)
   ================================================================ */
{
  /**
   * 本用例断言: 全池都买不起时抛出的错误带 terminalExhausted(外层据此一次收场),
   * 不按"该换号"再轮一遍全部账号.
   *
   * - 反向探针:删掉 app-context 里的 terminalExhausted: true → 本断言必须红.
   */
  const { buildAppContext } = await import('../../../../../../../src/app-context.ts')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-terminal-'))
  const cfg = loadConfig()
  cfg.server.host = '127.0.0.1'
  cfg.server.port = 0
  cfg.upstream.credentialsDir = tmpDir
  cfg.session.pollIntervalSec = 3600
  fs.writeFileSync(
    path.join(tmpDir, 'a.json'),
    JSON.stringify({ id: 'a', email: 'a@example.com', authToken: 'tok-a' }),
  )
  const runtimes3 = new AccountRuntimes(cfg)
  // 让该账号"买不起":余额 0 / 单价 15
  const rt3 = runtimes3.get('a')
  rt3.sessions.freebucks = {
    balance: 0,
    daily: { limit: 25, remaining: 0, resetAt: null },
    prices: { 'm-00032eaeec': 15 },
  }
  let thrown = null
  try {
    await runtimes3.acquireForModel('m-00032eaeec')
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown, '全池买不起时必须抛出错误（而不是静默返回）')
  assert.equal(
    thrown.terminalExhausted,
    true,
    `全池额度耗尽必须带 terminalExhausted（否则外层会白轮 maxAttempts 轮），` +
      `got code=${thrown.code} terminalExhausted=${thrown.terminalExhausted}`,
  )
  // 额度类码仍保留(兼容既有消费方)
  assert.ok(
    thrown.code === 'freebucks_exhausted' || thrown.code === 'units_exhausted',
    `应保留额度类码，got ${thrown.code}`,
  )
  await runtimes3.shutdown?.().catch(() => {})
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
