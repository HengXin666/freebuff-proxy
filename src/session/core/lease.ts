/**
 * 租约与工时计量: 在途计数, 互斥锁, 已付费时段, 空闲释放计时.
 *
 * 这一层只碰计时与计数, 不碰上游网络(上游交互在 observe 与 admit).
 */
import { logger, runWithLogContext } from '../../util/log.ts'

/**
 * 请求开始(在途计数 +1, 轮询跳过, 取消空闲释放计时).
 * @returns {void}
 * @param {any} this 会话实例
 */
export function beginRequest(this: any): void {
  this._inFlight += 1
  // 本轮调度起算点: 只在 0 -> 1 时写, 同一轮内的并发请求共享同一个起点.
  if (this._inFlight === 1) {
    this._schedulingSince = Date.now()
    this._notifyScheduleChange()
  }
  this._clearIdleRelease()
}

/**
 * 请求结束(在途计数 -1), 归零时唤醒等待方并开始空闲释放计时.
 * @param {any} this 会话实例
 */
export function endRequest(this: any): void {
  const before = this._inFlight
  this._inFlight = Math.max(0, this._inFlight - 1)
  if (before > 0 && this._inFlight === 0) {
    // 本轮调度结束: 把时长结算掉(跨轮累加), 并清空起算点.
    this._settleScheduling()
    const waiters = this._idleWaiters
    this._idleWaiters = []
    for (const wake of waiters) wake()
    this._armIdleRelease()
  }
}

/**
 * 本轮调度时长(毫秒). 有在途请求时 = now - 起算点; 无在途请求时为 0.
 * 控制台用它显示"本轮已运行 ..."(实时增长).
 * @returns {number} 本轮已运行毫秒
 * @param {any} this 会话实例
 */
export function currentSchedulingMs(this: any): number {
  if (this._inFlight <= 0 || this._schedulingSince == null) return 0
  return Math.max(0, Date.now() - this._schedulingSince)
}

/**
 * 结算本轮调度: 上报时长给上层累加落盘, 然后清空起算点.
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _settleScheduling(this: any): void {
  const since = this._schedulingSince
  if (since == null) return
  const ms = Math.max(0, Date.now() - since)
  this._schedulingSince = null
  if (ms > 0) this._emitScheduling(ms)
  else this._notifyScheduleChange()
}

/**
 * 上报一次"本轮调度结束"(时长毫秒). 上层按账号累加进账本
 * (AccountStateStore), 去抖落盘, 不阻塞转发.
 * @param {any} this 会话实例
 * @param {number} ms 本轮调度毫秒
 * @returns {void}
 */
export function _emitScheduling(this: any, ms: number): void {
  if (this._onStateChange) {
    try {
      this._onStateChange({ schedulingMs: ms })
    } catch (err) {
      logger.warn('scheduling report callback failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * 上报"本账号本轮调度正在运行"(起算点变化 / 本轮结束).
 * 只用于把 schedulingSince 持久化, 好让控制台在重启后仍能区分
 * "这个号刚才还在干活"和"从来没动过".
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _notifyScheduleChange(this: any): void {
  if (!this._onStateChange) return
  try {
    this._onStateChange({
      schedulingSince: this._schedulingSince
        ? new Date(this._schedulingSince).toISOString()
        : null,
    })
  } catch {
    // 可观测性失败不影响转发
  }
}

/**
 * 空闲自动释放时长(毫秒, 0 = 关闭). 控制台设置优先于 config.yaml.
 * @returns {number} 空闲释放毫秒, 0 表示关闭
 * @param {any} this 会话实例
 */
export function idleReleaseMs(this: any): number {
  const override = this._getSessionSettings?.()?.idleReleaseSec
  const sec = Number.isFinite(override)
    ? override
    : this.config.session.idleReleaseSec
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0
}

/**
 * 距离本会话[已付费时段]结束还有多少毫秒; 无法判定时返回 null.
 *
 * 上游一次 admit 就是买断一小时: POST 当场扣满整小时单价(Freebucks 5 -> 0),
 * 回执带 admittedAt / expiresAt. 这一小时之内继续发请求的边际成本是 0;
 * DELETE 之后那一小时作废, 重开 = 重新买一整小时.
 * 见 .agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md
 *
 * expiresAt 优先; 上游只回 remainingMs 时用它兜底(admit 时的快照).
 * @param {any} this 会话实例
 * @param {any} [session] 待判定会话, 默认取 this.session
 * @returns {number | null} 剩余毫秒, 无法判定则 null
 */
export function paidWindowRemainingMs(this: any, session: any = this.session): number | null {
  if (!session) return null
  // grace(ended 但仍持 instanceId): 上游允许把在途做完, 不再续期.
  if (session.status === 'ended') return 0
  const exp = session.expiresAt != null ? Date.parse(session.expiresAt) : NaN
  if (Number.isFinite(exp)) return exp - Date.now()
  const rem = Number(session.remainingMs)
  if (Number.isFinite(rem)) {
    // remainingMs 是 admit 时的快照, 按 admit 时刻折算成"现在还剩多少".
    const admitted = session.admittedAt != null ? Date.parse(session.admittedAt) : NaN
    if (Number.isFinite(admitted)) return admitted + rem - Date.now()
    return rem
  }
  return null
}

/**
 * 本会话是否仍在已付费时段内(判不出来时返回 false = 不拦).
 * @param {any} this 会话实例
 * @param {any} [session] 待判定会话, 默认取 this.session
 * @returns {boolean} 在付费时段内则为真
 */
export function inPaidWindow(this: any, session: any = this.session): boolean {
  const left = this.paidWindowRemainingMs(session)
  return left != null && left > 0
}

/**
 * 入参形态的付费时段判定: 给不持有会话实例的调用方用(启动扫尾 / 路由层).
 *
 * 与 inPaidWindow 同一判据, 只是把会话对象直接收进来:
 *   - 启动扫尾只有磁盘上的句柄(还没有 SessionManager);
 *   - 控制面路由只想问"这个 key 现在能不能放".
 * 两处都必须与调度层用同一条判据, 否则会出现"调度层不释放, 别的路径照删"
 * 这种一边保护一边烧钱的分裂.
 * @param {any} session 会话句柄(可来自磁盘), 缺 expiresAt 时判不出来
 * @returns {boolean} 在已付费时段内则为真; 判不出来返回 false(不拦)
 */
export function inPaidWindowFor(session: any): boolean {
  if (!session) return false
  if (session.status === 'ended') return false
  const exp = session.expiresAt != null ? Date.parse(session.expiresAt) : NaN
  return Number.isFinite(exp) && exp - Date.now() > 0
}

/**
 * 空闲自动释放: 在途归零后空闲超过 session.idleReleaseSec 就早退 DELETE.
 *
 * 已付费时段内不释放. 上游一次 admit 就是买断一小时: POST 当场扣满整小时
 * 单价, 回执带 expiresAt; 早退 DELETE 只回 freebucksRefundPending, 不退款:
 *
 *     admit      rem 5 -> 0      (当场扣满)
 *     25s 后 DELETE -> {status:"ended", freebucksRefundPending:true}
 *     +20/+40/+60/+120s          rem 仍为 0, 未到账
 *     重放 DELETE x2             仍然只有 pending, 无金额
 *
 * 而 session_units 那本账早退是当场按比例退的(1.1 -> 0.2). 24 个
 * [账号 x 模型]组合里 22 个是 Freebucks 先见底, 所以早退等于拿稀缺的账去省
 * 不稀缺的账.
 *
 * 腾槽位给别的模型由上层显式 release 负责, 不走这条空闲路径.
 * idleReleaseSec 是付费时段结束之后的空闲释放时长.
 * 见 .agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _armIdleRelease(this: any): void {
  const ms = this.idleReleaseMs()
  // 仍在已付费时段内: 闲置不花钱, 释放才是浪费(那一小时已买断).
  const left = this.paidWindowRemainingMs()
  const inPaid = left != null && left > 0
  if (!ms || !this.hasLiveSlot() || inPaid) {
    this._clearIdleRelease()
    return
  }
  // 已有计时就不重置: 后台轮询(GET /session)每 pollIntervalSec 一次,
  // 若每次都顺延, 空闲释放永远触发不了.
  if (this._idleTimer) return
  this._idleTimer = setTimeout(() => {
    this._idleTimer = null
    if (this._inFlight > 0 || !this.hasLiveSlot()) return
    if (this._hasPendingUser()) {
      // 有请求正排队等这条会话: 别删, 等它用完后重新计时.
      this._armIdleRelease()
      return
    }
    logger.info('releasing idle freebuff session (paid window over; frees the account slot)', {
      instanceId: this.session?.instanceId,
      model: this.session?.model,
      idleSec: Math.round(ms / 1000),
    })
    this.release().catch((err: unknown) => {
      logger.warn('idle session release failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, ms)
  if (this._idleTimer.unref) this._idleTimer.unref()
}

/**
 * 取消空闲释放计时.
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _clearIdleRelease(this: any): void {
  if (this._idleTimer) {
    clearTimeout(this._idleTimer)
    this._idleTimer = null
  }
}

/**
 * 等待在途请求全部结束. 默认不限时: 每个在途 SSE 流都受自身 idle 超时
 * 约束(幽灵连接会在 streamIdleTimeoutSec 后被掐断并释放锁), 健康的长流
 * 会正常结束 -- 切换连接时绝不能掐断健康流, 所以无限等待是安全的.
 * @param {any} this 会话实例
 * @param {number} [timeoutMs] >0 时强制设上限, 超时直接返回(由调用方兜底)
 * @returns {Promise<void>} 归零或超时即 resolve
 */
export async function _waitForIdle(this: any, timeoutMs = 0): Promise<void> {
  if (this._inFlight <= 0) return
  await new Promise<void>((resolve) => {
    const wake = () => {
      if (timer) clearTimeout(timer)
      resolve()
    }
    let timer: any = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const i = this._idleWaiters.indexOf(wake)
        if (i >= 0) this._idleWaiters.splice(i, 1)
        resolve()
      }, timeoutMs)
      if (timer.unref) timer.unref()
    }
    this._idleWaiters.push(wake)
  })
}

/**
 * Serialize admit/release operations.
 * @param {any} this 会话实例
 * @param {() => Promise<any>} fn 临界区回调
 * @returns {Promise<any>} fn 的返回值
 */
export async function withLock(this: any, fn: () => Promise<any>): Promise<any> {
  let release: any
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const prev = this._mutex
  this._mutex = prev.then(() => wait)
  await prev
  try {
    // 锁内的整段执行都带上本账号的日志上下文(refresh / admit / release /
    // 退款追问全走这里) -- 没有它, 探测与释放产生的日志在控制台上
    // 就是几十条无主记录, 按账号筛选筛不出任何东西.
    return this._logContext
      ? await runWithLogContext(this._logContext, fn)
      : await fn()
  } finally {
    release()
  }
}
