/**
 * refund: 突发请求与全池买不起
 *
 * 13 个并发请求的真实事故; 全池买不起时不得白轮 maxAttempts.
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
   * 真实事故(远程日志 2026-10-04 14:01:47-14:02:00):
   * 13 个客户端请求,每个都白轮 3 次(maxAttempts),每次都要遍历全部账号查额度.
   * 每轮都刷几十条日志 ---- 13 个请求就把 500 条环形缓冲冲爆,
   * - 用户事后查不到更早的排障记录.
   *
   * - 根因:所有账号都买不起时抛的是单账号级 freebucks_exhausted,
   * - 而 429 被 shouldSwitchAccountOnError 判成"该换号" → 再轮一遍.
   * - 但"全池都买不起"是遍历完才得出的聚合结论,换号不可能改变它.
   *
   * - 反向探针:去掉 terminalExhausted: true 后本用例必须变红.
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
   * 这是对"为什么白轮 maxAttempts 轮"的直接回归:
   *
   * - 旧行为:全池都买不起时抛单账号级 freebucks_exhausted,外层
   * - shouldSwitchAccountOnError(429, ...) 判成"该换号" → 再轮一遍全部账号.
   * 实测远程 13 个请求各白轮 3 次,日志被冲爆(用户事后查不到更早记录).
   *
   * - 修复:这种"遍历完才得出的聚合结论"带 terminalExhausted: true,
   * - 外层 isTerminal 立即返回.
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
