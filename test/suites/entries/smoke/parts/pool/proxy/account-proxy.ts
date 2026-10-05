/**
 * pool: 账号专属出口优先
 *
 * 账号绑定专属出口时的粘性与覆盖优先级.
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

// --- per-account proxy (多代理粘性: 账号绑定专属出口) ---
{
  const pDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-acc-'))
  saveAccountUser(pDir, {
    id: 'pa',
    email: 'pa@example.com',
    authToken: 'token-pa',
    proxy: 'http://127.0.0.1:7890',
  })
  saveAccountUser(pDir, { id: 'pb', email: 'pb@example.com', authToken: 'token-pb' })
  const pConfig = loadConfig()
  pConfig.upstream.credentialsDir = pDir
  pConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(pConfig)

  // runtime uses the per-account proxy
  const rtA = pool.get('pa')
  assert.equal(rtA.proxy, 'http://127.0.0.1:7890')
  assert.equal(rtA.effectiveProxy, 'http://127.0.0.1:7890')

  // rows surface proxy + effectiveProxy
  const rows = pool.list()
  const rowA = rows.find((x) => x.email === 'pa@example.com')
  assert.equal(rowA.proxy, 'http://127.0.0.1:7890')
  assert.equal(rowA.effectiveProxy, 'http://127.0.0.1:7890')
  assert.equal(rows.find((x) => x.email === 'pb@example.com').proxy, null)
  assert.equal(rows.find((x) => x.email === 'pb@example.com').effectiveProxy, null)

  // proxy change → cached runtime recreated with the new proxy
  pool.get('pa').sessions.quota = { byModel: {}, rateLimit: null, updatedAt: 'x' }
  const before = pool.get('pa')
  const file = path.join(pDir, 'pa.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.proxy = null
  fs.writeFileSync(file, JSON.stringify(raw))
  const after = pool.get('pa')
  assert.notEqual(after, before)
  assert.equal(after.proxy, null)

  // createUpstreamClient honors opts.proxy without throwing
  const { createUpstreamClient } = await import('../../../../../../../src/upstream/client.ts')
  const cli = createUpstreamClient(pConfig, 'tok', { proxy: 'http://127.0.0.1:7890' })
  assert.ok(cli)
  await pool.shutdown()
  fs.rmSync(pDir, { recursive: true, force: true })
}

// --- 全局代理池:稳定哈希分配 + 账号覆盖优先 ---
{
  const poolConfig = loadConfig()
  poolConfig.upstream.proxies = [
    'http://p1.example:7890',
    'http://p2.example:7890',
    'http://p3.example:7890',
  ]
  const { createUpstreamClient } = await import('../../../../../../../src/upstream/client.ts')
  const a1 = createUpstreamClient(poolConfig, 'tok', { accountId: 'a@example.com' })
  const a2 = createUpstreamClient(poolConfig, 'tok', { accountId: 'a@example.com' })
  const b = createUpstreamClient(poolConfig, 'tok', { accountId: 'b@example.com' })
  // 同账号稳定同一代理
  assert.equal(a1.proxyUrl, a2.proxyUrl)
  assert.ok(a1.proxyUrl.startsWith('http://p'))
  // 不同账号可能落到不同代理(池内成员之一)
  assert.ok(poolConfig.upstream.proxies.includes(a1.proxyUrl))
  assert.ok(poolConfig.upstream.proxies.includes(b.proxyUrl))
  // 账号显式代理优先于全局池
  const c = createUpstreamClient(poolConfig, 'tok', {
    accountId: 'a@example.com',
    proxy: 'http://explicit:9999',
  })
  assert.equal(c.proxyUrl, 'http://explicit:9999')
  // 无池无显式 → 直连(null)
  const plain = createUpstreamClient(loadConfig(), 'tok', { accountId: 'x@example.com' })
  assert.equal(plain.proxyUrl, null)
}
