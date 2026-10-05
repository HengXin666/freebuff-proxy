/**
 * refund: 槽位类码只跳过不冷却
 *
 * purchase_capacity / purchase_in_use / premium_slot_taken.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { SessionManager } from '../../../../../../../src/session-manager.ts'
import assert from 'node:assert/strict'

/* ================================================================
   槽位被占 → 用 takeover 显式接管(官方 orchestrator.js:208152-208155)
   ================================================================ */
{
  /**
   * 官方:admission 回 purchase_capacity / purchase_in_use / premium_slot_taken
   * - 且回执带 currentInstanceId 时,带 x-freebuff-takeover-instance-id 重发一次,
   * 把剩余时长移过来(官方文案:"move the remaining time here without another charge").
   *
   * 缺这一步的后果(实测 2026-10-04):账号上游 status:none,balance 15,
   * 但每个请求都 purchase_capacity(回执 currentInstanceId 指向别人),
   * 用户看到[明明有额度却永远说槽位被占].
   *
   * - 反向探针:删掉 admit 里的 takeover 分支后本用例必须变红.
   */
  const calls = []
  let sawTakeover = false
  const up = {
    freebuffSession: async (method, opts = {}) => {
      calls.push({ method, ...opts })
      if (method === 'DELETE') return { status: 'ended' }
      if (method === 'POST') {
        /**
         * - 只认带 takeoverInstanceId 的请求.
         *
         * - 早先用 sawTakeover 标志做"第二次就放行",结果探针测不出实现损坏:
         * 即便实现没发 takeover,第二次 POST 仍被放行 → 断言全绿(假绿).
         * 现在 mock 严格镜像上游语义:不带 takeover 的一律回 purchase_capacity.
         */
        if (!opts.takeoverInstanceId) {
          return {
            status: 'purchase_capacity',
            currentInstanceId: 'holder-inst',
            slotLimit: 1,
            concurrency: 'slot-bound',
          }
        }
        // 带 takeover 重发 → 上游把槽位移交过来
        sawTakeover = true
        return {
          status: 'active',
          instanceId: opts.instanceId || 'ours',
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
    accountKey: 'takeover-case',
  })
  const s = await sm.ensureSession('m-00032eaeec')
  assert.equal(s?.status, 'active', '接管后必须拿到 active 会话')
  const tk = calls.find((c) => c.takeoverInstanceId)
  assert.ok(
    tk,
    `槽位被占时必须带 takeoverInstanceId 重发，got ${JSON.stringify(calls.map((c) => c.method))}`,
  )
  assert.equal(
    tk.takeoverInstanceId,
    'holder-inst',
    'takeoverInstanceId 必须是回执给出的 currentInstanceId（占用者）',
  )
}
