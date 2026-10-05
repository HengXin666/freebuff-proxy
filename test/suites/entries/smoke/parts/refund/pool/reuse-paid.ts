/**
 * refund: 复用已付费会话
 *
 * 有 1 个会话就该复用; 免费购买的会话不得被筛选排除.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { SessionManager } from '../../../../../../../src/session-manager.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ================================================================
   冷却的边界:banned 必须仍冷却(不能被任何"付费会话保护"吞掉)
   ================================================================ */
{
  /**
   * - 这里曾经有一条断言要求"持有已付费会话时不得因
   * - start_agent_run_failed 整号冷却" ---- 那条已删除,因为它与本文
   * - 既有的换号用例(expected 2 session POSTs)以及 AGENTS.md 明写的纪律
   * - 直接冲突:
   *
   * [上游报错(startAgentRun 失败 / 5xx / 403 账号级封禁 / 网络超时)
   * 冷却当前账号并继续轮询下一个]
   *
   * 两者不可能同时成立.保留既有纪律(它先存在,且测完整链路),
   * - 删掉与之矛盾的断言 ---- 已付费会话的价值由[付费时段内绝不释放]
   * 那条纪律保护,不靠"禁止冷却".
   *
   * - 本用例只钉住不矛盾的边界:banned 是账号终点,必须冷却.
   */
  const { buildAppContext } = await import('../../../../../../../src/app-context.ts')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-bannedcool-'))
  const cfg = loadConfig()
  cfg.server.host = '127.0.0.1'
  cfg.server.port = 0
  cfg.upstream.credentialsDir = tmpDir
  cfg.session.pollIntervalSec = 3600
  fs.writeFileSync(
    path.join(tmpDir, 'p.json'),
    JSON.stringify({ id: 'p', email: 'paid@example.com', authToken: 'tok-p' }),
  )
  const rt = new AccountRuntimes(cfg)
  const sm = rt.get('p').sessions
  sm.session = {
    status: 'active',
    instanceId: 'inst-paid',
    model: 'm-00032eaeec',
    admittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3000_000).toISOString(),
  }
  assert.equal(sm.inPaidWindow(), true, '对照前提：应处于付费时段内')
  rt.markCooldown('p', { code: 'banned', status: 403 })
  assert.equal(
    rt.cooldowns.has('p'),
    true,
    'banned 是账号终点，必须冷却（付费时段也不例外）',
  )
}

/* ================================================================
   余额 0 但有上游已付费会话 → 必须接管复用(不得被额度闸门挡住)
   ================================================================ */
{
  /**
   * 2026-10-04 铁律(用户明确要求[它有 1 个会话你可以复用啊,记得复用]):
   *
   * - 一次 admit 买断一小时 → 这一小时内继续发请求边际成本为 0.
   * - balance: 0 只说明"再买一条买不起",不代表已付费的会话不能用.
   * - 实测代价:面板显示 DeepSeek V4.1 Flash . 49 分钟 的已付费会话,
   * 而调度因余额闸门跳过该账号 → 用户看到"有会话却一直 429",白扔那一小时.
   *
   * - 判据:上游清单里有同模型,未过期的 holderInstanceId 时,
   * - 即使 balance 不够,也要走 takeover 复用,不得抛 freebucks_exhausted.
   *
   * - 反向探针:把 paidUpstream 那段短路后本用例必须变红.
   */
  const HOLDER = 'other-deployment-paid-inst'
  const calls = []
  const up = {
    freebuffSession: async (method, opts = {}) => {
      calls.push({ method, ...opts })
      if (method === 'DELETE') return { status: 'ended' }
      if (method === 'GET') {
        // 上游:该模型有一条别人建的已付费会话(余额其实够,但这里刻意压低)
        return {
          status: 'none',
          freebucks: { balance: 0, daily: { limit: 25, remaining: 0 }, prices: { 'm-00032eaeec': 10 } },
          desktopPurchases: [
            {
              model: 'm-00032eaeec',
              expiresAt: new Date(Date.now() + 3000_000).toISOString(),
              holderInstanceId: HOLDER,
            },
          ],
        }
      }
      if (method === 'POST') {
        return {
          status: 'active',
          instanceId: opts.instanceId || 'ours',
          model: 'm-00032eaeec',
          admittedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3000_000).toISOString(),
          remainingMs: 3000_000,
          accessTier: 'limited',
        }
      }
      return { status: 'none' }
    },
  }
  const sm = new SessionManager({
    upstream: up,
    config: { session: { reAdmitOnExpire: true, reAdmitLeadSec: 60, freeModelReAdmitLeadSec: 60 }, limits: {} },
    accountKey: 'paid-upstream',
  })
  /**
   * - 请求的模型必须与清单里那条会话绑定的模型一致 ---- 否则会撞上另一条
   * - 独立规则(paid_window_model_mismatch:付费时段内换模型 = 纯亏损,
   * 实测 DELETE 后接不回来).本用例只测"余额不足不得挡住复用".
   */
  const s = await sm.ensureSession('m-00032eaeec')
  assert.equal(s?.status, 'active', '有上游已付费会话时必须能复用到 active')
  const pk = calls.find((c) => c.method === 'POST' && c.takeoverInstanceId)
  assert.equal(
    pk?.takeoverInstanceId,
    HOLDER,
    `必须带上占用者做 takeover 复用，got ${JSON.stringify(calls.map((c) => c.method + (c.takeoverInstanceId ? '+tk' : '')))}`,
  )
}

/* ================================================================
   免费模型(price === 0)不受 Freebucks 闸门约束
   ================================================================ */
{
  /**
   * 用户报(2026-10-04):[有些会话它的购买是免费的,而你这个筛选判断就把免费的
   * 给它排除了......你就硬说他是没有余额,就不参与判断了,怎么能够这样?]
   *
   * - 上游价格表里确实有 price: 0 的免费模型(实测 upstage/solar-mini4,
   * - stealth/space-bunny-alpha).既然它不花钱,"余额 0 / 每日池耗尽"就与它
   * 无关 ---- 用"没钱"拒绝一个免费模型是纯自伤:用户明明能用,被我们自己的闸门挡住.
   *
   * - 但只豁免"钱":会话次数(rateLimitsByModel)是上游的独立额度,
   * - 免费模型同样受它约束(实测这两个免费模型也是 2.5/6).
   *
   * - 反向探针:去掉 isFreeModel 对 dailyExhausted/shortOnBalance 的短路后
   * 本用例必须变红.
   */
  const sm = new SessionManager({
    upstream: { freebuffSession: async () => null },
    config: { session: {}, limits: {} },
    accountKey: 'free-model',
  })
  sm.freebucks = {
    balance: 0,
    daily: { limit: 25, remaining: 0, resetAt: '2099-01-01T16:00:00.000Z' },
    prices: { 'upstage/solar-mini4': 0, 'mimo/mimo-v2.5': 10 },
  }
  const free = sm.freebucksFor('upstage/solar-mini4')
  assert.equal(free.affordable, true, '免费模型（price 0）必须放行 —— 它不花钱')
  assert.equal(free.reason, null, '免费模型不该有拒绝原因')
  const paid = sm.freebucksFor('mimo/mimo-v2.5')
  assert.equal(paid.affordable, false, '对照：付费模型余额不足仍应拒绝')
  assert.equal(paid.reason, 'daily_exhausted', '对照：原因应为日池耗尽')
  // 对照:次数闸门对免费模型仍然生效(不是"免费就无限制")
  sm.quota = { byModel: { 'upstage/solar-mini4': { recentCount: 6, limit: 6 } } }
  const u = sm.sessionUnitsFor('upstage/solar-mini4')
  assert.equal(u.exhausted, true, '免费模型仍受会话次数闸门约束（上游的独立额度）')
}
