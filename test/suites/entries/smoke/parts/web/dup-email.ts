/**
 * web: 同邮箱不同 id 并存
 *
 * GitHub / Google 同邮箱但 id 不同时两个账号并存, 不互相覆盖.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../src/app-context.ts'
import { listAccounts, readAccountUser, saveAccountUser } from '../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../src/config.ts'
import { state } from '../../../../smoke/state.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- regression: GitHub/Google 同一邮箱但 id 不同 → 两个账号并存,不互相覆盖 ---
{
  const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-dup-'))
  // 模拟 GitHub 登录 + Google 登录(同一邮箱,不同 Freebuff id)
  saveAccountUser(dupDir, { id: 'github-u1', email: 'same@example.com', name: 'GitHub', authToken: 'token-gh' })
  saveAccountUser(dupDir, { id: 'google-u1', email: 'same@example.com', name: 'Google', authToken: 'token-google' })
  let rows = listAccounts(dupDir)
  assert.equal(rows.length, 2, `同邮箱不同 id 应并存, got ${JSON.stringify(rows.map((r) => r.id))}`)
  assert.equal(rows.filter((r) => r.email === 'same@example.com').length, 2)
  assert.ok(rows.some((r) => r.id === 'github-u1') && rows.some((r) => r.id === 'google-u1'))
  // 各自独立文件,互不覆盖
  assert.ok(fs.existsSync(path.join(dupDir, 'github-u1.json')))
  assert.ok(fs.existsSync(path.join(dupDir, 'google-u1.json')))
  // 重登 GitHub(同 id)→ 只更新 GitHub 那份,Google 那份原样保留
  saveAccountUser(dupDir, { id: 'github-u1', email: 'same@example.com', name: 'GitHub', authToken: 'token-gh-2' })
  rows = listAccounts(dupDir)
  assert.equal(rows.length, 2)
  assert.equal(readAccountUser(dupDir, 'github-u1').authToken, 'token-gh-2')
  assert.equal(readAccountUser(dupDir, 'google-u1').authToken, 'token-google')
  // 并发冷启动也只能创建一个 session;两个身份仍各自独立存在于账号池.
  const dupConfig = loadConfig()
  dupConfig.upstream.credentialsDir = dupDir
  dupConfig.session.pollIntervalSec = 3600
  const dupPool = new AccountRuntimes(dupConfig)
  state.mockMode = 'ok'
  state.sessionPosts = 0
  const seen = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const rt = await dupPool.acquireForModel('deepseek/deepseek-v4-flash')
      return rt.key
    }),
  )
  assert.equal(new Set(seen).size, 1, `并发冷启动应复用一个账号, got ${seen}`)
  assert.equal(state.sessionPosts, 1, `并发冷启动只应 admit 一次, got ${state.sessionPosts}`)
  await dupPool.shutdown()
  fs.rmSync(dupDir, { recursive: true, force: true })
}
