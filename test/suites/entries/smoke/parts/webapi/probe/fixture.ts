/**
 * web api 夹具
 *
 * 25 条前缀语句: 临时目录 / 凭证 / 四个 store / 登录拿 cookie / 起第二个 server / probe 首发. 后面的用例共享这一个 server 与 cookie.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

// 这些绑定被同目录下的多个用例文件共享; 由本模块负责建好, 只此一份.

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { SettingsStore } from '../../../../../../../src/web/settings-store.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const wDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-probe-'))
saveAccountUser(wDir, { id: 'w', email: 'w@example.com', authToken: 'token-w' })
const wConfig = loadConfig()
wConfig.server.host = '127.0.0.1'
wConfig.server.port = 0
wConfig.server.apiKeys = ['sk-test']
wConfig.upstream.credentialsDir = wDir
wConfig.session.pollIntervalSec = 3600
const { UserStore } = await import('../../../../../../../src/web/user-store.ts')
const { WebSessionStore } = await import('../../../../../../../src/web/session-store.ts')
const { LoginFlowManager } = await import('../../../../../../../src/web/login-flows.ts')
const { ProxyStore } = await import('../../../../../../../src/web/proxy-store.ts')
const userStore = new UserStore(path.join(wDir, 'users.json'))
const webSessions = new WebSessionStore(path.join(wDir, 'web-sessions.json'), 3600_000)
userStore.create({ username: 'admin', password: 'secret123', role: 'admin' })
const loginFlows = new LoginFlowManager({
  file: path.join(wDir, 'login-flows.json'),
  credentialsDir: wDir,
  config: wConfig,
})
const proxyStore = new ProxyStore(path.join(wDir, 'proxies.json'))
const settingsStore = new SettingsStore(path.join(wDir, 'settings.json'))
const poolUrls = ['http://p1.example:7890', 'http://p2.example:7890']
const wruntimes = new AccountRuntimes(wConfig)
const wserver = await startServer({
  config: wConfig,
  runtimes: wruntimes,
  authToken: null,
  authSource: null,
  authEmail: null,
  upstream: null,
  sessions: null,
  userStore,
  webSessions,
  loginFlows,
  proxyStore,
  settingsStore,
})
const wport = wserver.address().port
const lr = await fetch(`http://127.0.0.1:${wport}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'secret123' }),
})
assert.equal(lr.status, 200)
const cookie = lr.headers.get('set-cookie').split(';')[0]

export {
  wDir,
  wConfig,
  UserStore,
  WebSessionStore,
  LoginFlowManager,
  ProxyStore,
  userStore,
  webSessions,
  loginFlows,
  proxyStore,
  settingsStore,
  poolUrls,
  wruntimes,
  wserver,
  wport,
  lr,
  cookie,
}
