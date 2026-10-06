
import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { SettingsStore } from '../../../../../../../src/web/store/config/settings-store.ts'
import { UserStore } from '../../../../../../../src/web/store/session/user-store.ts'
import { WebSessionStore } from '../../../../../../../src/web/store/session/session-store.ts'
import { LoginFlowManager } from '../../../../../../../src/web/store/session/login-flows.ts'
import { ProxyStore } from '../../../../../../../src/web/store/config/proxy-store.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-switch-http-'))
saveAccountUser(dir, { id: 'w', email: 'w@example.com', authToken: 'token-w' })
const config = loadConfig()
config.server.host = '127.0.0.1'
config.server.port = 0
config.upstream.credentialsDir = dir
config.session.pollIntervalSec = 3600
const userStore = new UserStore(path.join(dir, 'users.json'))
const webSessions = new WebSessionStore(path.join(dir, 'web-sessions.json'), 3600_000)
userStore.create({ username: 'admin', password: 'secret123', role: 'admin' })
const runtimes = new AccountRuntimes(config)
const server = await startServer({
  config, runtimes, authToken: null, authSource: null, authEmail: null,
  upstream: null, sessions: null, userStore, webSessions,
  loginFlows: new LoginFlowManager({ file: path.join(dir, 'lf.json'), credentialsDir: dir, config }),
  proxyStore: new ProxyStore(path.join(dir, 'proxies.json')),
  settingsStore: new SettingsStore(path.join(dir, 'settings.json')),
})
const base = `http://127.0.0.1:${server.address().port}`
const lr = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'secret123' }),
})
assert.equal(lr.status, 200)
const cookie = lr.headers.get('set-cookie').split(';')[0]
const h = { cookie, 'content-type': 'application/json' }
/** 打一次调度开关端点. */
const post = (key, body) =>
  fetch(`${base}/api/accounts/${key}/scheduling`, {
    method: 'POST', headers: h, body: JSON.stringify(body),
  })

// 非法 body 必须 400, 且不改状态
let res = await post('w', { enabled: 'yes' })
assert.equal(res.status, 400, 'enabled 非布尔必须 400')
assert.equal(runtimes.schedulingEnabled('w'), true, '非法请求不得改状态')

// 关掉
res = await post('w', { enabled: false })
assert.equal(res.status, 200)
const off = await res.json()
assert.equal(off.schedulingEnabled, false)
assert.equal(off.account.schedulingEnabled, false, '回执必须带上更新后的账号行')
assert.equal(runtimes.candidateKeys('deepseek/deepseek-v4-flash').length, 0, '关掉后没有候选')
// overview 与 /api/accounts 都要带这个字段(前端两条数据来源)
const ov = await (await fetch(`${base}/api/overview`, { headers: h })).json()
assert.equal(ov.accounts[0].schedulingEnabled, false, 'overview 必须带调度开关')
const acc = await (await fetch(`${base}/api/accounts`, { headers: h })).json()
assert.equal(acc.data[0].schedulingEnabled, false, '/api/accounts 必须带调度开关')

// 不存在的账号 404
res = await post('nope', { enabled: false })
assert.equal(res.status, 404)

// 打开
res = await post('w', { enabled: true })
assert.equal((await res.json()).schedulingEnabled, true)
assert.ok(runtimes.candidateKeys('deepseek/deepseek-v4-flash').includes('w'), '打开后回到候选')

await runtimes.shutdown()
server.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('调度开关 HTTP 端点验证通过')
