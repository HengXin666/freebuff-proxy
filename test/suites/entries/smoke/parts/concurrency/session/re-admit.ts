/**
 * concurrency: 剩余时间阈值
 *
 * 免费模型剩余 <5 分钟不再调度, 付费模型用到接近过期.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { isFreeModel } from '../../../../../../../src/model.ts'
import { state } from '../../../../../smoke/state.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- 免费模型会话剩余 <5 分钟不再调度(提前 re-admit);付费模型用到接近过期 ---
{
  const ldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-lead-'))
  saveAccountUser(ldDir, { id: 'lda', email: 'lda@example.com', authToken: 'token-lda' })
  const ldConfig = loadConfig()
  ldConfig.upstream.credentialsDir = ldDir
  ldConfig.session.pollIntervalSec = 3600
  ldConfig.session.reAdmitLeadSec = 60
  ldConfig.session.freeModelReAdmitLeadSec = 300
  const ldPool = new AccountRuntimes(ldConfig)
  const ldSm = ldPool.get('lda').sessions
  state.mockMode = 'ok'

  // 模型分类:免费(daily)vs 付费(premium);未知模型按免费保守处理
  assert.equal(isFreeModel('deepseek/deepseek-v4-flash'), true)
  assert.equal(isFreeModel('mimo/mimo-v2.5'), true)
  assert.equal(isFreeModel('deepseek/deepseek-v4-pro'), false)
  assert.equal(isFreeModel('openai/gpt-5.6-luna'), false)
  assert.equal(isFreeModel('unknown/vendor-model'), true)

  // 免费模型:会话剩余 4 分钟(< 5 分钟阈值)→ 不再可用,提前 re-admit 换新会话
  state.sessionExpiryMs = 4 * 60_000
  state.sessionPosts = 0
  await ldSm.ensureSession('deepseek/deepseek-v4-flash')
  assert.equal(state.sessionPosts, 1)
  assert.equal(
    ldSm.isUsableForModel('deepseek/deepseek-v4-flash'),
    false,
    '免费会话剩余 4 分钟应视为不可复用（不足 5 分钟不调度）',
  )
  await ldSm.ensureSession('deepseek/deepseek-v4-flash')
  assert.equal(state.sessionPosts, 2, '免费会话剩余 <5 分钟应提前 re-admit')

  // 付费模型:会话剩余 4 分钟(> 60s lead)→ 仍可复用(不浪费已付费会话)
  //
  //  这里必须用同一个模型续期, 不能换到别的模型: 一次 admit 买断一小时
  // 且绑定模型, 付费时段内换模型上游会回 purchase_claim_released 且接不回来.
  // 换模型路径由下面的用例单独覆盖.
  // 先验"绑在 flash 上时换 pro 会被拦",再释放,用 pro 重新 admit 验 lead.
  state.sessionExpiryMs = 4 * 60_000
  await assert.rejects(
    () => ldSm.ensureSession('deepseek/deepseek-v4-pro'),
    (err) => err.code === 'paid_window_model_mismatch',
    '付费时段内换模型必须被拦（否则已买断的一小时作废且接不回来）',
  )
  // 用户主动关闭(或时段结束)后,同一个模型才能重新 admit
  await ldSm.release()
  await ldSm.ensureSession('deepseek/deepseek-v4-pro')
  assert.equal(
    ldSm.isUsableForModel('deepseek/deepseek-v4-pro'),
    true,
    '付费会话剩余 4 分钟应可复用（60s 提前量）',
  )
  // 付费模型:剩余 30s < 60s lead → 才不可复用
  ldSm.session.expiresAt = new Date(Date.now() + 30_000).toISOString()
  assert.equal(
    ldSm.isUsableForModel('deepseek/deepseek-v4-pro'),
    false,
    '付费会话剩余 30s 应不可复用（接近过期）',
  )

  state.sessionExpiryMs = 3600_000
  await ldPool.shutdown()
  fs.rmSync(ldDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
