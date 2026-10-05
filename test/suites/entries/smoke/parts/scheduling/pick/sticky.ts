/**
 * scheduling: 粘性调度
 *
 * drain 模式的集中用号与未用账号最后.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { state } from '../../../../../smoke/state.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- unit: 粘性调度(drain, not rotate)----集中用一个账号,未用过的排最后 ---
{
  const spDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-sticky-'))
  saveAccountUser(spDir, { id: 'a', email: 'sp-a@example.com', authToken: 'token-a' })
  saveAccountUser(spDir, { id: 'b', email: 'sp-b@example.com', authToken: 'token-b' })
  saveAccountUser(spDir, { id: 'c', email: 'sp-c@example.com', authToken: 'token-c' })
  const spConfig = loadConfig()
  spConfig.upstream.credentialsDir = spDir
  spConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(spConfig)
  state.mockMode = 'ok'
  state.sessionPosts = 0
  // 串行请求全部粘在 a 上(同一个热 session,只 admit 一次)----绝不轮换健康账号
  const emails = []
  for (let i = 0; i < 6; i++) {
    const rt = await pool.acquireForModel('deepseek/deepseek-v4-flash')
    emails.push(rt.email)
  }
  assert.deepEqual(
    emails,
    Array(6).fill('sp-a@example.com'),
    `请求应粘在同一账号, got ${JSON.stringify(emails)}`,
  )
  assert.equal(state.sessionPosts, 1, `expected one admission, got ${state.sessionPosts}`)
  // 从未用过的账号一个都不能碰
  const rows = pool.list()
  assert.equal(rows.find((r) => r.key === 'a').used, true, 'a 应标记为已用')
  assert.equal(rows.find((r) => r.key === 'b').used, false, 'b 不应被使用')
  assert.equal(rows.find((r) => r.key === 'c').used, false, 'c 不应被使用')

  // a 冷却(限流/额度耗尽)→ 才启用一个从未用过的账号,并继续粘住它
  pool.markCooldown('a', { code: 'rate_limited', retryAfterMs: 60_000 })
  const after = []
  for (let i = 0; i < 3; i++) {
    after.push((await pool.acquireForModel('deepseek/deepseek-v4-flash')).email)
  }
  assert.deepEqual(
    after,
    Array(3).fill('sp-b@example.com'),
    `换号后应粘住新账号, got ${JSON.stringify(after)}`,
  )
  assert.equal(pool.list().find((r) => r.key === 'c').used, false, 'c 仍不应被使用')

  // b 也冷却 → 才轮到最后一个从未用过的账号 c
  pool.markCooldown('b', { code: 'rate_limited', retryAfterMs: 60_000 })
  const last = await pool.acquireForModel('deepseek/deepseek-v4-flash')
  assert.equal(last.email, 'sp-c@example.com', '最后一个账号才启用 c')

  /**
   * 只剩 c 可用: 换模型请求复用同一账号(释放旧 session 后 admit 新模型).
   *
   * - 前提必须是付费时段已结束: 一次 admit 买断一小时且绑定模型, 付费时段内
   * 换模型会得到 purchase_claim_released 且 DELETE 之后接不回来. mock 上游
   * 默认无条件放行 admission, 所以这里先把 c 的会话置为已过期.
   */
  const cRt = pool.get('c')
  cRt.sessions.session = {
    ...(cRt.sessions.session || {}),
    status: 'active',
    model: 'deepseek/deepseek-v4-flash',
    instanceId: 'inst-sp-c',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    remainingMs: 0,
  }
  state.sessionPosts = 0
  const luna = await pool.acquireForModel('openai/gpt-5.6-luna')
  assert.equal(luna.email, 'sp-c@example.com', '无其他可用账号时应复用已用账号换模型')
  assert.equal(state.sessionPosts, 1, `换模型应只 admit 一次, got ${state.sessionPosts}`)
  await pool.shutdown()
  fs.rmSync(spDir, { recursive: true, force: true })
}
