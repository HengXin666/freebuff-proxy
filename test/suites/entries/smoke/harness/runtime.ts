/**
 * smoke 的共享运行时
 *
 * tmpDir / config / runtimes / settingsStore / modelStore / server / port / base / chat 被 300 多处引用, 且必须是同一份对象.
  * 分散到各用例文件会各建一份 server, 端口与凭证目录全不同, 热 session 复用与冷却换号这类跨用例判定立刻失真.
 *
 * 顺序约束: 本模块在任何 parts 子目录之前求值. 入口 smoke.ts 用顺序 await import() 钉住. 原文件顶部的 FREEBUFF_DISABLE_BUN 也在入口设置, 早于本模块.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../src/config.ts'
import { startServer } from '../../../../../src/server.ts'
import { ModelStore } from '../../../../../src/web/store/config/model-store.ts'
import { SettingsStore } from '../../../../../src/web/store/config/settings-store.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-'))
saveAccountUser(tmpDir, {
  id: 'u1',
  email: 'smoke@example.com',
  name: 'Smoke',
  authToken: 'token-smoke-1',
})

const config = loadConfig()
config.server.host = '127.0.0.1'
config.server.port = 0
config.server.apiKeys = ['sk-test']
config.upstream.credentialsDir = tmpDir
config.session.pollIntervalSec = 3600
config.limits.maxConcurrentRequests = 2

const runtimes = new AccountRuntimes(config)
const settingsStore = new SettingsStore(path.join(tmpDir, 'settings.json'))
const modelStore = new ModelStore(path.join(tmpDir, 'custom-models.json'))
const server = await startServer({
  config,
  runtimes,
  ...(() => {
    const rt = runtimes.getAny()
    return {
      authToken: rt.authToken,
      authSource: rt.source,
      authEmail: rt.email,
      upstream: rt.upstream,
      sessions: rt.sessions,
    }
  })(),
  settingsStore,
  modelStore,
})
const port = server.address().port
const base = `http://127.0.0.1:${port}`

function chat(body, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

export {
  tmpDir,
  config,
  runtimes,
  settingsStore,
  modelStore,
  server,
  port,
  base,
  chat,
}
