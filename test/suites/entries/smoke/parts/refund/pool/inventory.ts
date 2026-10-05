/**
 * refund: 上游会话清单
 *
 * GET /session 回执里的 desktopPurchases; 刷新时就要知道会话数并显示到前端.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { SessionManager } from '../../../../../../../src/session-manager.ts'
import assert from 'node:assert/strict'

/* ================================================================
   会话清单(desktopPurchases)解析 + 发请求前先用 knownHolder 接管
   ================================================================ */
{
  /**
   * - 上游 GET /session 回执里带会话清单:
   * "desktopPurchases": [{"model":"mimo/mimo-v2.5",
   * "expiresAt":"...","holderInstanceId":"6c5b0c7e-..."}]
   * - 官方据此实现 knownHolder(model)(orchestrator.js:208639),
   * - 在发请求之前就知道槽位被谁占着 ---- 该信息跨部署可见:
   * 真值在上游,本地/远程各建过会话时上游回执会把全部持有者列出来.
   *
   * - 反向探针:删掉 _apply 里的 desktopPurchases 解析后本用例必须变红.
   */
  const calls = []
  const HOLDER = 'other-deployment-inst'
  const up = {
    freebuffSession: async (method, opts = {}) => {
      calls.push({ method, ...opts })
      if (method === 'DELETE') return { status: 'ended' }
      if (method === 'GET') {
        // GET 回执带"别人占着槽位"的清单
        return {
          status: 'none',
          desktopSessionCounts: { premium: 1, unlimited: 0, nextExpiryAt: null },
          desktopPurchases: [
            {
              model: 'm-00032eaeec',
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              holderInstanceId: HOLDER,
            },
          ],
        }
      }
      if (method === 'POST') {
        // 只有带正确 takeover 头才放行(镜像上游语义)
        if (opts.takeoverInstanceId !== HOLDER) {
          return { status: 'purchase_capacity', currentInstanceId: HOLDER, slotLimit: 1 }
        }
        return {
          status: 'active',
          instanceId: opts.instanceId,
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
    config: { session: { reAdmitOnExpire: true, reAdmitLeadSec: 60, freeModelReAdmitLeadSec: 60 }, limits: {} },
    accountKey: 'inventory-case',
  })
  const s = await sm.ensureSession('m-00032eaeec')
  assert.equal(s?.status, 'active', '从清单读到占用者后应能直接接管成功')
  assert.equal(sm.holderFor('m-00032eaeec'), HOLDER, 'holderFor 必须能从清单读出占用者（跨部署可见）')
  const firstPost = calls.find((c) => c.method === 'POST')
  assert.equal(
    firstPost?.takeoverInstanceId,
    HOLDER,
    `**首次** POST 就该带 takeover（官方 knownHolder 的用法），got ` +
    `${JSON.stringify(calls.map((c) => c.method + (c.takeoverInstanceId ? '+tk' : '')))}`,
  )
}

/* ================================================================
   刷新(refresh)必须把上游会话清单带进快照 → 前端可显示
   ================================================================ */
{
  /**
   * 用户诉求:[刷新的时候就知道有多少个会话清单,并且显示在前端].
   *
   * - 上游 GET /session 回执带 desktopPurchases(含别的部署建的会话)→
   * - _absorbInventory 吸收 → getSnapshot().inventory 带出去 → 前端渲染.
   *
   * - 反向探针:把 _absorbInventory 从 refresh 路径拿掉后本用例必须变红.
   */
  const OTHER = 'other-deployment-inst'
  const up = {
    freebuffSession: async (method) => {
      if (method === 'GET') {
        return {
          status: 'none',
          desktopPurchases: [
            {
              model: 'm-00032eaeec',
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              holderInstanceId: OTHER,
            },
          ],
          desktopSessionCounts: { premium: 1, unlimited: 0, nextExpiryAt: null },
        }
      }
      return { status: 'none' }
    },
  }
  const sm = new SessionManager({
    upstream: up,
    config: { session: { reAdmitOnExpire: true, reAdmitLeadSec: 60, freeModelReAdmitLeadSec: 60 }, limits: {} },
    accountKey: 'inventory-refresh',
  })
  await sm.refresh()
  const snap = sm.getSnapshot()
  assert.ok(
    snap?.inventory,
    '快照必须带 inventory（前端靠它显示会话清单）',
  )
  assert.equal(
    snap.inventory.purchases.length,
    1,
    `刷新后清单里应有 1 条（别的部署建的），got ${JSON.stringify(snap.inventory.purchases)}`,
  )
  assert.equal(
    snap.inventory.purchases[0].holderInstanceId,
    OTHER,
    '清单里必须如实带上占用者 instanceId（前端据此标"本机/其它部署"）',
  )
  assert.ok(snap.inventory.sessionCounts, '会话计数也要带出去')
}
