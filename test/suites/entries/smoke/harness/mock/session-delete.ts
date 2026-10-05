/**

 * mock: DELETE /api/v1/freebuff/session
 *
 * 验证 DELETE 必须带 x-freebuff-instance-id, 以及退款挂起(freebucksRefundPending)与失败不丢句柄.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../smoke/state.ts'
import { jsonRes } from '../helpers.ts'

/** 处理 DELETE /session.
 * @param {any} headers
 * @returns {any}
 */
export function handleSessionDelete(headers) {
  state.sessionDeletes++
  if (state.deleteFailuresLeft > 0) {
    state.deleteFailuresLeft--
    return jsonRes({ error: 'internal_error' }, 500)
  }
  const instanceId =
    headers['x-freebuff-instance-id'] ||
    headers['X-Freebuff-Instance-Id'] ||
    ''
  state.deleteInstanceIds.push(instanceId)
  // 上游 2026-09 行为:DELETE 不带 x-freebuff-instance-id 会 400
  // instance_required,会话删不掉,退款也拿不到.
  if (state.requireDeleteInstance && !instanceId) {
    return jsonRes({ error: 'instance_required' }, 400)
  }
  return jsonRes({
    status: 'ended',
    ...(state.mockRefundPending ? { freebucksRefundPending: true } : {}),
    ...(state.mockRefundPending ? {} : { freebucksRefund: state.mockRefund }),
    ...(state.mockFreebucks ? { freebucks: state.mockFreebucks } : {}),
  })
}
