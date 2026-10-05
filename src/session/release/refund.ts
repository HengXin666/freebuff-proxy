/**
 * 退款结算的追问链路: 待结算重试与重放取回执.
 *
 * 从 release.ts 按职责切出. 这一层问的是"钱回来没有", 与
 * _scheduleReleaseRetry 那条"会话删没删掉"的退避重试是两件事.
 *
 * 语义(见 .agents/notes/implemented/bug-fix/2026-09-13-refund-reversed.md):
 * 上游回 freebucksRefundPending => 结算未完成, 入队并持续重放 DELETE 追问;
 * 只有拿到终态回执(含 refund: 0)才允许出队; 重放失败 / 账号没了 / 仍 pending,
 * 一律保留记录 -- 绝不静默丢弃那笔预扣.
 */
import { logger } from '../../util/log.ts'
import {
  REFUND_RETRY_INTERVAL_MS,
  REFUND_RETRY_MAX_MS,
} from '../inventory.ts'

/**
 * 待结算退款的持续重试: 只要这笔预扣还没拿到终态回执就一直在问.
 *
 * 上游在 pending 期间要求用同一个 instanceId 重放 DELETE 才能取回执(官方
 * 客户端在 pending 期间每 3 秒重放一次). 这里取 30s 间隔 + 最长 1 小时:
 * 既不像 3s 那样对上游刷请求, 又保证进程不重启也能拿到钱. 超时后句柄仍留在
 * sessions.json, 由下次启动扫尾继续.
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _scheduleRefundRetry(this: any): void {
  if (this._refundRetryTimer) return
  const instanceId = this._pendingRefundInstanceId
  if (!instanceId) return
  if (!this._refundRetryStartedAt) this._refundRetryStartedAt = Date.now()
  if (Date.now() - this._refundRetryStartedAt > REFUND_RETRY_MAX_MS) {
    logger.warn(
      'pending refund still unsettled after the retry window; handle kept for next startup sweep',
      { instanceId, model: this.session?.model ?? null },
    )
    return
  }
  this._refundRetryTimer = setTimeout(() => {
    this._refundRetryTimer = null
    this._refundRetryStartedAt = null
    if (!this._pendingRefundInstanceId) return
    this._replayPendingRefund().catch((err: unknown) => {
      logger.warn('pending refund replay failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, REFUND_RETRY_INTERVAL_MS)
  if (this._refundRetryTimer.unref) this._refundRetryTimer.unref()
}

/**
 * 用同一个 instanceId 重放 DELETE 取退款回执.
 *
 * instanceId 只存在于内存(this._pendingRefundInstanceId)与 sessions.json 的
 * orphan 列表里; 这里不依赖 this.session(那条会话早已置为 none), 所以空闲释放
 * 之后的挂起退款也能继续被追问.
 * @returns {Promise<void>} 追问一次即返回
 * @param {any} this 会话实例
 */
export async function _replayPendingRefund(this: any): Promise<void> {
  const instanceId = this._pendingRefundInstanceId
  if (!instanceId) return
  const body = await this.upstream.freebuffSession('DELETE', {
    instanceId,
    timeoutMs: this.config.session?.admitTimeoutMs ?? 30_000,
  })
  const pending = body?.freebucksRefundPending === true
  // 还没算完 / 既没给终态也没说 pending: 继续等, 句柄留着(绝不当作退 0).
  if (pending || body?.status !== 'ended') {
    this._scheduleRefundRetry()
    return
  }
  const refund =
    typeof body?.freebucksRefund === 'number' ? body.freebucksRefund : null
  this._pendingRefundInstanceId = null
  this._clearRefundRetry()
  this._refundRetryStartedAt = null
  const model = this.session?.model ?? null
  const price =
    typeof this.freebucks?.prices?.[model] === 'number'
      ? this.freebucks.prices[model]
      : null
  const entry = {
    instanceId,
    model,
    refund,
    expected: null,
    expectedUnits: null,
    price,
    holdMs: null,
    replayed: true,
    at: new Date().toISOString(),
  }
  this.lastRefund = entry
  // 结算到了才允许摘 orphan -- 这时钱已经回来了.
  this._emitSessionEvent({ type: 'drop', key: this.accountKey, instanceId })
  this._emitRefund(entry)
  this._notifyStateChange()
  logger.info('pending refund settled on replay', { instanceId, model, refund })
}

/**
 * 取消待结算重试(拿到终态回执后调用).
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _clearRefundRetry(this: any): void {
  if (this._refundRetryTimer) {
    clearTimeout(this._refundRetryTimer)
    this._refundRetryTimer = null
  }
  this._refundRetryStartedAt = null
}
