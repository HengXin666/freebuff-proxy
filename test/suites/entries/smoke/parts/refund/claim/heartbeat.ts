/**
 * refund: 心跳与结算
 *
 * syncHeartbeatTimer 与结算未完成.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { SessionManager } from '../../../../../../../src/session-manager.ts'
import assert from 'node:assert/strict'

/* ================================================================
   持有心跳:admission 后必须立刻发一次(官方行为),且轮询走心跳形态
   ================================================================ */
{
  /**
   * 官方真值(orchestrator.js:208918-208957 的 syncHeartbeatTimer +
   * 207945-207957 的 getSession(auth, instanceId, heartbeat=true)):
   * - - admission 成功后立刻发一次心跳,之后每 45 秒一次;
   * - - 形态 = GET /session + x-freebuff-instance-id + x-freebuff-heartbeat: 1,
   * - 且不带时区(...!heartbeat ? freebuffTimeZoneHeaders() : {}).
   *
   * 抓包实证: admission(line 8)→ 首个心跳(line 17)间隔 20.5 秒.
   * 缺心跳时上游会认为这条会话无人持有.
   *
   * - 反向探针:删掉 _sendHoldHeartbeat(...) 调用后本用例必须变红.
   */
  const calls = []
  const up = {
    freebuffSession: async (method, opts = {}) => {
      calls.push({ method, ...opts })
      if (method === 'POST') {
        return {
          status: 'active',
          instanceId: 'inst-heartbeat',
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
    accountKey: 'heartbeat-case',
  })
  await sm.ensureSession('m-00032eaeec')
  // 心跳是 fire-and-forget,给它一个微任务窗口
  await new Promise((r) => setTimeout(r, 50))
  const beats = calls.filter((c) => c.method === 'GET' && c.heartbeat === true)
  assert.ok(
    beats.length >= 1,
    `admission 成功后必须立刻发一次持有心跳，got ${JSON.stringify(calls.map((c) => c.method))}`,
  )
  assert.equal(
    beats[0].instanceId,
    'inst-heartbeat',
    '心跳必须带**该会话的** instanceId（否则上游无从知道谁在持有）',
  )

  // 轮询也必须走心跳形态(官方保活)
  calls.length = 0
  await sm.refresh({ heartbeat: true })
  assert.ok(
    calls.some((c) => c.method === 'GET' && c.heartbeat === true && c.instanceId === 'inst-heartbeat'),
    `轮询必须走持有心跳形态，got ${JSON.stringify(calls)}`,
  )
  // 普通刷新(控制台[检测])不是心跳:要能拿回额度/单价
  calls.length = 0
  await sm.refresh()
  assert.ok(
    calls.some((c) => c.method === 'GET' && c.heartbeat !== true),
    '控制台普通刷新不得被心跳形态替代（它要拿额度/单价）',
  )
}
