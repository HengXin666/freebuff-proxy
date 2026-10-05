/**
 * scheduling: 轮换开关
 *
 * 轮换开启时的选号顺序与热 session 复用.
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

// --- unit: session-first ---- 热 session 复用,冷却后才启用下一个账号 ---
{
  const rrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-rr-unit-'))
  saveAccountUser(rrDir, { id: 'a', email: 'rr-a@example.com', authToken: 'token-a' })
  saveAccountUser(rrDir, { id: 'b', email: 'rr-b@example.com', authToken: 'token-b' })
  saveAccountUser(rrDir, { id: 'c', email: 'rr-c@example.com', authToken: 'token-c' })
  const rrConfig = loadConfig()
  rrConfig.upstream.credentialsDir = rrDir
  rrConfig.session.pollIntervalSec = 3600
  // 本用例回归热 session 复用 → 平摊账号数=1(只用一个账号,永远复用热 session)
  const pool = new AccountRuntimes(rrConfig)
  state.mockMode = 'ok'
  state.sessionPosts = 0
  // 串行请求全部复用 a 的同一个热 session,只 admit 一次.
  const emails = []
  for (let i = 0; i < 6; i++) {
    const rt = await pool.acquireForModel('deepseek/deepseek-v4-flash')
    emails.push(rt.email)
  }
  assert.deepEqual(
    emails,
    [
      'rr-a@example.com',
      'rr-a@example.com',
      'rr-a@example.com',
      'rr-a@example.com',
      'rr-a@example.com',
      'rr-a@example.com',
    ],
    `同模型热 session 应持续复用, got ${JSON.stringify(emails)}`,
  )
  assert.equal(state.sessionPosts, 1, `expected one admission, got ${state.sessionPosts}`)

  // 新模型优先使用空闲的 b,不能释放 a 上仍可复用的 Flash session.
  const luna = await pool.acquireForModel('openai/gpt-5.6-luna')
  assert.equal(luna.email, 'rr-b@example.com')
  assert.equal(pool.get('a').sessions.getSnapshot().model, 'deepseek/deepseek-v4-flash')
  assert.equal(pool.get('b').sessions.getSnapshot().model, 'openai/gpt-5.6-luna')
  assert.equal(state.sessionPosts, 2, `second model should add one admission, got ${state.sessionPosts}`)

  // a 冷却后,Flash 使用空闲的 c,而不是覆盖 b 上的 Luna.
  pool.markCooldown('a', {
    code: 'rate_limited',
    retryAfterMs: 60_000,
  })
  const next = []
  for (let i = 0; i < 4; i++) {
    const rt = await pool.acquireForModel('deepseek/deepseek-v4-flash')
    next.push(rt.email)
  }
  assert.deepEqual(
    next,
    ['rr-c@example.com', 'rr-c@example.com', 'rr-c@example.com', 'rr-c@example.com'],
    `故障切号后应复用新账号 session, got ${JSON.stringify(next)}`,
  )
  assert.equal(state.sessionPosts, 3, `expected three admissions, got ${state.sessionPosts}`)
  await pool.shutdown()
  fs.rmSync(rrDir, { recursive: true, force: true })
}
