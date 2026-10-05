/**

 * mock: POST /api/v1/freebuff/session/admission
 *
 * 槽位被占 / 限流 / 地理封锁 / 档位 / claim_released 五种形态集中在一处, 便于与真机日志对照.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../smoke/state.ts'
import { jsonRes } from '../helpers.ts'

/** 槽位被别的部署占着: 只认带占用者 id 的接管(不带即 purchase_capacity). */
function paidTakeoverReply(headers) {
  const tk =
    headers['x-freebuff-takeover-instance-id'] ||
    headers['X-Freebuff-Takeover-Instance-Id'] ||
    null
  if (tk !== state.mockPaidTakeover.holderInstanceId) {
    return jsonRes({
      status: 'purchase_capacity',
      currentInstanceId: state.mockPaidTakeover.holderInstanceId,
      slotLimit: 1,
    })
  }
  return jsonRes({
    status: 'active',
    accessTier: 'limited',
    instanceId:
      headers['x-freebuff-instance-id'] ||
      headers['X-Freebuff-Instance-Id'] ||
      'ours',
    model: state.mockPaidTakeover.model,
    admittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + state.sessionExpiryMs).toISOString(),
    remainingMs: state.sessionExpiryMs,
  })
}

/** rate_limit_a: token-a 在 admit 层直接 429. */
function rateLimitedReply() {
  return jsonRes(
    {
      status: 'rate_limited',
      message: 'quota',
      retryAfterMs: 60_000,
    },
    429,
  )
}

/** purchase_claim_released 的两段式: 旧 instanceId 回该码, 换新 id 后放行. */
function claimReleasedReply(headers, model) {
  /**
   * - purchase_claim_released 的两段式 mock:第一次用旧 instanceId
   * - 请求时回这个码(模拟"购买声明已被作废"),换新 instanceId 后放行.
   *
   * 这样测的是官方语义(orchestrator.js:208166-208176):
   * 收到该码 → DELETE 作废 claim → 换全新 instanceId → 重试一次
   * 若实现没有换 ID(旧行为:当"槽位忙"跳过),第二次仍带旧 ID →
   * - mock 继续返回该码 → 断言 sessionPosts 与最终状态会红.
   */
  const inst =
    headers['x-freebuff-instance-id'] ||
    headers['X-Freebuff-Instance-Id'] ||
    null
  if (inst && state.claimReleasedSeen.has(inst)) {
    // 该 id 已被作废过 → 换新 id 后走正常 active
    return jsonRes({
      status: 'active',
      accessTier: 'limited',
      instanceId: inst,
      model: 'm-00032eaeec',
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + state.sessionExpiryMs).toISOString(),
      remainingMs: state.sessionExpiryMs,
      countryCode: 'US',
    })
  }
  if (inst) state.claimReleasedSeen.add(inst)
  return jsonRes({ status: 'purchase_claim_released', model }, 409)
}

/** 地理封锁: 上游把它夹在 200 回执里(status 仍是 active), 随后 chat 一律 503. */
function countryBlockReply(model) {
  return jsonRes({
    status: 'active',
    instanceId: `inst-${state.sessionPosts}`,
    model,
    admittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + state.sessionExpiryMs).toISOString(),
    remainingMs: state.sessionExpiryMs,
    accessTier: 'limited',
    countryCode: 'JP',
    countryBlockReason: 'country_not_allowed',
  })
}

/** limited 档位(VPN / 非 allowlist 国家): 可用, 不是封锁. */
function limitedTierReply(model) {
  return jsonRes({
    status: 'active',
    instanceId: `inst-${state.sessionPosts}`,
    model,
    admittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + state.sessionExpiryMs).toISOString(),
    remainingMs: state.sessionExpiryMs,
    accessTier: 'limited',
    countryCode: 'JP',
    countryBlockReason: 'anonymous_network',
    ipPrivacySignals: ['vpn', 'hosting', 'anonymous'],
  })
}

/** 默认 active 回执(额度块 + 可选 Freebucks 计量块). */
function activeAdmission(model) {
  const rateLimit = {
    model,
    entitlementBreakdown: { base: 6, referral: 0, streak: 0 },
    limit: 6,
    period: 'pacific_day',
    resetTimeZone: 'America/Los_Angeles',
    resetAt: '2026-08-09T07:00:00.000Z',
    windowHours: 24,
    recentCount: 1,
  }
  return jsonRes({
    status: 'active',
    instanceId: `inst-${state.sessionPosts}`,
    model,
    admittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + state.sessionExpiryMs).toISOString(),
    remainingMs: state.sessionExpiryMs,
    accessTier: 'full',
    rateLimit,
    rateLimitsByModel: { [model]: rateLimit },
    /**
     * - waiting_room_once:admit 回执带扣费后的余额(25 - 15 = 10).
     *
     * 这是真机的真实形态(远程日志 2026-10-04T18:52:34Z):admit 200 当场扣
     * 整小时单价 15,回执里余额剩 10;紧接着 chat 回 428.此时若把 428 排在
     * - 额度闸门之后,freebucksFor() 会判"10 < 15 买不起"→ 续用被拦死.
     * - 测试必须复现这个扣费后的余额,否则闸门不会命中,断言变成假绿.
     */
    ...(state.mockFreebucks
      ? {
          freebucks:
            state.mockMode === 'waiting_room_once'
              ? {
                  ...state.mockFreebucks,
                  balance: 10,
                  daily: { ...state.mockFreebucks.daily, spent: 15, remaining: 10 },
                }
              : state.mockFreebucks,
        }
      : {}),
  })
}

/** 处理 POST /session/admission. 分支顺序与原实现逐行一致.
 * @param {any} headers
 * @returns {any}
 */
export function handleAdmissionPost(headers) {
  state.sessionPosts++
  const model =
    headers['x-freebuff-model'] ||
    headers['X-Freebuff-Model'] ||
    'deepseek/deepseek-v4-flash'
  const auth =
    headers.Authorization ||
    headers.authorization ||
    headers['x-codebuff-api-key'] ||
    ''
  if (state.mockPaidTakeover) return paidTakeoverReply(headers)
  if (state.mockMode === 'rate_limit_a' && String(auth).includes('token-a')) {
    return rateLimitedReply()
  }
  if (state.mockMode === 'claim_released') return claimReleasedReply(headers, model)
  if (state.mockMode === 'country_block') return countryBlockReply(model)
  if (state.mockMode === 'limited_tier') return limitedTierReply(model)
  return activeAdmission(model)
}
