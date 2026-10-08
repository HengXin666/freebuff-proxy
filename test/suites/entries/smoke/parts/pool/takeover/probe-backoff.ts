/**
 * pool: 接管探测的退避与拦截日志限频
 *
 * 池内额度不足的账号不再在每个请求里各付一次 GET /session; 拦截日志按账号限频.
 *
 * 替换说明: 本用例用测试替身接管 rt.sessions.refresh, 因此覆盖的是[探测与否]的
 * 调度语义, 不覆盖真实 SessionManager 在有在途请求时如何置 lastProbeSkipped.
 *
 * 判据(可证伪): 去掉 rt.paidProbeRetryAt 的窗口判断 -> 探测计数回到每请求每账号
 * 一次, 断言 (2) 变红; 把 skipLogOnce 换回 logger.info -> 断言 (3) 变红;
 * 让被跳过的探测也开窗 -> 断言 (6) 变红.
 */

import { buildAppContext } from '../../../../../../../src/app-context.ts'
import { makePaidUpstreamChecker } from '../../../../../../../src/context/sched/account-gates.ts'
import {
  clearRing,
  configureLogBuffer,
  configureLogger,
  readLogBuffer,
} from '../../../../../../../src/util/log.ts'
import { skipLogOnce } from '../../../../../../../src/util/log.ts'
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
  const retryAt = Number(rt0.paidProbeRetryAt)
  const now = Date.now()
  assert.ok(
    retryAt > now,
    '退避窗口必须写回 runtime(请求级 state 挡不住下一个请求), retryAt=' +
      retryAt + ' now=' + now + ' 差=' + (retryAt - now) + 'ms',
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
  /**
   * 不钉死[恰好 2 条]: 若某个请求真的走到[复用已付费会话]那条分支, 会额外记一条
   * 不受限频约束的 reusing 日志, 固定条数会误红. 这里断言的是限频本身:
   * 同一 (账号, 码) 在窗口内至多出现一条.
   */
  const seenPairs = skipLines.map((l) => l.key + '|' + l.msg)
  assert.equal(
    new Set(seenPairs).size,
    seenPairs.length,
    '同一(账号, 拦截码)在限频窗口内至多一条, got ' + JSON.stringify(seenPairs),
  )
  assert.ok(
    skipLines.length <= 2,
    '4 个请求对 2 个账号至多各留 1 条 skip 日志, got ' + skipLines.length,
  )
  assert.ok(skipLines.length > 0, '限频不等于不记: 窗口内首条必须留下')
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

// --- (4) 退避窗口只挡[再问上游], 不挡[用已经知道的结果] ---------------------
{
  /**
   * 判据(可证伪): 把 makePaidUpstreamChecker 改回"窗口内返回空串 / 调用方把空串
   * 换成恒 false 的 checker"-> 第二条断言红(已记录的持有者被当成没有, 等于把
   * 已经付过钱的一小时丢掉, 再去别的账号买新的).
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-holder-window-'))
  const cfgMod = await import('../../../../../../../src/config.ts')
  const cfg = cfgMod.loadConfig()
  cfg.upstream.credentialsDir = dir
  cfg.session.pollIntervalSec = 3600
  fs.writeFileSync(
    path.join(dir, 'hb.json'),
    JSON.stringify({ id: 'hb', email: 'hb@example.com', authToken: 'tok-hb' }),
  )
  const ctx = buildAppContext(cfg)
  const rt = ctx.runtimes.get('hb')
  const MODEL = 'deepseek/deepseek-v4-flash'
  let probes = 0
  rt.sessions.refresh = async () => {
    probes += 1
    // 上游清单里有一条别的部署建的, 同模型未过期的已付费会话
    rt.sessions.desktopPurchases = [
      {
        holderInstanceId: 'other-deploy',
        model: MODEL,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    ]
    return { status: 'none' }
  }
  const emailByKey = new Map([['hb', 'hb@example.com']])

  const first = await makePaidUpstreamChecker(rt, 'hb', MODEL, emailByKey)()
  assert.equal(first, true, '首次探测应发现可接管的已付费会话')
  assert.equal(probes, 1, '首次探测应真的问上游一次, got ' + probes)
  const retryAt = Number(rt.paidProbeRetryAt)
  assert.ok(
    retryAt > Date.now(),
    '探测问过上游后必须开窗(否则下一个请求会重复问), retryAt=' + retryAt +
      ' now=' + Date.now(),
  )

  const second = await makePaidUpstreamChecker(rt, 'hb', MODEL, emailByKey)()
  assert.equal(
    second,
    true,
    '退避窗口内已记录的持有者必须仍能接管(旧实现: 窗口内恒 false, 白丢已付费的一小时)',
  )
  assert.equal(probes, 1, '窗口内不得再问上游(探测次数必须停在 1), got ' + probes)

  await ctx.runtimes.shutdown().catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
}
