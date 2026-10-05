/**
 * admission 的编排: 把 steps.ts 的各步串成"一次 admit".
 *
 * 这里只做顺序与提前返回, 每一步的实现与它自己的依据都在 steps.ts.
 *
 * 顺序不可随意调换: 每一步都有上游回执依据.
 *   结清待结束会话 -> GET claim -> POST admission -> [补一次 POST]
 *   -> 终态封锁 / active -> model_locked -> 槽位接管 -> claim 轮换
 */
import { UpstreamError } from '../../upstream/client.ts'
import { logger } from '../../util/log.ts'
import {
  activateSession,
  clearPendingEnd,
  failCountryBlocked,
  isTerminalBlock,
  postAdmission,
  probeClaim,
} from './steps.ts'
import {
  handleClaimReleased,
  handleModelLocked,
  handleSlotTaken,
} from './recover.ts'

/**
 * 拿到一个绑定了 model 的活跃会话(必须在 withLock 内调用).
 *
 * @param {any} this 会话实例
 * @param {string} model 上游模型标识
 * @param {{ forceReleaseLocked?: boolean }} [opts] forceReleaseLocked=true 先释放持有槽位
 * @returns {Promise<any>} 本地会话句柄
 */
export async function _admitUnlocked(
  this: any,
  model: string,
  // 用命名参数而非内联解构: check-notes 按参数文本逐字比对 @param,
  // 解构模式无法表达. 全部调用点都传 0 或 1 个参数, 两种写法行为一致.
  opts: { forceReleaseLocked?: boolean } = {},
): Promise<any> {
  if (opts.forceReleaseLocked) {
    await this._releaseUnlocked()
  }
  await clearPendingEnd.call(this, model)
  const claimId = this.instanceId
  logger.info('admitting freebuff session', { model, claimId })
  const body = await resolveAdmission.call(this, model, claimId)
  return dispatchAdmission.call(this, body, model, claimId)
}

/**
 * 取回执: 先走官方路径(GET + claim), 失败且没有可用会话时回落 POST.
 * @param {any} this 会话实例
 * @param {string} model 请求模型
 * @param {string} claimId 本进程复用的 instanceId
 * @returns {Promise<any>} 上游回执; 可能为 null
 */
async function resolveAdmission(this: any, model: string, claimId: string): Promise<any> {
  let body = await probeClaim.call(this, claimId)
  // GET 没给出可用会话: 再 POST 一次(带 model 作为 hint).
  //
  // 官方行为(真机抓包): 全程 18 次 GET, 零次 POST, 会话最终变成 active,
  // 说明 GET 本身就是建会话路径. 回落 POST 的形态是服务端会拒的路径
  // (country_not_allowed).
  if (!body || body.status === 'none') {
    body = await postAdmission.call(this, model, claimId)
  }
  // 仍拿不到: 最后再试一次 POST(等价重复, 作为老部署兜底).
  //
  // 真机抓包确认官方建会话只走一次 POST /session/admission; 上面那次 POST
  // 失败后这里不会再成功, 保留一层与官方 session_admission_unavailable
  // 容错语义一致的兜底.
  if (!body || body.status === 'none') {
    logger.warn('admission produced no session; retrying POST once', { model, claimId })
    body = await this.upstream.freebuffSession('POST', { model, instanceId: claimId })
  }
  return body
}

/**
 * 按回执终态分派.
 *
 * status: 'active' 优先于 countryBlockReason: countryBlockReason 是说明性字段
 * (告诉客户端模型集变小了), 不是拒绝信号. 只有没有 instanceId 的 terminal
 * 封锁才该抛(那才是真拒绝).
 * @param {any} this 会话实例
 * @param {any} body 上游回执
 * @param {string} model 请求模型
 * @param {string} claimId 本进程复用的 instanceId
 * @returns {Promise<any>} 本地会话句柄
 */
async function dispatchAdmission(
  this: any,
  body: any,
  model: string,
  claimId: string,
): Promise<any> {
  if (isTerminalBlock(body)) {
    failCountryBlocked.call(this, body, model)
  }
  if (body?.status === 'active' && body.instanceId) {
    return activateSession.call(this, body, model)
  }
  if (body?.status === 'model_locked') {
    return handleModelLocked.call(this, body, model)
  }
  const taken = await handleSlotTaken.call(this, body, model, claimId)
  if (taken.session) return taken.session
  if (body?.status === 'purchase_claim_released') {
    return handleClaimReleased.call(this, body, model)
  }
  throw this._terminalSessionError(taken.body, model)
}

/**
 * 把上游终态回执翻成带 HTTP 语义的 UpstreamError.
 *
 * 地理封锁是出口属性, 不是账号属性: 所有账号共享同一出口, 换号只会把每个
 * 账号的额度依次买断(一次 admit = 一整小时 Freebucks)却拿不到答案.
 * 标记 fatal 后调度层立即终止选号并把这条说明交给用户.
 * @param {any} this 会话实例
 * @param {any} body 上游回执
 * @param {string} model 请求模型
 * @returns {import('../../upstream/client.ts').UpstreamError} 归一后的错误
 */
export function _terminalSessionError(this: any, body: any, model: string): any {
  const statusMap: Record<string, number> = {
    rate_limited: 429,
    spend_limited: 429,
    ip_capped: 429,
    country_blocked: 403,
    banned: 403,
    model_unavailable: 409,
    premium_slot_taken: 409,
    superseded: 409,
    none: 503,
  }
  const st = body?.status || 'admit_failed'
  return new UpstreamError(
    `freebuff session admit failed: ${st}` +
      (body?.message ? ` -- ${body.message}` : ''),
    {
      status: statusMap[st] || 502,
      code: st,
      body: { ...body, requestedModel: model },
      retryAfterMs: body?.retryAfterMs,
      // 见上方说明: 出口属性, 换号无效.
      fatal: st === 'country_blocked',
    },
  )
}
