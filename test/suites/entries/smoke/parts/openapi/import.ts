/**
 * open api: 账号导入与删除
 *
 * /v1/freebuff/accounts/import 与 DELETE(Bearer API Key).
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../src/config.ts'
import { startServer } from '../../../../../../src/server.ts'
import { SettingsStore } from '../../../../../../src/web/store/config/settings-store.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- open api: /v1/freebuff/accounts/import + DELETE (Bearer API Key) ---
{
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-import-'))
  saveAccountUser(importDir, {
    id: 'imp1',
    email: 'imp-one@example.com',
    name: 'ImpOne',
    authToken: 'token-imp-1',
  })
  const cfg = loadConfig()
  cfg.server.host = '127.0.0.1'
  cfg.server.port = 0
  cfg.server.apiKeys = ['sk-import-test']
  cfg.upstream.credentialsDir = importDir
  cfg.session.pollIntervalSec = 3600
  cfg.limits.maxConcurrentRequests = 2
  const runtimes2 = new AccountRuntimes(cfg)
  const settingsStore2 = new SettingsStore(path.join(importDir, 'settings.json'))
  const srv2 = await startServer({
    config: cfg,
    runtimes: runtimes2,
    ...(() => {
      const rt = runtimes2.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
    settingsStore: settingsStore2,
  })
  const p2 = srv2.address().port
  const b2 = `http://127.0.0.1:${p2}`

  // 401: 无鉴权拒绝
  let r = await fetch(`${b2}/v1/freebuff/accounts/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.z', authToken: 't' }),
  })
  assert.strictEqual(r.status, 401, '无鉴权导入应 401')

  // 单个导入
  r = await fetch(`${b2}/v1/freebuff/accounts/import`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-import-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'imp2',
      email: 'imp-two@example.com',
      name: 'ImpTwo',
      authToken: 'token-imp-2',
    }),
  })
  assert.strictEqual(r.status, 200, '单账号导入应 200')
  const imp1 = await r.json()
  assert.strictEqual(imp1.ok, true, '导入 ok')
  assert.strictEqual(imp1.imported.length, 1, '导入 1 个')
  assert.strictEqual(imp1.imported[0].email, 'imp-two@example.com', '导入邮箱正确')

  // 批量导入(数组)
  r = await fetch(`${b2}/v1/freebuff/accounts/import`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-import-test', 'content-type': 'application/json' },
    body: JSON.stringify([
      { id: 'imp3', email: 'imp-three@example.com', authToken: 'token-imp-3' },
      { id: 'imp4', email: 'imp-four@example.com', authToken: 'token-imp-4' },
      { email: 'bad-no-token@example.com' }, // 缺 authToken → failure
    ]),
  })
  assert.strictEqual(r.status, 200, '批量导入应 200')
  const impN = await r.json()
  assert.strictEqual(impN.imported.length, 2, '批量成功 2 个')
  assert.strictEqual(impN.failures.length, 1, '批量失败 1 个')

  // 列表包含导入账号
  r = await fetch(`${b2}/v1/freebuff/accounts`, {
    headers: { authorization: 'Bearer sk-import-test' },
  })
  const list = await r.json()
  const emails = list.data.map((row) => row.email)
  assert.ok(emails.includes('imp-two@example.com'), '列表含导入账号 imp-two')
  assert.ok(emails.includes('imp-three@example.com'), '列表含导入账号 imp-three')

  // DELETE 单个(按 email)
  r = await fetch(`${b2}/v1/freebuff/accounts`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer sk-import-test', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'imp-three@example.com' }),
  })
  assert.strictEqual(r.status, 200, '删除应 200')
  const del = await r.json()
  assert.strictEqual(del.existed, true, '按 email 删除应 existed:true')

  // 删除后列表不含
  r = await fetch(`${b2}/v1/freebuff/accounts`, {
    headers: { authorization: 'Bearer sk-import-test' },
  })
  const list2 = await r.json()
  assert.ok(
    !list2.data.some((row) => row.email === 'imp-three@example.com'),
    '删除后列表不含 imp-three',
  )

  await runtimes2.shutdown()
  srv2.close()
  fs.rmSync(importDir, { recursive: true, force: true })
}
