/**
 * web: 管理员 bootstrap 报告真实结果
 *
 * issue #9: 日志谎报会让"无法登录"无从排查; user store 与 web session 的持久化.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { tmpDir } from '../../harness/runtime.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- unit: 管理员 bootstrap 报告真实结果(issue #9:日志撒谎导致"无法登录")---
{
  const { UserStore } = await import('../../../../../../src/web/user-store.ts')
  const adminsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-admin-'))
  const store = new UserStore(path.join(adminsDir, 'users.json'))

  // 1) 首次启动 + 无密码 → 随机生成,必须把密码交回调用方打印
  const first = store.ensureDefaultAdmin('admin', null)
  assert.equal(first.created, true)
  assert.equal(first.username, 'admin')
  assert.ok(first.password && first.password.length >= 6)

  // 2) 已有管理员 + env 给了合法密码 → 轮换(rotated=true,供日志如实上报)
  const rotated = store.ensureDefaultAdmin('admin', 'newpass123')
  assert.equal(rotated.created, false)
  assert.equal(rotated.rotated, true)
  assert.ok(store.verifyPassword('admin', 'newpass123'))

  // 3) env 密码不合法(<6 位)→ 不能静默当成功,必须回传 error 让人看到
  const rejected = store.ensureDefaultAdmin('admin', 'abc')
  assert.equal(rejected.rotated, undefined)
  assert.match(String(rejected.error), /密码/)
  assert.ok(store.verifyPassword('admin', 'newpass123'), '被拒绝的密码不得改动现有密码')

  // 4) 已有管理员且没给密码 → 既不创建也不轮换(密码只在首次启动打印一次)
  const again = store.ensureDefaultAdmin('admin', null)
  assert.equal(again.created, false)
  assert.equal(again.rotated, undefined)
  assert.equal(again.password, undefined)
  fs.rmSync(adminsDir, { recursive: true, force: true })
}

// --- unit: user store + web sessions ---
{
  const { UserStore } = await import('../../../../../../src/web/user-store.ts')
  const { WebSessionStore } = await import('../../../../../../src/web/session-store.ts')
  const us = new UserStore(path.join(tmpDir, 'users.json'))
  assert.equal(us.all().length, 0)
  const u = us.create({ username: 'Alice', password: 'secret123', role: 'user' })
  assert.equal(u.username, 'alice')
  assert.ok(u.apiKey.startsWith('sk-fb-'))
  assert.equal(us.verifyPassword('alice', 'wrong'), null)
  const good = us.verifyPassword('alice', 'secret123')
  assert.equal(good.username, 'alice')
  assert.equal(us.getByApiKey(u.apiKey).username, 'alice')
  const newKey = us.resetApiKey('alice')
  assert.ok(newKey !== u.apiKey)
  // persistence across instances
  const us2 = new UserStore(path.join(tmpDir, 'users.json'))
  assert.equal(us2.getByUsername('alice').username, 'alice')
  us2.delete('alice')
  assert.equal(us2.getByUsername('alice'), null)

  const ws = new WebSessionStore(path.join(tmpDir, 'web-sessions.json'), 60_000)
  const tok = ws.create('alice')
  assert.equal(ws.get(tok), 'alice')
  ws.destroy(tok)
  assert.equal(ws.get(tok), null)
}
