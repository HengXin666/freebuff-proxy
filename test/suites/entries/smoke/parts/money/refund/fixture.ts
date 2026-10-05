/**
 * freebucks 夹具
 *
 * 18 条前缀语句: 三个账号 / 空闲释放与预算配置 / 自己的 server / chat 客户端 / Freebucks 计量块. 后面五组 freebucks 用例共享这一套.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

// 这些绑定被同目录下的多个用例文件共享; 由本模块负责建好, 只此一份.

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-fb-'))
saveAccountUser(fbDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
saveAccountUser(fbDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
saveAccountUser(fbDir, { id: 'c', email: 'c@example.com', authToken: 'token-c' })
const fbConfig = loadConfig()
fbConfig.server.host = '127.0.0.1'
fbConfig.server.port = 0
fbConfig.server.apiKeys = ['sk-test']
fbConfig.upstream.credentialsDir = fbDir
fbConfig.session.pollIntervalSec = 3600
// 空闲释放调到 150ms(测试用),预算 2
fbConfig.session.idleReleaseSec = 0.15
fbConfig.limits.maxNewSessionsPerRequest = 2
const fbRuntimes = new AccountRuntimes(fbConfig)
const fbServer = await startServer({
  config: fbConfig,
  runtimes: fbRuntimes,
  ...(() => {
    const rt = fbRuntimes.getAny()
    return {
      authToken: rt.authToken,
      authSource: rt.source,
      authEmail: rt.email,
      upstream: rt.upstream,
      sessions: rt.sessions,
    }
  })(),
})
const fbPort = fbServer.address().port
const fbChat = (body) =>
  fetch(`http://127.0.0.1:${fbPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

const futureReset = new Date(Date.now() + 6 * 3600_000).toISOString()
const freebucks25 = {
  balance: 25,
  daily: { limit: 25, spent: 0, remaining: 25, resetAt: futureReset },
  wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
  prices: { 'deepseek/deepseek-v4-flash': 2 },
}

export {
  fbDir,
  fbConfig,
  fbRuntimes,
  fbServer,
  fbPort,
  fbChat,
  futureReset,
  freebucks25,
}
