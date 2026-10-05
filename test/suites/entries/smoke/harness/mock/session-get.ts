/**

 * mock: GET /api/v1/freebuff/session
 *
 * 回执里带上游会话清单(desktopPurchases / desktopSessionCounts), 用来验证余额不足时仍复用已付费会话.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../smoke/state.ts'
import { jsonRes } from '../helpers.ts'

/** 处理 GET /session.
 * @param {any} headers
 * @returns {any}
 */
export function handleSessionGet(headers) {
  /**
   * - 真实链路复现:上游清单里有别的部署占着一条已付费会话.
   *
   * 形态刻意与真机对齐:
   * - - 回执 status: none(本部署没有自己的会话);
   * - - desktopPurchases[].model 是上游 legacy id 形式(不是目录 key)----
   * 归一映射不生效时它匹配不上请求的模型,清单形同不存在;
   * - - Freebucks 是买不起(balance 0 / 每日池 0/25),逼出额度闸门.
   */
  if (state.mockPaidTakeover) {
    return jsonRes({
      status: 'none',
      accessTier: 'limited',
      freebucks: state.mockPaidTakeover.freebucks,
      ...(state.mockPaidTakeover.listed
        ? {
            desktopPurchases: [
              {
                model: state.mockPaidTakeover.model,
                expiresAt: new Date(Date.now() + state.sessionExpiryMs).toISOString(),
                holderInstanceId: state.mockPaidTakeover.holderInstanceId,
              },
            ],
            desktopSessionCounts: {
              premium: 0,
              unlimited: 0,
              nextExpiryAt: null,
            },
          }
        : {}),
    })
  }
  // 官方建会话路径:GET + cli: claim + multi-session 头 → 直接 active.
  // 官方 CLI 0.2.6 全程只走这条路(18 次 GET + 1 次 DELETE /attempt),
  // 从不打 /admission.见
  // .agents/notes/implemented/bug-fix/2026-10-01-cli-get-session-path.md
  if (state.mockMode === 'get_claim_admit') {
    const inst =
      headers['x-freebuff-instance-id'] ||
      headers['X-Freebuff-Instance-Id'] ||
      'cli:mock-claim'
    return jsonRes({
      status: 'active',
      accessTier: 'limited',
      instanceId: inst,
      // 服务端指派的 model(目录 key),不是客户端请求的模型名.
      // chat 必须回用这个值: 回用错值会命中上游的 session_model_mismatch 拒绝.
      model: 'm-00032eaeec',
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + state.sessionExpiryMs).toISOString(),
      remainingMs: state.sessionExpiryMs,
      countryCode: 'JP',
      countryBlockReason: 'country_not_allowed',
      verificationReason: 'region_locked',
    })
  }
  return jsonRes({
    status: 'none',
    accessTier: 'full',
    ...(state.mockFreebucks ? { freebucks: state.mockFreebucks } : {}),
  })
}
