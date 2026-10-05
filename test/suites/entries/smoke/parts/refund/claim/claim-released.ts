/**
 * refund: purchase_claim_released 两段式
 *
 * 收到该码要 DELETE 作废旧 claim 并换新 instanceId 重试一次.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { SessionManager } from '../../../../../../../src/session-manager.ts'
import assert from 'node:assert/strict'

/* ================================================================
   回归:issue #24 ---- 付费时段内换模型不得释放已买断的会话
   ================================================================ */
{
  const events = []
  const up = {
    freebuffSession: async (method, opts = {}) => {
      events.push(method + (opts.model ? ':' + opts.model : ''))
      if (method === 'DELETE') return { status: 'ended' }
      if (method === 'POST') return { status: 'purchase_claim_released' }
      return { status: 'none' }
    },
  }
  const sm = new SessionManager({
    upstream: up,
    config: {
      session: { reAdmitOnExpire: true, reAdmitLeadSec: 60, freeModelReAdmitLeadSec: 60 },
      limits: {},
    },
    accountKey: 'paid-switch',
  })
  // 一条买断整小时,还差 50 分钟到期的会话
  sm.session = {
    status: 'active',
    instanceId: 'inst-paid',
    model: 'm-69307952f8',
    admittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3000_000).toISOString(),
    remainingMs: 3000_000,
  }
  await assert.rejects(
    () => sm.ensureSession('mimo/mimo-v2.5'),
    (err) => err.code === 'paid_window_model_mismatch',
    '付费时段内换模型必须被拦',
  )
  /**
   * - 核心断言:绝不能发 DELETE.
   * - 改前这里无条件 _releaseUnlocked(),而实测 DELETE 之后接不回来
   * (0s/45s/90s 三次重试全部 purchase_claim_released)---- 已买断的一小时
   * 既不能用也拿不回来.
   */
  assert.equal(
    events.includes('DELETE'),
    false,
    `付费时段内绝不能 DELETE 已付费会话，got ${JSON.stringify(events)}`,
  )
  assert.equal(sm.session?.instanceId, 'inst-paid', '已付费会话句柄必须原样保留')
  assert.equal(sm.session?.status, 'active', '已付费会话状态不得被篡改')
  assert.equal(sm.inPaidWindow(), true)

  // 同一模型继续请求 → 走热路径复用(边际成本 0),零上游调用
  events.length = 0
  await sm.ensureSession('m-69307952f8')
  assert.equal(events.length, 0, '同模型应纯复用，不产生任何上游调用')

  // 用户主动释放(时段结束/手动关闭)后,换模型才允许 admit
  await sm.release()
  events.length = 0
  await sm.ensureSession('mimo/mimo-v2.5').catch(() => {})
  assert.ok(
    events.some((e) => e.startsWith('POST')),
    `释放后换模型应能 admit，got ${JSON.stringify(events)}`,
  )
}

/* ================================================================
   purchase_claim_released:必须换新 instanceId 重试(官方语义),且多轮稳定
   ================================================================ */
{
  /**
   * 官方真值(orchestrator.js:208166-208177):
   * 收到 purchase_claim_released
   * → recovery.finish(结束失败尝试)
   * → releasePurchaseClaim()(DELETE 那条作废的 claim)
   * → host.forget(instanceId) + crypto.randomUUID()(换全新 id)
   * - → 重试一次(rotated)
   *
   * 我们此前把它当"槽位忙"跳过 → 永远卡在同一个作废 id 上(真实事故:
   * 连续三个模型全部失败,含单价 0 的模型,直到 expiresAt 才恢复).
   *
   * - 这里用纯 mock 复现该形态,并连跑 5 轮(用户要求[至少测试五轮]----
   * 单轮会漏掉"第一轮侥幸成功,后续卡死"这类问题).
   */
  const events = []
  const retired = new Set()          // 已被作废过的 instanceId
  let admitCount = 0
  const up = {
    freebuffSession: async (method, opts = {}) => {
      events.push(method + (opts.instanceId ? ':' + opts.instanceId : ''))
      if (method === 'DELETE') {
        // 官方 releasePurchaseClaim 就是 deleteSession ---- 删掉作废的 claim
        return { status: 'ended' }
      }
      if (method === 'POST') {
        const id = opts.instanceId || null
        /**
         * - 只让第一个 id 作废一次(模拟上游对那条 claim 的作废).
         * 换新 id 后必须放行 ---- 这正是本用例要验证的行为:
         * 若不换 id(旧行为),会带同一个 id 再来 → 已在 retired 里 → 继续被拒.
         * - 不能写成"第一次见的 id 就作废":那会让换新后的 id 也被作废
         * (实测踩到,测试因此恒失败).
         */
        if (id && !retired.has(id) && retired.size === 0) {
          retired.add(id)
          return { status: 'purchase_claim_released' }
        }
        admitCount += 1
        return {
          status: 'active',
          instanceId: id,
          model: 'm-00032eaeec',
          admittedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          remainingMs: 3600_000,
          accessTier: 'limited',
        }
      }
      return { status: 'none' }
    },
  }
  const sm = new SessionManager({
    upstream: up,
    config: {
      session: { reAdmitOnExpire: true, reAdmitLeadSec: 60, freeModelReAdmitLeadSec: 60 },
      limits: {},
    },
    accountKey: 'claim-rotate',
  })
  const firstId = sm.instanceId
  const session = await sm.ensureSession('m-00032eaeec')
  assert.equal(session?.status, 'active', '换 ID 重试后必须拿到 active')
  assert.notEqual(
    sm.instanceId,
    firstId,
    'purchase_claim_released 后必须换一个**全新** instanceId（官方 crypto.randomUUID 同语义）',
  )
  assert.ok(
    events.some((e) => e.startsWith('DELETE')),
    `作废的 claim 必须被 DELETE（官方 releasePurchaseClaim），got ${JSON.stringify(events)}`,
  )

  /**
   * 多轮稳定性:同一实例上连发 5 轮,每轮都要能复用热 session(零新增 admit).
   * 这条正是"第一轮成功,后续卡死"那类问题的守门人.
   */
  const before = admitCount
  for (let i = 1; i <= 5; i += 1) {
    const s2 = await sm.ensureSession('m-00032eaeec')
    assert.equal(s2?.status, 'active', `第 ${i}/5 轮必须仍有可用会话`)
  }
  assert.equal(
    admitCount,
    before,
    `5 轮必须全部复用热 session（不得反复重买），got 新增 admit=${admitCount - before}`,
  )
}
