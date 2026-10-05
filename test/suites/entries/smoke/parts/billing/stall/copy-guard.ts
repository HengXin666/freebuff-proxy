/**
 * billing: 全局请求闸门
 *
 * (STALL) 闸门绝不允许无界排队(无界排队下进程正常却不接单).
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { requestSlotStats } from '../../../../../../../src/proxy.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { SessionManager } from '../../../../../../../src/session-manager.ts'
import { waitFor } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// ===========================================================================
// (STALL) 全局请求闸门绝不允许无界排队
//
// 场景: 有几个请求"占着槽位却永久挂起"(客户端声明了 Content-Length 却不再发完
// 请求体, readRequestBody 的 for-await 永不返回), 槽位被永久吃掉.
//
// 本用例用真实 server + 真实半开 socket 复现该场景, 断言:
//   1. 排满时后续请求有界返回 429 server_busy(不永久挂起);
//   2. 半开请求被 bodyReadTimeoutMs 掐掉后, 槽位与队列都回到 0.
{
  const stallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-stall-'))
  saveAccountUser(stallDir, {
    id: 'stall1',
    email: 'stall@example.com',
    authToken: 'token-stall-1',
  })
  const stCfg = loadConfig()
  stCfg.server.host = '127.0.0.1'
  stCfg.server.port = 0
  stCfg.server.apiKeys = ['sk-test']
  stCfg.upstream.credentialsDir = stallDir
  stCfg.session.pollIntervalSec = 3600
  stCfg.limits.maxConcurrentRequests = 2
  stCfg.limits.slotWaitMs = 800
  stCfg.limits.bodyReadTimeoutMs = 2_500

  const stRuntimes = new AccountRuntimes(stCfg)
  const stServer = await startServer({ config: stCfg, runtimes: stRuntimes })
  const stPort = stServer.address().port

  // 半开 chat 请求:声明很大的 Content-Length,只发一个字节就再也不发.
  const halfOpen = []
  for (let i = 0; i < 2; i += 1) {
    const sock = net.connect(stPort, '127.0.0.1')
    sock.on('error', () => {})
    await new Promise((r) => sock.on('connect', r))
    sock.write(
      'POST /v1/chat/completions HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Authorization: Bearer sk-test\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 999999\r\n\r\n',
    )
    sock.write('{"model":"deepseek/deepseek-v4-flash"')
    halfOpen.push(sock)
  }
  // 让两个请求都真正进入"占着槽位读 body"的状态
  await waitFor('两个半开请求占满全局槽位', () => {
    const s = requestSlotStats()
    return s.inFlight >= 2
  }, 3_000)

  const occupied = requestSlotStats()
  assert.equal(occupied.inFlight, 2, '两个半开请求应占满全部 2 个槽位')

  // 此刻来一个完全正常的请求:必须被有界拒绝,绝不永久排队.
  const t0 = Date.now()
  // 用本用例自己的 server(共享 chat() 的 server 在更早已经 close 了)
  const busy = await fetch(`http://127.0.0.1:${stPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'x' }],
    }),
  })
  const waited = Date.now() - t0
  assert.equal(
    busy.status,
    429,
    '闸门排满时必须有界拒绝（429 server_busy），而不是永久挂起',
  )
  const busyBody = await busy.json()
  assert.equal(busyBody.error.code, 'server_busy', '拒绝码必须是 server_busy')
  assert.ok(
    waited < 2_000,
    `排队必须是有界的：实测等待 ${waited}ms，应 < 2000ms（slotWaitMs=800）`,
  )

  // 半开请求被 bodyReadTimeoutMs 掐掉后,槽位与队列必须归零(无泄漏).
  for (const sock of halfOpen) sock.destroy()
  await waitFor('半开请求超时后槽位全部归还', () => {
    const s = requestSlotStats()
    return s.inFlight === 0 && s.queued === 0
  }, 8_000)
  const after = requestSlotStats()
  assert.equal(after.inFlight, 0, '读 body 超时后必须归还槽位（不得泄漏）')
  assert.equal(after.queued, 0, '队列必须清空')

  await stRuntimes.shutdown()
  stServer.close()
  fs.rmSync(stallDir, { recursive: true, force: true })
}

// ===========================================================================
// (FBGATE) 封号判定的两条条件都必须拦
//
// 上游对"余额不够"的封号判定有两条:
//   ① Freebucks 跑完了(今日池 daily.remaining <= 0)
//   ② 本次请求所需 Freebucks 高于剩余余额(balance < prices[model])
// 本用例锁死两条都拦, 并断言 reason 能区分是哪一条.
{
  const sm = new SessionManager({
    config: loadConfig(),
    accountKey: 'fbgate',
    upstream: {},
  })

  const price = 25
  const model = 'deepseek/deepseek-v4-flash'

  // ① 今日池跑完但余额看着还够 ---- 也必须拦
  sm.freebucks = {
    balance: 100,
    daily: { limit: 85, spent: 85, remaining: 0, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const dailyGone = sm.freebucksFor(model)
  assert.equal(
    dailyGone.affordable,
    false,
    '今日池跑完（daily.remaining <= 0）必须拦——否则命中上游封号条件①',
  )
  assert.equal(dailyGone.reason, 'daily_exhausted', '必须标明是池子跑完')

  // ② 余额买不起本次请求 ---- 必须拦
  sm.freebucks = {
    balance: 1,
    daily: { limit: 85, spent: 20, remaining: 65, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const poor = sm.freebucksFor(model)
  assert.equal(poor.affordable, false, '余额 < 单价 必须拦——上游封号条件②')
  assert.equal(poor.reason, 'balance_shortfall', '必须标明是余额不足')

  // 两条都不命中 → 放行(不能误伤正常账号)
  sm.freebucks = {
    balance: 100,
    daily: { limit: 85, spent: 20, remaining: 65, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const ok = sm.freebucksFor(model)
  assert.equal(ok.affordable, true, '额度充足必须放行（不得误伤）')
  assert.equal(ok.reason, null, '放行时不应有 reason')

  // limit = 0 表示"没有池子",不是"池子跑完"----不得误判为耗尽
  sm.freebucks = {
    balance: 100,
    daily: { limit: 0, spent: 0, remaining: 0, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const noPool = sm.freebucksFor(model)
  assert.equal(
    noPool.affordable,
    true,
    'daily.limit=0 是"没有池子"，不是"池子跑完"，不得误拦',
  )

  // quotaExempt 账号不受池与余额限制
  sm.freebucks = {
    balance: 0,
    daily: { limit: 85, spent: 85, remaining: 0, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: true,
    monthly: null,
  }
  assert.equal(
    sm.freebucksFor(model).affordable,
    true,
    'quotaExempt 账号不受池/余额限制',
  )

  // 每日池 resetAt 已过 → 本地数字视为过期,放行一次真实 admit 重新校准
  sm.freebucks = {
    balance: 0,
    daily: {
      limit: 85,
      spent: 85,
      remaining: 0,
      resetAt: new Date(Date.now() - 60_000).toISOString(),
    },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const stale = sm.freebucksFor(model)
  assert.equal(
    stale.affordable,
    true,
    'resetAt 已过说明本地数字过期，必须放行重新校准（否则账号被永久锁死）',
  )
  assert.equal(stale.stale, true, '必须标记为 stale')
}
