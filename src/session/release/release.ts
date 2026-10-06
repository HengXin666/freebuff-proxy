/**
 * 会话释放与退款结算.
 *
 * 这一层管的是钱: DELETE 的句柄一旦丢弃就再也删不掉那条会话, 预扣的
 * Freebucks 也永远取不回来. 因此异常路径全部以"保住句柄"为第一优先.
 * 决策与证据见 .agents/notes/implemented/bug-fix/2026-09-13-refund-reversed.md.
 */
import { logger } from '../../util/log.ts'
import { sleep } from '../inventory.ts'
import {
  finalizeRelease,
  parkPendingRefund,
  recordSettledRefund,
  syncFreebucksAfterRelease,
} from './settle.ts'

/**
 * 释放会话(早退 DELETE).
 *
 * 两本账不对称: session_units 当场按实际占用退还, Freebucks 侧只回
 * freebucksRefundPending(2 分钟内未到账, 重开直接吃 rate_limited +
 * freebucksShortfall) ---- 所以[付费时段内不释放]是策略, 不是优化.
 * 见 .agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md.
 * @returns {Promise<boolean>} true = 上游已确认结束
 * @param {any} this 会话实例
 */
export async function release(this: any): Promise<boolean> {
  return this.withLock(() => this._releaseUnlocked())
}

/**
 * 优雅释放: 先在途请求全部结束(受 idle 超时约束, 不会永久阻塞),
 * 再释放 session. 用于代理切换/账号重建 -- 避免把正在传输的 SSE 掐断.
 *
 * 付费时段内默认拒绝(与 releaseStrict 同源判据): 代理切换 / 账号重建这类
 * 系统内部动作没有资格扔掉已买断的一小时; 需要真删的调用方显式传 force
 * (例如用户主动删除账号).
 * @returns {Promise<boolean>} true = 上游已确认结束(或付费时段内按策略跳过)
 * @param {any} this 会话实例
 * @param {{force?: boolean}} [opts] force=true 时连付费时段内也删
 */
export async function releaseWhenIdle(this: any, opts: any = {}): Promise<boolean> {
  await this._waitForIdle()
  if (opts.force !== true && this.inPaidWindow()) {
    logger.info('refusing idle release: paid hour still running', {
      instanceId: this.session?.instanceId,
      model: this.session?.model,
    })
    return false
  }
  return this.withLock(() => this._releaseUnlocked())
}

/**
 * 带 handle 的严格释放: 失败时返回 false(调用方据此重试/上报, 不谎报成功).
 * @returns {Promise<boolean>} true = 上游已确认结束
 * @param {any} this 会话实例
 */
export async function releaseIfLive(this: any): Promise<boolean> {
  return this.withLock(() => this._releaseUnlocked({ retry: false }))
}

/**
 * 释放会话(早退 DELETE: session_units 按实际占用退还, Freebucks 只回
 * freebucksRefundPending ---- 后者[退不退]至今未结, 所以策略取保守侧:
 * 付费时段内一律不释放. 见 2026-09-13-refund-reversed.md 的结论强度标注).
 *
 * 失败时绝不丢弃 instanceId: 句柄没了就永远无法再删, 这条会话会一直占着
 * 上游会话槽位(该账号再也 admit 不了别的新模型). 所以失败时保留 session(连同
 * instanceId)并置 _releasePending, 由 _scheduleReleaseRetry 退避重试; 即使
 * 重试耗尽也把句柄留在 sessions.json 里, 交给下一次释放机会 / 下次进程启动
 * 的扫尾继续删.
 * @param {any} this 会话实例
 * @param {{ retry?: boolean }} [opts] retry=false 表示不再排重试(严格释放用)
 * @returns {Promise<boolean>} true = 上游已确认结束(或本来就无会话)
 */
export async function _releaseUnlocked(
  this: any,
  // 同 _admitUnlocked: 命名参数替代内联解构, 避免无法表达的 @param 债务.
  opts: { retry?: boolean } = {},
): Promise<boolean> {
  const retry = opts.retry !== false
  this._clearPoll()
  this._clearIdleRelease()
  if (!this.hasLiveSlot()) {
    this.session = { status: 'none' }
    this._releasePending = false
    this._notifySessionChange()
    return true
  }
  const instanceId = this.session?.instanceId
  const model = this.session?.model
  this._releasing = true
  let released = false
  // 退款结算是否已到终态. 注意 released=true 只表示"上游确认会话已结束",
  // 挂起(freebucksRefundPending)时同样是 true -- 所以不能用 released 来判断
  // 该不该摘掉 orphan(摘早了这笔预扣就永远要不回来).
  let refundSettled = false
  try {
    // 必须带 instance id: 上游 DELETE 没有 x-freebuff-instance-id 会 400
    // instance_required, 会话既删不掉也拿不到 session_units 退还.
    const first = await this.upstream.freebuffSession('DELETE', { instanceId })
    const { body, settled } = await replayUntilSettled(this, instanceId, first)
    const refund =
      typeof body?.freebucksRefund === 'number' ? body.freebucksRefund : null
    if (settled) {
      refundSettled = true
      recordSettledRefund(this, instanceId, model, body, refund)
    } else {
      parkPendingRefund(this, instanceId, model)
    }
    syncFreebucksAfterRelease(this, body, refund)
    this._notifyStateChange()
    logger.info('released freebuff session', {
      instanceId,
      model,
      refund,
      balance: this.freebucks?.balance ?? null,
    })
    released = true
  } catch (err: any) {
    // 关键: 保留 handle(不动 this.session). 丢弃 instanceId 会让这条会话
    // 变成无法寻址的孤儿: 既删不掉, 也会一直占着该账号的上游会话槽位.
    this._releasePending = true
    logger.warn('session DELETE failed; keeping handle for retry', {
      instanceId,
      model,
      error: err instanceof Error ? err.message : String(err),
      code: err?.code,
      attempt: this._releaseRetries,
    })
    if (retry) this._scheduleReleaseRetry()
    return false
  } finally {
    this._releasing = false
  }
  if (released) finalizeRelease(this, refundSettled, instanceId)
  return released
}

/**
 * 结算未完成时用同一个 instance 重放 DELETE 取回执(有界重放两次).
 *
 * 上游对"提前结束"的会话会持续回 freebucksRefundPending,
 * 1.5s / 7s / 17s / 37s / 67s 五次重放全部仍为 pending. 所以这里既不把
 * 挂起的回执读成"退款 0", 也不无限重放.
 * @param {any} this 会话实例
 * @param {string} instanceId 目标会话实例 id
 * @param {any} first 首次 DELETE 的回执
 * @returns {Promise<{body: any, settled: boolean}>} 最终回执与是否已终态
 */
async function replayUntilSettled(
  self: any,
  instanceId: string,
  first: any,
): Promise<{ body: any, settled: boolean }> {
  let body = first
  let refundPending = body?.freebucksRefundPending === true
  for (let i = 0; refundPending && i < 2; i += 1) {
    await sleep(i === 0 ? 1_500 : 4_000)
    body = await self.upstream.freebuffSession('DELETE', { instanceId })
    refundPending = body?.freebucksRefundPending === true
  }
  return { body, settled: !refundPending && body?.status === 'ended' }
}

/**
 * 把一笔已到终态的退款记进账本.
 *
 * expected 是"按实际占用时长应付的退款"(单价 x 未用满的小时数): 上游把结算
 * 挂在整点/5 的倍数上, expected 与 refund 的差就是需要解释的那部分, 这正是
 * "退款怎么都不是 5 的倍数"该被对账掉的地方.
 *
 * units 口径的应退是另一个数(上游有 0.1 小时的最小时长下限, 扣 0.1 起):
 * 两本账的应退是两个不同的数, 混在一起会让"Freebucks 侧为何长期 pending"
 * 这个未结问题彻底隐身.
 * @param {any} this 会话实例
 * @param {string} instanceId 目标会话实例 id
 * @param {string | null | undefined} model 该会话绑定的模型
 * @param {any} body 终态回执
 * @param {number | null} refund 上游给出的退款额
 * @returns {void}
 */

/**
 * 释放失败后的退避重试: 0s -> 5s -> 15s -> 60s(最多 4 次).
 * 重试仍失败也不丢句柄 -- session 原样留着, 等下一次释放机会(空闲计时 /
 * 换号 / [断开全部连接]/ 重启前严格释放)或下次进程启动的扫尾继续删.
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _scheduleReleaseRetry(this: any): void {
  if (this._releaseRetryTimer) return
  const delays = [0, 5_000, 15_000, 60_000]
  if (this._releaseRetries >= delays.length) return
  const delay = delays[this._releaseRetries]
  this._releaseRetries += 1
  this._releaseRetryTimer = setTimeout(() => {
    this._releaseRetryTimer = null
    if (!this.hasLiveSlot()) {
      this._clearReleaseRetry()
      return
    }
    this.release().catch((err: unknown) => {
      logger.warn('session release retry failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, delay)
  if (this._releaseRetryTimer.unref) this._releaseRetryTimer.unref()
}

/** 取消释放重试计时. */
/**
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _clearReleaseRetry(this: any): void {
  if (this._releaseRetryTimer) {
    clearTimeout(this._releaseRetryTimer)
    this._releaseRetryTimer = null
  }
}


/**
 * 严格释放(用于[断开全部连接]/[重启服务]/进程退出).
 *
 * 逐次 DELETE 直到上游确认结束, 或退避重试耗尽; 绝不谎报成功 -- 失败时句柄
 * 仍留在 sessions.json 里, 下次启动扫尾.
 *
 * 付费时段内一律拒绝(2026-10-06): 这一层是批量路径的收尾, 不是用户对
 * 某条会话的显式意图 ---- 已买断的一小时里发 DELETE 就是把钱扔掉(早退不退
 * Freebucks, 重开再买一小时). 实测链路: 面板点[重启服务] ->
 * shutdown(strict) -> releaseAllStrict -> 每账号 DELETE.
 *
 * 用户对单条会话的显式关闭走 closeSession, 那里显式传 force ----
 * 意图明确就不拦(见 src/web/routes/inventory/accounts/actions.ts).
 * 见 .agents/notes/implemented/bug-fix/2026-10-06-paid-window-guard-on-bulk-release-and-secret-tunables.md
 * @param {any} this 会话实例
 * @param {{force?: boolean}} [opts] force=true 时连付费时段内也删(用户显式意图)
 * @returns {Promise<{ok: boolean, instanceId?: string, attempts: number, error?: string}>}
 */
export async function releaseStrict(this: any, opts: any = {}): Promise<any> {
  if (opts.force !== true && this.inPaidWindow()) {
    logger.info('refusing strict release: paid hour still running', {
      instanceId: this.session?.instanceId,
      model: this.session?.model,
      expiresAt: this.session?.expiresAt ?? null,
    })
    return {
      ok: true,
      skippedPaidWindow: true,
      instanceId: this.session?.instanceId,
      attempts: 0,
    }
  }
  const delays = [0, 400, 1_500, 5_000]
  let attempts = 0
  let lastError: string | null = null
  for (const delay of delays) {
    if (!this.hasLiveSlot()) return { ok: true, attempts }
    if (delay > 0) await sleep(delay)
    attempts += 1
    try {
      const ok = await this.withLock(() => this._releaseUnlocked({ retry: false }))
      if (ok) return { ok: true, attempts }
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    const inst = this.session?.instanceId
    if (!this.hasLiveSlot()) return { ok: true, attempts }
    lastError = lastError || `session ${inst} still live after DELETE`
  }
  return {
    ok: false,
    instanceId: this.session?.instanceId,
    attempts,
    error: lastError || 'release failed',
  }
}

/**
 * 进程退出前的收尾: 停掉所有计时器, 按配置决定是否释放会话.
 *
 * 仍然走 release()(不是 releaseStrict): 付费时段内的会话由 _armIdleRelease
 * 的同一条判据保护 ---- 退出不是[用户想扔掉这一小时]的理由, 句柄已落盘,
 * 下次启动按付费时段判据决定删或复用.
 * @returns {Promise<void>} 收尾完成即 resolve
 * @param {any} this 会话实例
 */
export async function shutdown(this: any): Promise<void> {
  this._clearPoll()
  this._clearIdleRelease()
  this._clearReleaseRetry()
  if (this.config.session.releaseOnShutdown && !this.inPaidWindow()) {
    await this.release()
  }
}
