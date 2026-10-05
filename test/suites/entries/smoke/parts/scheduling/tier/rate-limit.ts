/**
 * scheduling: 完成层限流与冷却
 *
 * completion 层的 free_mode_rate_limited 与冷却时间戳.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { state } from '../../../../../smoke/state.ts'
import { config } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// completions 返回 free_mode_rate_limited → 冷却当前账号并换号重试一次
{
  const rlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-rlcomp-'))
  saveAccountUser(rlDir, {
    id: 'a',
    email: 'a@example.com',
    authToken: 'token-a',
  })
  saveAccountUser(rlDir, {
    id: 'b',
    email: 'b@example.com',
    authToken: 'token-b',
  })
  const rlConfig = loadConfig()
  rlConfig.server.host = '127.0.0.1'
  rlConfig.server.port = 0
  rlConfig.server.apiKeys = ['sk-test']
  rlConfig.upstream.credentialsDir = rlDir
  rlConfig.session.pollIntervalSec = 3600
  const rlRuntimes = new AccountRuntimes(rlConfig)
  const rlServer = await startServer({
    config: rlConfig,
    runtimes: rlRuntimes,
    ...(() => {
      const rt = rlRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const rlPort = rlServer.address().port
  state.mockMode = 'rate_limit_completion'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${rlPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  // a 完成被 429 后换到 b 重试:2 次 session POST,2 次 completions
  assert.equal(state.sessionPosts, 2, `expected 2 session POSTs, got ${state.sessionPosts}`)
  assert.equal(state.completionAttempts, 2)
  const rlAccounts = rlRuntimes.list()
  const rlA = rlAccounts.find((x) => x.email === 'a@example.com')
  assert.equal(rlA.available, false)
  assert.equal(rlA.cooldownCode, 'free_mode_rate_limited')
  /**
   * 冷却时长采用上游 retry-after(60s).
   *
   * - 下限取 50s:冷却是按 Date.now() + 60_000 设置时刻算的, 而本断言在用例
   * 跑了一段时间后才执行, 得到比 60s 略小的抖动值. 拿 58s 当下限会把"执行
   * 快慢"当成缺陷; 判据是"确实采用了 60s 这个量级"(误用默认 5min/15min 会
   * 远超, 用 30s 会低于).
   */
  const cd = rlRuntimes.cooldowns.get('a')
  assert.ok(
    cd.until - Date.now() >= 50_000,
    `cooldown should honor retry-after 60s, got ${cd.until - Date.now()}ms`,
  )
  // 可观测性:响应头标明实际账号;换号后是 b
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  await rlRuntimes.shutdown()
  rlServer.close()
  fs.rmSync(rlDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}

// cooldown: model_unavailable is per-model, not whole account
{
  const pool = new AccountRuntimes(config)
  pool.markCooldown(
    'u1',
    { code: 'model_unavailable', retryAfterMs: 60_000 },
    'openai/gpt-5.6-luna',
  )
  assert.equal(
    pool.isCoolingDown('u1', 'openai/gpt-5.6-luna'),
    true,
  )
  assert.equal(
    pool.isCoolingDown('u1', 'deepseek/deepseek-v4-flash'),
    false,
  )
  pool.markCooldown('u1', {
    code: 'banned',
    retryAfterMs: 1000,
  })
  assert.equal(pool.isCoolingDown('u1', 'any'), true)
  const cd = pool.cooldowns.get('u1')
  assert.ok(cd.until - Date.now() > 60_000) // banned floors to 1 day
}
