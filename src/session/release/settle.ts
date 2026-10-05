/**
 * 释放的结算后处理: 记退款流水, 挂起待结算, 落账, 摘 orphan.
 *
 * 从 release.ts 按职责切出. 这几个函数共同决定"钱记成什么状态",
 * 因此与"怎么发 DELETE"分开审查更安全.
 */
import { logger } from '../../util/log.ts'
import { MS } from '../../shared/constants.ts'
import { extractFreebucks, round2 } from '../inventory.ts'

/**
 * 把一笔已到终态的退款记进账本.
 *
 * expected 是"按实际占用时长应付的退款"(单价 x 未用满的小时数): 上游把结算挂
 * 在整点/5 的倍数上, expected 与 refund 的差就是需要解释的那部分. expectedUnits
 * 是 units 口径的应退(上游有 0.1 小时最小时长下限): 两本账的应退是两个不同的
 * 数, 混在一起会让"Freebucks 侧为何长期 pending"这个未结问题彻底隐身.
 * @param {any} self 会话实例
 * @param {string} instanceId 目标会话实例 id
 * @param {string | null | undefined} model 该会话绑定的模型
 * @param {any} body 终态回执(仅用于对账留痕)
 * @param {number | null} refund 上游给出的退款额
 * @returns {void}
 */
export function recordSettledRefund(
  self: any,
  instanceId: string,
  model: string | null | undefined,
  body: any,
  refund: number | null,
): void {
  if (self._pendingRefundInstanceId === instanceId) {
    self._pendingRefundInstanceId = null
    self._clearRefundRetry()
  }
  const price =
    typeof self.freebucks?.prices?.[model as any] === 'number'
      ? self.freebucks.prices[model as any]
      : null
  const admittedAt = self.session?.admittedAt
    ? Date.parse(self.session.admittedAt)
    : NaN
  const holdMs =
    Number.isFinite(admittedAt) && admittedAt > 0
      ? Math.max(0, Date.now() - admittedAt)
      : null
  const expected =
    price != null && holdMs != null
      ? Math.max(0, round2(price * (1 - holdMs / MS.hour)))
      : null
  const expectedUnits =
    holdMs != null
      ? Math.max(0, round2(1 - Math.max(0.1, holdMs / MS.hour)))
      : null
  const entry = {
    instanceId,
    model: model ?? null,
    refund,
    expected,
    expectedUnits,
    price,
    holdMs,
    at: new Date().toISOString(),
  }
  self.lastRefund = entry
  self._emitRefund(entry)
  void body
}

/**
 * 仍挂起时的处置: 保留句柄并持续追问.
 *
 * pending = "最终用量还没算完, 用同一个 instance 再问一次回执", 不是"不退".
 * 所以: 句柄必须留着(丢了这笔预扣就永远取不回来); 立刻挂上持续重试定时器
 * (只靠"下次启动扫尾"意味着进程不重启就再也没人问过); 也不能上报成退款 0.
 *
 * 同时把句柄登记为 orphan: 上游已确认会话 ended, 这条 session 不能继续占着,
 * 否则该账号永远无法 admit 新会话(等于把整号废掉). 额度占用解除, 但
 * instanceId 落盘保留, 交给启动扫尾 / 后续重放把那笔挂起的结算要回来.
 * @param {any} self 会话实例
 * @param {string} instanceId 目标会话实例 id
 * @param {string | null | undefined} model 该会话绑定的模型
 * @returns {void}
 */
export function parkPendingRefund(
  self: any,
  instanceId: string,
  model: string | null | undefined,
): void {
  logger.warn('session refund still pending; will keep polling for the receipt', {
    instanceId,
    model,
    attempts: 3,
  })
  self._pendingRefundInstanceId = instanceId
  self._scheduleRefundRetry()
  self._emitSessionEvent({
    type: 'refund_pending',
    key: self.accountKey,
    instanceId,
    model,
  })
  self._emitSessionEvent({
    type: 'orphan',
    key: self.accountKey,
    instanceId,
    model,
    admittedAt: self.session?.admittedAt ?? null,
    expiresAt: self.session?.expiresAt ?? null,
  })
}

/**
 * 用回执里的 Freebucks 块刷新本地余额; 只有回执不带该块时, 才按退款额回填,
 * 让控制台和调度立刻看到[退款已到账].
 * @param {any} self 会话实例
 * @param {any} body 终态回执
 * @param {number | null} refund 上游给出的退款额
 * @returns {void}
 */
export function syncFreebucksAfterRelease(self: any, body: any, refund: number | null): void {
  const freebucks = extractFreebucks(body)
  if (freebucks) {
    self.freebucks = freebucks
    return
  }
  if (refund == null || !self.freebucks) return
  self.freebucks = {
    ...self.freebucks,
    balance: round2(Number(self.freebucks.balance || 0) + refund),
    daily: self.freebucks.daily
      ? {
          ...self.freebucks.daily,
          spent: round2(
            Math.max(0, Number(self.freebucks.daily.spent || 0) - refund),
          ),
          remaining: round2(
            Number(self.freebucks.daily.remaining || 0) + refund,
          ),
        }
      : self.freebucks.daily,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 收尾: 只有结算到终态才摘 orphan(仍挂起就保留它, 交给下次启动扫尾继续重放,
 * 那时钱还没回来, 摘掉就再也要不回来了).
 * @param {any} self 会话实例
 * @param {boolean} refundSettled 退款是否已到终态
 * @param {string | undefined} instanceId 目标会话实例 id
 * @returns {void}
 */
export function finalizeRelease(self: any, refundSettled: boolean, instanceId: any): void {
  if (refundSettled) {
    self._emitSessionEvent({ type: 'drop', key: self.accountKey, instanceId })
  }
  self.session = { status: 'none' }
  self._releasePending = false
  self._releaseRetries = 0
  self._clearReleaseRetry()
  self._notifySessionChange()
}
