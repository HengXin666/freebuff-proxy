/**
 * pool: 接管探测的退避与拦截日志限频
 *
 * 池内额度不足的账号不再在每个请求里各付一次 GET /session; 拦截日志按账号限频.
 *
 * 判据(可证伪): 删掉 src/context/sched/account-gates.ts 里那句
 * if (Date.now() < (rt.paidProbeRetryAt || 0)) return '' -> 闸门计数回到每个请求
 * 每个账号 1 次, 第一条断言红; 把 skipLogOnce 换回 logger.info -> 第二条断言红.
 */

import { buildAppContext } from '../../../../../../../src/app-context.ts'
import {
  clearRing,
  configureLogBuffer,
  configureLogger,
  readLogBuffer,
} from '../../../../../../../src/util/log.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 造一个"额度不足"的账号池: 两个账号各记一笔买不起的 Freebucks 账.
 *
 * 上游 GET 一律回 status none(探测成功但没有可接管会话) ---- 这正是
 * "探测没命中"的常态, 也正是被反复重探的场景.
 * @param {string} prefix 临时目录前缀
 * @param {number} count 账号数
 * @returns {Promise<any>} { ctx, dir, probes }
 */
async function poolWithExhaustedAccounts(prefix, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const cfgMod = await import('../../../../../../../src/config.ts')
  const cfg = cfgMod.loadConfig()
  cfg.server.host = '127.0.0.1'
  cfg.server.port = 0
  cfg.upstream.credentialsDir = dir
  cfg.session.pollIntervalSec = 3600
  /** 探到的上游 session:GET 次数(退避生效时必须远小于请求数). */
  const probes = { get: 0 }
  const keys = []
  for (let i = 0; i < count; i++) {
    const key = 'pb' + i
    keys.push(key)
    fs.writeFileSync(
      path.join(dir, key + '.json'),
      JSON.stringify({ id: key, email: key + '@example.com', authToken: 'tok-' + key }),
    )
  }
  const ctx = buildAppContext(cfg)
  for (const key of keys) {
    const rt = ctx.runtimes.get(key)
    // 只读探测的替身: 记账后回与真实上游同形的回执(没有任何活跃会话).
    rt.sessions.refresh = async () => {
      probes.get += 1
      return { status: 'none' }
    }
    // 两本账都判"新买一条买不起"(daily 池跑完 + 单价高于余额).
    rt.sessions.freebucks = {
      balance: 0,
      daily: { limit: 25, spent: 25, remaining: 0, resetAt: '2099-01-01T00:00:00.000Z' },
      wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
      prices: { 'm-00032eaeec': 15 },
      quotaExempt: false,
      planId: null,
      monthly: null,
      peak: null,
      updatedAt: new Date().toISOString(),
    }
  }
  return { ctx, dir, probes }
}

// --- (1) 同一请求内对同一账号只探一次, 且第二个账号各探一次 ----------------
{
  const { ctx, dir, probes } = await poolWithExhaustedAccounts('fb-probe-backoff-', 2)
  let thrown = null
  try {
    await ctx.runtimes.acquireForModel('m-00032eaeec')
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown, '全池买不起时必须抛出错误')
  assert.equal(
    probes.get,
    2,
    '首轮每个账号各探一次(共 2 次), got ' + probes.get,
  )

  // --- (2) 退避窗口内不再探测 ---------------------------------------------
  const before = probes.get
  for (let i = 0; i < 5; i++) {
    try {
      await ctx.runtimes.acquireForModel('m-00032eaeec')
    } catch {
      // 仍然全池买不起, 抛错是预期
    }
  }
  assert.equal(
    probes.get,
    before,
    '退避窗口内 5 个请求不得再发探测(否则每个请求每账号一次往返), got ' + probes.get,
  )
  // 窗口随 runtime 走: 换一个 runtime(重建)后窗口归零, 允许再探一次.
  const rt0 = ctx.runtimes.get('pb0')
  assert.ok(
    Number(rt0.paidProbeRetryAt) > Date.now(),
    '退避窗口必须写回 runtime(请求级 state 挡不住下一个请求)',
  )
  rt0.paidProbeRetryAt = 0
  try {
    await ctx.runtimes.acquireForModel('m-00032eaeec')
  } catch {
    // 同上
  }
  assert.ok(
    probes.get >= before + 1,
    '窗口归零后必须能再探一次, got ' + probes.get,
  )
  await ctx.runtimes.shutdown().catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- (3) 拦截日志按(账号, 码)限频 ------------------------------------------
{
  const { ctx, dir, probes } = await poolWithExhaustedAccounts('fb-skip-log-', 2)
  // smoke 全局把级别设成了 error, info 会被过滤掉; 同 log-buffer 用例的做法: 临时放开再还原.
  configureLogger({ level: 'info' })
  const cap = configureLogBuffer(500)
  clearRing()
  for (let i = 0; i < 4; i++) {
    try {
      await ctx.runtimes.acquireForModel('m-00032eaeec')
    } catch {
      // 预期: 全池买不起
    }
  }
  const skipLines = readLogBuffer({ limit: 500 }).filter((l) =>
    String(l.msg || '').startsWith('skip account:'),
  )
  assert.deepEqual(
    skipLines.map((l) => l.key).sort(),
    ['pb0', 'pb1'],
    '4 个请求只应留 2 条(每个账号一条) skip 日志, got ' + JSON.stringify(skipLines.map((l) => l.key)),
  )
  assert.equal(
    probes.get,
    2,
    '限频用例里探测同样只该发生一次/账号, got ' + probes.get,
  )
  configureLogger({ level: 'error' })
  configureLogBuffer(cap)
  await ctx.runtimes.shutdown().catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
}
