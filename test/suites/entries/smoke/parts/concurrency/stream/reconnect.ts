/**
 * concurrency: 全部断开重连与重启端点
 *
 * 比重启更轻量地释放 session 并重置并发信号量.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { state } from '../../../../../smoke/state.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- 全部断开重连 API:比重启更轻量,释放 session + 重置并发信号量 ---
{
  const rcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-reconnect-'))
  saveAccountUser(rcDir, { id: 'ra', email: 'ra@example.com', authToken: 'token-ra' })
  const rcConfig = loadConfig()
  rcConfig.server.host = '127.0.0.1'
  rcConfig.server.port = 0
  rcConfig.server.apiKeys = ['sk-test']
  rcConfig.upstream.credentialsDir = rcDir
  rcConfig.session.pollIntervalSec = 3600
  const { UserStore: RCUS } = await import('../../../../../../../src/web/store/session/user-store.ts')
  const { WebSessionStore: RCWS } = await import('../../../../../../../src/web/store/session/session-store.ts')
  const { LoginFlowManager: RCLFM } = await import('../../../../../../../src/web/store/session/login-flows.ts')
  const { ProxyStore: RCPS } = await import('../../../../../../../src/web/store/config/proxy-store.ts')
  const { SettingsStore: RCSS } = await import('../../../../../../../src/web/store/config/settings-store.ts')
  const rcUsers = new RCUS(path.join(rcDir, 'users.json'))
  rcUsers.create({ username: 'admin', password: 'secret123', role: 'admin' })
  rcUsers.create({ username: 'viewer', password: 'secret123', role: 'user' })
  const rcWS = new RCWS(path.join(rcDir, 'web-sessions.json'), 3600_000)
  const rcLFM = new RCLFM({ file: path.join(rcDir, 'login-flows.json'), credentialsDir: rcDir, config: rcConfig })
  const rcPS = new RCPS(path.join(rcDir, 'proxies.json'))
  const rcSS = new RCSS(path.join(rcDir, 'settings.json'))
  const rcRuntimes = new AccountRuntimes(rcConfig)
  const rcServer = await startServer({
    config: rcConfig,
    runtimes: rcRuntimes,
    userStore: rcUsers,
    webSessions: rcWS,
    loginFlows: rcLFM,
    proxyStore: rcPS,
    settingsStore: rcSS,
  })
  const rcPort = rcServer.address().port
  const login = async (username) => {
    const r = await fetch(`http://127.0.0.1:${rcPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'secret123' }),
    })
    assert.equal(r.status, 200)
    return r.headers.get('set-cookie').split(';')[0]
  }
  const adminCookie = await login('admin')
  const viewerCookie = await login('viewer')

  // 先 admit 一个活跃 session
  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.sessionDeletes = 0
  state.completionAttempts = 0
  const rcChat = await fetch(`http://127.0.0.1:${rcPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(rcChat.status, 200, await rcChat.clone().text())
  assert.equal(state.sessionPosts, 1)
  assert.equal(rcRuntimes.list()[0].session.status, 'active')

  // 未登录 → 401;非 admin → 403
  {
    const anon = await fetch(`http://127.0.0.1:${rcPort}/api/system/reconnect`, { method: 'POST' })
    assert.equal(anon.status, 401)
    const viewer = await fetch(`http://127.0.0.1:${rcPort}/api/system/reconnect`, {
      method: 'POST',
      headers: { cookie: viewerCookie },
    })
    assert.equal(viewer.status, 403)
  }

  // admin 全部断开重连 → 200,session 被释放(下个请求自动重建)
  const rcRes = await fetch(`http://127.0.0.1:${rcPort}/api/system/reconnect`, {
    method: 'POST',
    headers: { cookie: adminCookie },
  })
  assert.equal(rcRes.status, 200, await rcRes.clone().text())
  const rcJson = await rcRes.json()
  assert.equal(rcJson.ok, true)
  assert.equal(rcJson.accounts[0].ok, true)
  assert.equal(rcRuntimes.list()[0].session.status, 'none', 'reconnect 应释放 session')
  assert.ok(state.sessionDeletes >= 1, 'reconnect 应调用上游 DELETE')

  // 下个请求自动重建全新 session
  const rcChat2 = await fetch(`http://127.0.0.1:${rcPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(rcChat2.status, 200, await rcChat2.clone().text())
  assert.equal(state.sessionPosts, 2, `reconnect 后应重新 admit, got ${state.sessionPosts}`)

  await rcRuntimes.shutdown()
  rcServer.close()
  fs.rmSync(rcDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}

// --- 重启 API 端点测试(不执行实际重启)---
{
  const rsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-restart-'))
  const rsConfig = loadConfig()
  rsConfig.server.host = '127.0.0.1'
  rsConfig.server.port = 0
  rsConfig.server.apiKeys = ['sk-test']
  rsConfig.upstream.credentialsDir = rsDir
  rsConfig.session.pollIntervalSec = 3600

  // 不需要实际 Freebuff 账号(重启不依赖上游)
  const rsRuntimes = new AccountRuntimes(rsConfig)
  // 重启回调标记
  let restarted = false
  const { UserStore: US } = await import('../../../../../../../src/web/store/session/user-store.ts')
  const { WebSessionStore: WS } = await import('../../../../../../../src/web/store/session/session-store.ts')
  const { LoginFlowManager: LFM } = await import('../../../../../../../src/web/store/session/login-flows.ts')
  const { ProxyStore: PS } = await import('../../../../../../../src/web/store/config/proxy-store.ts')
  const { SettingsStore: SS } = await import('../../../../../../../src/web/store/config/settings-store.ts')
  const rsUsers = new US(path.join(rsDir, 'users.json'))
  rsUsers.create({ username: 'admin', password: 'secret123', role: 'admin' })
  const rsWS = new WS(path.join(rsDir, 'web-sessions.json'), 3600_000)
  const rsLFM = new LFM({ file: path.join(rsDir, 'login-flows.json'), credentialsDir: rsDir, config: rsConfig })
  const rsPS = new PS(path.join(rsDir, 'proxies.json'))
  const rsSS = new SS(path.join(rsDir, 'settings.json'))
  const rsServer = await startServer({
    config: rsConfig,
    runtimes: rsRuntimes,
    userStore: rsUsers,
    webSessions: rsWS,
    loginFlows: rsLFM,
    proxyStore: rsPS,
    settingsStore: rsSS,
    restart: () => { restarted = true },
  })
  const rsPort = rsServer.address().port

  // 未登录 → 401
  {
    const res = await fetch(`http://127.0.0.1:${rsPort}/api/system/restart`, { method: 'POST' })
    assert.equal(res.status, 401)
  }

  // 登录后 POST → 200 且 restart 回调被调用
  const loginRes = await fetch(`http://127.0.0.1:${rsPort}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret123' }),
  })
  assert.equal(loginRes.status, 200, await loginRes.clone().text())
  const cookies = loginRes.headers.get('set-cookie')
  assert.ok(cookies, 'expected set-cookie')

  const rrRes = await fetch(`http://127.0.0.1:${rsPort}/api/system/restart`, {
    method: 'POST',
    headers: { cookie: cookies.split(';')[0] },
  })
  assert.equal(rrRes.status, 200, await rrRes.clone().text())
  // setTimeout 300ms 后调用 restart → 等一会儿
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(restarted, true, 'restart callback should have been called')

  rsServer.close()
  fs.rmSync(rsDir, { recursive: true, force: true })
}
