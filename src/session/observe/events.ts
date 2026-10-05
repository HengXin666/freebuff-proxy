/**
 * 会话现场的写入与上报: _apply(回执 -> 本地句柄)与四类回调.
 *
 * 从 session-manager.js 的 _apply / _notifySessionChange / _emitSessionEvent /
 * _emitRefund / _notifyStateChange 切出.
 *
 * _apply 是所有路径(admit / refresh / probe)唯一改写本地会话的入口, 因此
 * 它与"通知上层落盘"的四个回调放在一起, 便于审查"句柄会不会被谁抹掉".
 */
import { logger } from '../../util/log.ts'
import { extractFreebucks, extractQuota } from '../inventory.ts'

/**
 * 用上游回执刷新本地会话现场, 并落盘句柄 / 账号账目.
 *
 * 上游的会话清单也在这里解析: 上游一次 admit = 买断一小时, 槽位 slotLimit: 1.
 * 谁占着槽位只在上游那里 -- 本地账本(sessions.json)只记自己创建的会话,
 * 分布式部署下彼此看不见: 我在本地建了一条会话, 远程读不到 -> 远程拿同一账号
 * 请求就撞 purchase_capacity, 而本地面板显示 status: none, 两边各说各话.
 *
 * 上游其实把答案直接给了我们(GET /session 回执, 实测字段):
 *   desktopSessionCounts: {premium, unlimited, nextExpiryAt}
 *   desktopPurchases: [{model, expiresAt, holderInstanceId}]
 * 官方据此实现 knownHolder(model), 我们据此实现 holderFor(model).
 * @param {any} this 会话实例
 * @param {any} body 上游回执
 * @returns {void}
 */
export function _apply(this: any, body: any): void {
  if (!body || typeof body !== 'object') {
    this.session = { status: 'none' }
    return
  }
  const prev = this.session
  // 旧的 handle 还没删掉(DELETE 一直失败)而现在要换成新会话: 不能就这么
  // 覆盖丢掉 instanceId -- 把它作为[待清理]交给上层落盘持久化, 之后仍会
  // 继续尝试 DELETE(否则它就成了无法寻址的孤儿, 一直占着上游会话槽位).
  if (
    this._releasePending &&
    this.hasLiveSlot(prev) &&
    prev.instanceId !== body.instanceId
  ) {
    this._emitSessionEvent({
      type: 'orphan',
      key: this.accountKey,
      instanceId: prev.instanceId,
      model: prev.model ?? null,
      admittedAt: prev.admittedAt ?? null,
      expiresAt: prev.expiresAt ?? null,
    })
    this._releasePending = false
  }
  this.session = {
    status: body.status,
    instanceId: body.instanceId,
    model: body.model,
    admittedAt: body.admittedAt,
    expiresAt: body.expiresAt,
    remainingMs: body.remainingMs,
    accessTier: body.accessTier,
    raw: body,
  }
  const quota = extractQuota(body)
  if (quota) this.quota = quota
  const freebucks = extractFreebucks(body)
  if (freebucks) this.freebucks = freebucks
  this._absorbInventory(body)
  if (quota || freebucks) this._notifyStateChange()
  // admit 可能发生在没有任何在途请求时(选号阶段就 admit, 随后才拿 chat
  // 锁): 这里兜底起空闲计时, 否则会话会一直挂到过期.
  if (this._inFlight === 0) this._armIdleRelease()
  // 句柄落盘: 进程退出/换容器后仍能凭 instanceId 去 DELETE 释放上游会话槽位.
  this._notifySessionChange()
}

/**
 * 通知上层把会话句柄落盘(/data/sessions.json). 进程退出/换容器后仍能
 * 凭 instanceId 去 DELETE 退款, 而不是留下无法寻址的孤儿会话.
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _notifySessionChange(this: any): void {
  const s = this.session
  if (!this.hasLiveSlot(s)) {
    this._emitSessionEvent({ type: 'clear', key: this.accountKey })
    return
  }
  this._emitSessionEvent({
    type: 'track',
    key: this.accountKey,
    instanceId: s.instanceId,
    model: s.model,
    admittedAt: s.admittedAt ?? null,
    expiresAt: s.expiresAt ?? null,
  })
}

/**
 * 上报会话事件(track / orphan / drop / clear).
 * @param {any} this 会话实例
 * @param {any} entry 事件负载
 * @returns {void}
 */
export function _emitSessionEvent(this: any, entry: any): void {
  if (this._onSessionChange) {
    try {
      this._onSessionChange(entry)
    } catch (err) {
      logger.warn('session event callback failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * 上报一笔已结算的退款(上层记进账号账本的退款流水).
 * @param {any} this 会话实例
 * @param {any} entry 退款流水
 * @returns {void}
 */
export function _emitRefund(this: any, entry: any): void {
  if (!this._onStateChange) return
  try {
    this._onStateChange({ refund: entry })
  } catch (err) {
    logger.warn('refund callback failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 上报账号账目变化(freebucks / quota / lastProbe) -- 上层据此落盘.
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _notifyStateChange(this: any): void {
  if (!this._onStateChange) return
  try {
    this._onStateChange({
      freebucks: this.freebucks,
      quota: this.quota,
      lastProbe: this.lastProbe,
    })
  } catch (err) {
    logger.warn('state change callback failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
