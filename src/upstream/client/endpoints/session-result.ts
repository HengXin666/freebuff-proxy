/**
 * 会话回执归一:把 403/409/429/401 的语义差异落到明确分支.
 *
 * 判据与出处放在同一处: 地理封锁夹在 200 里, 403 才算 terminal, 401 单独归一.
 */
import { logger } from '../../../util/log.ts'
import { UpstreamError, isTerminalCountryBlock } from '../errors/index.ts'

/** 一次 session 回执的归一输入. */
interface SessionResultInput {
  res: any
  body: any
  method: string
  retryAfterMs: number | undefined
}

/**
 * 判定 409 / 429 这两类"可原样透传"的槽位与限流码.
 *
 * 不归一化就会落进通用错误分支,被上层当账号故障处理:409 的槽位类只是
 * "等槽位空出即可",429 的限流类换号才可能成功.
 *
 * 409 全集来自真机抓包(二进制 PU$ 分支).purchase_capacity 语义:
 * 该账号的付费槽位已被占(一个账号 slotLimit:1),回执带 currentInstanceId /
 * nextExpiryAt 指明何时空出.
 *
 * @param {number} status HTTP 状态码
 * @param {any} body 上游回执体
 * @returns {boolean} true 表示原样透传该回执体
 */
function isPassthroughStatus(status: number, body: any): boolean {
  if (!body) return false
  if (status === 409) {
    return (
      body.status === 'model_locked' ||
      body.status === 'model_unavailable' ||
      body.status === 'premium_slot_taken' ||
      body.status === 'purchase_claim_released' ||
      body.status === 'purchase_in_use' ||
      body.status === 'purchase_capacity' ||
      body.status === 'first_tab_discount_changed' ||
      body.status === 'consent_required'
    )
  }
  if (status === 429) {
    return (
      body.status === 'rate_limited' ||
      body.status === 'spend_limited' ||
      body.status === 'ip_capped' ||
      body.status === 'free_mode_rate_limited'
    )
  }
  return false
}

/**
 * 归一化一次 session 回执.
 *
 * @param {{ res: Response, body: any, method: string, retryAfterMs: number | undefined }} input 回执
 * @returns {any} 归一后的回执体
 * @throws {UpstreamError} 401 / 其余非 2xx 时
 */
export function normalizeSessionResult(input: SessionResultInput): any {
  const { res, body, method, retryAfterMs } = input
  if (
    res.status === 403 &&
    body &&
    (body.status === 'country_blocked' || body.status === 'banned')
  ) {
    return body
  }
  // 地理封锁夹在 200 回执里:会话照样建立(status: "active",额度照扣),
  // 但随后 chat 一律 503 且不带业务体.不归一化就只能归成 http_503,
  // 表现为"所有账号轮流冷却换号",而每次 admit 都买断一小时 Freebucks.
  // status: 'active' 时绝不归一: 官方 CLI 在完全相同的出口下, 服务端返回的
  // 就是 active + 可用 instanceId, countryBlockReason 是说明性字段.
  // 只看 HTTP 403 才当 terminal.
  if (
    res.status === 403 &&
    body &&
    body.status !== 'active' &&
    isTerminalCountryBlock(body.countryBlockReason)
  ) {
    logger.warn('upstream reported terminal country block', {
      countryCode: body.countryCode ?? null,
      reason: body.countryBlockReason,
      instanceId: body.instanceId ?? null,
    })
    // 保留原回执的会话字段(instanceId / expiresAt / model ...):
    // 上游是照常建立会话并照常扣费的(一次 admit = 买断一整小时), 只是随后
    // chat 会被拒. 换掉整个 body 会让那条已付费的会话无法寻址: DELETE 不掉
    // 也追不回钱. 所以是"叠加封锁标记"而非"替换回执".
    return {
      ...body,
      status: 'country_blocked',
      countryCode: body.countryCode ?? null,
      countryBlockReason: body.countryBlockReason,
      message:
        'Upstream blocked this egress country (' +
        (body.countryCode ?? 'unknown') +
        '): ' +
        body.countryBlockReason,
    }
  }
  // limited 档位(VPN/代理/非 allowlist 国家):可用,但模型集合变小,
  // Freebucks 从 25 降到 20.记一条 warn 让控制台[日志]页能看到, 不阻断.
  if (body && body.countryBlockReason && !isTerminalCountryBlock(body.countryBlockReason)) {
    logger.warn('session admitted on limited tier (not blocked)', {
      countryCode: body.countryCode ?? null,
      reason: body.countryBlockReason,
      ipPrivacySignals: body.ipPrivacySignals ?? null,
      accessTier: body.accessTier ?? null,
    })
  }
  if (isPassthroughStatus(res.status, body)) return body
  if (res.status === 401) throw unauthorizedError(body, method, retryAfterMs)
  if (!res.ok) {
    throw new UpstreamError(`freebuff session ${method} failed: ${res.status}`, {
      status: res.status,
      code: body?.error || body?.status,
      body,
      retryAfterMs,
    })
  }
  return body
}

/**
 * 构造 401 的归一错误:401 = 上游不认这个 token,与限流/风控/封禁是不同的
 * 处置路径.
 *
 * 三种形态:
 *   - 有效 token -> 200 status:none, accessTier: limited, freebucks:{...}
 *   - 无效 token -> 401 error:unauthorized, message: Invalid API key
 *   - 无 token    -> 401 error:unauthorized, message: Missing or invalid ...
 *
 * 走通用 !res.ok 分支会只拿 code = unauthorized, 控制台按字符串包含判断会把
 * 网络/出口类 401 也判成凭证失效; 所以 401 单独归一成 auth_unauthorized.
 * 见 .agents/notes/implemented/bug-fix/2026-10-04-credential-invalid-false-positive-chain.md
 * @param {any} body 回执体
 * @param {string} method 方法(仅用于文案)
 * @param {number | undefined} retryAfterMs 重试提示
 * @returns {UpstreamError} 归一后的错误
 */
function unauthorizedError(body: any, method: string, retryAfterMs: number | undefined): UpstreamError {
  return new UpstreamError(
    body?.message || `freebuff session ${method} rejected: 401 unauthorized`,
    { status: 401, code: 'auth_unauthorized', body, retryAfterMs },
  )
}
