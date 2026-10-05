/**
 * refund: 并发 join 顺序
 *
 * 多个在途结束时释放槽位的顺序.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { SessionManager } from '../../../../../../../src/session-manager.ts'
import assert from 'node:assert/strict'

/* ================================================================
   admission 前必须先结清"待结束的会话"(官方 journal.pending 循环)
   ================================================================ */
{
  /**
   * - 官方 orchestrator.js:208130-208136:
   * for (let end of journal.pending(owner)) {
   * if (end.instanceId !== instanceId) continue;
   * if ((await recovery.finish(end, auth)).status === 'ended') continue;
   * throw localSessionError('previous_end_unconfirmed');
   * }
   * - 即:同一条 instanceId 上有未结清的会话时,先结束它再 admission.
   *
   * - 不这么做的后果(实测):上游认为槽位仍被占 → purchase_capacity;
   * - 而本地 _apply 已把 session 覆盖成 none → 面板说"没有会话",
   * 两边各说各话,用户完全无法判断.
   *
   * - 反向探针:删掉 admit 里那段 if (this._releasePending ...) 后本用例必须变红.
   */
  const events = []
  const up = {
    freebuffSession: async (method, opts = {}) => {
      events.push(method + (opts.instanceId ? ':' + opts.instanceId : ''))
      if (method === 'DELETE') return { status: 'ended' }
      if (method === 'POST') {
        return {
          status: 'active',
          instanceId: opts.instanceId || 'fresh-id',
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
    accountKey: 'pending-end',
  })
  // 模拟"有一条待结束的会话"(DELETE 曾失败 → _releasePending 置位)
  sm.session = { status: 'none', instanceId: 'stale-inst' }
  sm._releasePending = true
  events.length = 0
  await sm.ensureSession('m-00032eaeec')
  assert.ok(
    events.some((e) => e === 'DELETE:stale-inst'),
    `admission 前必须先 DELETE 那条待结束的会话，got ${JSON.stringify(events)}`,
  )
  assert.equal(
    events.indexOf('DELETE:stale-inst') < events.findIndex((e) => e.startsWith('POST')),
    true,
    `DELETE 必须发生在 admission **之前**，got ${JSON.stringify(events)}`,
  )
  assert.equal(sm._releasePending, false, '结清后 _releasePending 必须复位')
}
