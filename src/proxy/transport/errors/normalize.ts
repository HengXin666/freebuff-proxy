/**
 * 上游错误回执的归一化 -- 见 normalizeUpstreamError 的 JSDoc.
 */

import {
  extractAccountBanError,
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
  safeText,
  UpstreamError,
} from '../../../upstream/client.ts'
import { parseRetryAfterMsHeader, shouldSwitchAccountOnError } from './errors.ts'
import { logger } from '../../../util/log.ts'

/**
 * 上游非 2xx 回执的归一化.
 *
 * 做三件事: 解析错误体 -> 把"因第三方客户端被封"的 403 归一成 banned 判据
 * -> 重算 errCode 并给出换号/冷却的判决. 重算那一步是必需的: 只改 parsedBody
 * 而留着旧 errCode 等于没改, shouldSwitchAccountOnError 与 markCooldown
 * 都按 errCode 分支.
 *
 * @param {object} ctx 依赖集合
 * @param {object} args 上游回执与本次请求的上下文
 * @returns {Promise<object>} 判决结果(含 switchAccount / gateCode / body)
 */
export async function normalizeUpstreamError(ctx: any, args: any) {
  const { upstreamRes, upstreamErrText, respHeaders, status, effectiveErrCode: errCodeIn } = args
  const text = upstreamErrText ?? (await safeText(upstreamRes))
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const retryAfterMs = parseRetryAfterMsHeader(respHeaders['retry-after'])
  const errCode =
    (parsed &&
    typeof parsed === 'object' &&
    (parsed.error?.code || parsed.error || parsed.code || parsed.status)) ||
    null
  const gateCode = extractGateError(parsed, status)
  // 账号封禁归一:上游把"因第三方客户端被封"写成 403
  // {"error":"account_suspended",...}(error 是字符串).不归一它就会以
  // 403 落进"4xx 客户端错误不换号"分支 ---- 每个被封的账号被反复复用,错误
  // 原样甩给下游,控制台也记不上 bannedAt(见 extractAccountBanError).
  // 归一后必须重算 errCode:下面的 shouldSwitchAccountOnError 与
  // markCooldown 都按 errCode 分支,只改 parsedBody 而留着旧 errCode 等于没改.
  const banCode = extractAccountBanError(parsed, status)
  if (banCode && parsed && typeof parsed === 'object') {
    parsed.error =
      parsed.error && typeof parsed.error === 'object'
        ? { ...parsed.error, code: banCode }
        : { code: banCode, message: parsed.error || parsed.message }
  }
  const effectiveErrCode = banCode || errCode
  const parsedBody = parsed || {
    error: { message: text, type: 'upstream_error' },
  }

  // free_mode_capacity_deferred: 免费模式瞬时容量排队(上游原话
  // "your request will be retried automatically").不是账号级故障:
  // 优先复用当前热 session 重试, 不冷却账号;若账号另有故障,外层仍会正常切号.
  if (
    effectiveErrCode === 'free_mode_capacity_deferred' ||
    gateCode === 'free_mode_capacity_deferred'
  ) {
    return {
      ok: false,
      wrote: false,
      recoverable: true,
      switchAccount: true,
      noCooldown: true,
      gateCode: 'free_mode_capacity_deferred',
      retryAfterMs,
      status,
      body: parsedBody,
      headers: respHeaders,
    }
  }
  // 可恢复 gate(session_expired/superseded/waiting_room 等):
  // 同账号 re-admit 一次即可恢复,不属于账号级故障,不冷却不换号.
  if (gateCode && isSessionRecoverableGate(gateCode)) {
    return {
      ok: false,
      wrote: false,
      recoverable: true,
      switchAccount: false,
      gateCode,
      retryAfterMs,
      status,
      body: parsedBody,
      headers: respHeaders,
    }
  }
  // 账号侧故障(429 限流 / 5xx / 403 账号级封禁):冷却当前账号并换号重试.
  // 4xx 客户端错误(400/401/404/422 等)不换号.
  const switchAccount = shouldSwitchAccountOnError(status, effectiveErrCode)
  if (switchAccount) {
    return {
      ok: false,
      wrote: false,
      recoverable: true,
      switchAccount: true,
      gateCode:
        typeof effectiveErrCode === 'string'
          ? effectiveErrCode
          : `http_${status}`,
      retryAfterMs,
      status,
      body: parsedBody,
      headers: respHeaders,
    }
  }
  return {
    ok: false,
    wrote: false,
    recoverable: false,
    switchAccount: false,
    gateCode,
    status,
    body: parsed || text,
    headers: respHeaders,
  }
}
