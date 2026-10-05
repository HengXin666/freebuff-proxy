/**
 * admission 的三种"失败回执"恢复路径: model_locked, 槽位接管, claim 轮换.
 *
 * 从 steps.ts 按职责切出. 这三支的共同点是"回执不是 active, 但也不是终态",
 * 各自有官方对齐的重试动作; 与"正常路径怎么拿会话"分开更好审查.
 */
import { newRawInstanceId } from '../../upstream/official-fingerprint.js'
import { logger } from '../../util/log.ts'
import { activateSession } from './steps.ts'

/**
 * model_locked: 结束当前会话并重试一次请求的模型.
 * @param {any} this 会话实例
 * @param {any} body model_locked 回执
 * @param {string} model 请求模型
 * @returns {Promise<any>} 本地会话句柄
 */
export async function handleModelLocked(
  this: any,
  body: any,
  model: string,
): Promise<any> {
  logger.info('model_locked; releasing and re-admitting', {
    currentModel: body.currentModel,
    requestedModel: body.requestedModel || model,
  })
  await this._releaseUnlocked()
  const again = await this.upstream.freebuffSession('POST', { model })
  if (again?.status === 'active' && again.instanceId) {
    return activateSession.call(this, again, model)
  }
  throw this._terminalSessionError(again, model)
}

/**
 * 槽位被占时用 x-freebuff-takeover-instance-id 接管重试(官方行为).
 *
 * 官方 orchestrator.js:208152-208155: 上游回执会告诉我们谁占着槽位
 * (currentInstanceId), 官方据此显式"接管"(带 takeover 头重发一次).
 * 我们此前完全没有这一步 -- takeover 逻辑只存在于 cli-bridge 的 admit(),
 * 而主服务的 admission 走另一条路, 从不带该头. 后果(实测 2026-10-04):
 * 账号直连上游 status: none, balance 15, 但每个请求都回 purchase_capacity.
 *
 * 只重试一次(与官方一致), 避免与占用者互相抢夺.
 * @param {any} this 会话实例
 * @param {any} body 回执
 * @param {string} model 请求模型
 * @param {string} claimId 本进程复用的 instanceId
 * @returns {Promise<{session: any, body: any}>} 成功时 session 非空, 否则把新回执带回
 */
export async function handleSlotTaken(
  this: any,
  body: any,
  model: string,
  claimId: string,
): Promise<{ session: any, body: any }> {
  const slotBusy =
    body &&
    (body.status === 'purchase_capacity' ||
      body.status === 'purchase_in_use' ||
      body.status === 'premium_slot_taken')
  const holder = typeof body?.currentInstanceId === 'string' ? body.currentInstanceId : ''
  if (!slotBusy || !holder || holder === claimId) return { session: null, body }
  logger.warn('session slot held by another instance; attempting takeover', {
    model,
    holderInstanceId: holder,
    ourInstanceId: claimId,
    slotStatus: body.status,
  })
  try {
    const took = await this.upstream.freebuffSession('POST', {
      model,
      instanceId: claimId,
      takeoverInstanceId: holder,
    })
    if (took?.status === 'active' && took.instanceId) {
      const session = activateSession.call(this, took, model)
      logger.info('took over the held slot', {
        model,
        instanceId: took.instanceId,
        expiresAt: took.expiresAt,
      })
      this._sendHoldHeartbeat(took.instanceId)
      return { session, body: took }
    }
    logger.warn('takeover did not produce an active session', {
      model,
      status: took?.status ?? null,
    })
    return { session: null, body: took || body }
  } catch (err: unknown) {
    logger.warn('takeover attempt failed', {
      model,
      error: err instanceof Error ? err.message : String(err),
    })
    return { session: null, body }
  }
}

/**
 * purchase_claim_released: 必须换一个全新的 instanceId 再试一次.
 *
 * 这是官方客户端的确切行为(desktop 0.0.158 解包 orchestrator.js:208166-208176):
 * 先 recovery.finish 结束失败尝试, 再 releasePurchaseClaim(就是
 * deleteSession(instanceId) -- 删的是"已被作废的那条 claim"), 然后
 * instanceHint = crypto.randomUUID() 换全新 UUID 重试一次(rotated 只重试一次).
 *
 * 我们此前把它归进 SLOT_BUSY_CODES 当"槽位忙, 跳过", 于是永远卡在同一个
 * 已作废的 instanceId 上: 每个模型都返回同样的错, 直到 expiresAt 到期才恢复
 * (实测日志 11:29:07 / 11:29:44 / 11:29:56 连续三个模型全部
 * purchase_claim_released, 其中 m-22ff70c712 单价 0 也失败 -- 证明卡的不是钱,
 * 是那条 claim).
 * @param {any} this 会话实例
 * @param {any} body purchase_claim_released 回执
 * @param {string} model 请求模型
 * @returns {Promise<any>} 本地会话句柄
 */
export async function handleClaimReleased(
  this: any,
  body: any,
  model: string,
): Promise<any> {
  const staleId = this.instanceId
  logger.warn('purchase_claim_released; rotating instance id and retrying once', {
    model,
    staleInstanceId: staleId,
  })
  // 1 删掉那条已被作废的 claim(官方 releasePurchaseClaim 同语义).
  //   这一步不会动到任何仍在生效的会话 -- 它本来就已经被上游作废了.
  await this.upstream.freebuffSession('DELETE', { instanceId: staleId }).catch(() => null)
  // 2 换一个全新 instanceId(官方 crypto.randomUUID 同语义)
  this.instanceId = newRawInstanceId()
  this.session = { status: 'none' }
  this._notifySessionChange()
  // 3 用新 id 重新 admission(只这一次)
  const retry = await this.upstream
    .freebuffSession('POST', { model, instanceId: this.instanceId })
    .catch(() => null)
  if (retry?.status === 'active' && retry.instanceId) {
    const session = activateSession.call(this, retry, model)
    logger.info('re-admitted after claim rotation', {
      model,
      instanceId: retry.instanceId,
      expiresAt: retry.expiresAt,
    })
    return session
  }
  logger.warn('claim rotation did not produce an active session', {
    model,
    status: retry?.status ?? null,
  })
  throw this._terminalSessionError(retry || body, model)
}
