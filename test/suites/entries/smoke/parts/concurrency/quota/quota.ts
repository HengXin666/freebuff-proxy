/**
 * quota: 额度提取与展示
 *
 * 已用满的冷账号排到可用冷账号之后.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- quota: extraction + display;已用满的冷账号排到可用冷账号之后 ---
{
  const qDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-quota-'))
  saveAccountUser(qDir, { id: 'qa', email: 'qa@example.com', authToken: 'token-qa' })
  saveAccountUser(qDir, { id: 'qb', email: 'qb@example.com', authToken: 'token-qb' })
  const qConfig = loadConfig()
  qConfig.upstream.credentialsDir = qDir
  qConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(qConfig)
  const mkQuota = (model, limit, used) => {
    const rl = { model, limit, period: 'pacific_day', resetAt: '2026-08-09T07:00:00.000Z', recentCount: used }
    return { byModel: { [model]: rl }, rateLimit: rl, updatedAt: new Date().toISOString() }
  }
  const pa = pool.get('qa')
  const pb = pool.get('qb')
  pa.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 5)
  pb.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 1)

  // 两个账号都有剩余额度时,轮询仅作为同层级的平局处理.
  const order = pool.candidateKeys('openai/gpt-5.6-luna')
  assert.deepEqual(order, ['qa', 'qb'], `expected stable tie-break, got ${order}`)

  // 已用满的冷账号不应先触发一次必败的 admit.
  pa.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 6)
  const order2 = pool.candidateKeys('openai/gpt-5.6-luna')
  assert.deepEqual(order2, ['qb', 'qa'], `exhausted account should be last, got ${order2}`)

  // list() surfaces the live quota unchanged, including flash daily limits
  pa.sessions.quota = {
    byModel: {
      'openai/gpt-5.6-luna': mkQuota('openai/gpt-5.6-luna', 6, 5).byModel['openai/gpt-5.6-luna'],
      'deepseek/deepseek-v4-flash': mkQuota('deepseek/deepseek-v4-flash', 6, 6).byModel['deepseek/deepseek-v4-flash'],
      'mimo/mimo-v2.5': mkQuota('mimo/mimo-v2.5', 6, 4.8).byModel['mimo/mimo-v2.5'],
    },
    rateLimit: null,
    updatedAt: new Date().toISOString(),
  }
  pb.sessions.quota = {
    byModel: {
      'openai/gpt-5.6-luna': mkQuota('openai/gpt-5.6-luna', 6, 1).byModel['openai/gpt-5.6-luna'],
      'deepseek/deepseek-v4-flash': mkQuota('deepseek/deepseek-v4-flash', 6, 6).byModel['deepseek/deepseek-v4-flash'],
      'mimo/mimo-v2.5': mkQuota('mimo/mimo-v2.5', 6, 4.8).byModel['mimo/mimo-v2.5'],
    },
    rateLimit: null,
    updatedAt: new Date().toISOString(),
  }
  const rows = pool.list()
  const rowB = rows.find((x) => x.email === 'qb@example.com')
  assert.equal(rowB.quota.byModel['openai/gpt-5.6-luna'].recentCount, 1)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].limit, 6)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].recentCount, 6)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].unlimited, undefined)
  assert.equal(rowB.quota.byModel['mimo/mimo-v2.5'].limit, 6)
  assert.equal(rowB.quota.byModel['mimo/mimo-v2.5'].recentCount, 4.8)
  assert.equal(rowB.quota.byModel['mimo/mimo-v2.5'].unlimited, undefined)
  assert.equal(rowB.quota.byModel['openai/gpt-5.6-luna'].unlimited, undefined)
  assert.equal(typeof rowB.requests, 'number')
  await pool.shutdown()
  fs.rmSync(qDir, { recursive: true, force: true })
}
