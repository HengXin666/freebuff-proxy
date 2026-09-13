import { logger } from './util/log.js'
import { UpstreamError } from './upstream/client.js'
import { isFreeModel } from './model.js'

/**
 * Manages a single Freebuff free-session slot for this proxy process.
 * Model is always taken from the downstream request — never a proxy default.
 */
export class SessionManager {
  /**
   * @param {object} opts
   * @param {ReturnType<import('./upstream/client.js').createUpstreamClient>} opts.upstream
   * @param {import('./config.js').ProxyConfig} opts.config
   * @param {string} [opts.accountKey] 账号标识（sessions.json 持久化的 owner key）
   * @param {(entry: {key: string, instanceId: string, model: string, admittedAt?: string | null, expiresAt?: string|null}) => void} [opts.onSessionChange]
   *   会话句柄变化通知（admit/释放）——由上层落盘到 /data/sessions.json，
   *   保证进程退出/换容器后仍能寻址并 DELETE 掉活着的会话。
   */
  constructor({
    upstream,
    config,
    getSessionSettings,
    hasPendingUser,
    accountKey = null,
    onSessionChange = null,
    onStateChange = null,
  }) {
    this.upstream = upstream
    this.config = config
    /** 账号标识（sessions.json 里的 owner key）。 */
    this.accountKey = accountKey
    /** 句柄变更回调（落盘 /data/sessions.json）。 */
    this._onSessionChange =
      typeof onSessionChange === 'function' ? onSessionChange : null
    /**
     * 「账号账目变了」回调（freebucks / quota / lastProbe）——由上层落盘到
     * /data/account-state.json。这些数字原先是纯内存的：重启后余额归零会让
     * "买不起就别 admit" 的闸门失忆，于是重启后的第一个请求就会去撞一个
     * 已知余额不足的账号（正是要避免的封禁触发条件）。
     */
    this._onStateChange =
      typeof onStateChange === 'function' ? onStateChange : null
    /**
     * 「有人正排队要用这个账号」的判定（账号级 chat 锁在途/排队）。
     * 空闲释放要跳过这种情况：选号阶段就 admit、随后在等 chat 锁的请求还没
     * 走到 beginRequest（在途计数仍为 0），若此刻把会话删掉，请求会撞上
     * 已失效会话，白白多买一条计费会话。
     */
    this._hasPendingUser =
      typeof hasPendingUser === 'function' ? hasPendingUser : () => false
    /**
     * 控制台「额度保护」设置（settings.json）实时覆盖 config.yaml：
     * idleReleaseSec（空闲自动释放秒数）。返回 null 时用 config 默认值。
     */
    this._getSessionSettings =
      typeof getSessionSettings === 'function' ? getSessionSettings : () => null
    /** @type {null | {
     *   status: string,
     *   instanceId?: string,
     *   model?: string,
     *   admittedAt?: string,
     *   expiresAt?: string,
     *   remainingMs?: number,
     *   accessTier?: string,
     *   raw?: any
     * }} */
    this.session = null
    /**
     * Cached per-model daily quota from the last admit/refresh that included
     * rateLimit / rateLimitsByModel. Survives session release so the console
     * can keep showing 已用/上限 until the next admit refreshes it.
     * @type {null | { byModel: Record<string, any>, rateLimit: any, updatedAt: string }}
     */
    this.quota = null
    this._mutex = Promise.resolve()
    this._pollTimer = null
    /** 当前正在处理中的请求数（在途 chat 时跳过轮询 GET，避免干扰活跃会话）。 */
    this._inFlight = 0
    /**
     * 最近一次探测（refresh GET）的结果：成功/失败 + 具体原因。
     * 供控制台展示"为什么这个账号刷新失败"（country_blocked / rate_limited /
     * invalid key…），而不是笼统的"冷却中"。成功时 ok=true。
     * @type {null | { ok: boolean, at: string, code?: string | null, status?: number | null, message?: string } }
     */
    this.lastProbe = null
    /** 等待在途请求归零的监听器（会话平滑切换/优雅释放时用）。 */
    this._idleWaiters = []
    /**
     * Freebucks 计量块（上游每次 session 响应都带）：余额 / 每日池 / 每模型
     * session 单价。用于「余额买不起就别 admit」以及控制台展示。
     * @type {null | {
     *   balance: number,
     *   daily: { limit: number, spent: number, remaining: number, resetAt: string | null },
     *   wallet: { balance: number, monthlyBonus: number, nextBonusAt: string | null },
     *   prices: Record<string, number>,
     *   quotaExempt: boolean,
     *   planId: string | null,
     *   monthly: { remainingUsd: number, resetAt: string | null } | null,
     *   updatedAt: string
     * }}
     */
    this.freebucks = null
    /** 最近一次早退 DELETE 的回执（控制台展示/排查用；Freebucks 恒为 0）。 */
    this.lastRefund = null
    /** 空闲自动释放定时器（在途归零后开始计时）。 */
    this._idleTimer = null
    /** 正在早退 DELETE（空闲释放/换号释放）：期间不得被选号复用。 */
    this._releasing = false
    /**
     * 成功新建的上游会话计数（每次 POST /session 成功 +1）。
     * 下游请求的「新会话预算」据此扣减：被上游拒绝的 admit（rate_limited 等）
     * 不消耗额度，只有真正扣了 Freebucks 的会话才算。
     */
    this.admitCount = 0
    /**
     * 释放失败待重试：DELETE 失败时**绝不能丢弃 instanceId**——丢了这条会话
     * 就永远删不掉（连 session_units 也退不回来），只能白占一个上游会话槽位。
     * true = session 里仍留着 instanceId，等待下一次释放机会重试。
     */
    this._releasePending = false
    /** 释放重试定时器。 */
    this._releaseRetryTimer = null
    /** 已连续重试次数（成功后清零）。 */
    this._releaseRetries = 0
    /**
     * 本账号**本轮连续调度**的开始时刻（第一条在途请求开始时写入，归零时清空）。
     * 与 `scheduledMs`（累计调度时长，跨轮累加）一起落盘，控制台即可显示
     * "累计调度 3h20m / 本轮运行 12m"。
     *
     * 为什么必须落盘：这是"这个号到底被用了多久"的唯一口径——账号池里
     * 哪些号在干活、哪些号从没被启用过，光看 `requests`（次数）是看不出来的
     * （长对话 1 次 = 几十分钟，短批量 300 次可能只有几分钟）。
     * @type {number | null} epoch ms
     */
    this._schedulingSince = null
  }

  /** 请求开始（在途计数 +1，轮询跳过，取消空闲释放计时）。 */
  beginRequest() {
    this._inFlight += 1
    // 本轮调度起算点：只在 0 → 1 时写，同一轮内的并发请求共享同一个起点。
    if (this._inFlight === 1) {
      this._schedulingSince = Date.now()
      this._notifyScheduleChange()
    }
    this._clearIdleRelease()
  }

  /** 请求结束（在途计数 -1），归零时唤醒等待方并开始空闲释放计时。 */
  endRequest() {
    const before = this._inFlight
    this._inFlight = Math.max(0, this._inFlight - 1)
    if (before > 0 && this._inFlight === 0) {
      // 本轮调度结束：把时长结算掉（跨轮累加），并清空起算点。
      this._settleScheduling()
      const waiters = this._idleWaiters
      this._idleWaiters = []
      for (const wake of waiters) wake()
      this._armIdleRelease()
    }
  }

  /**
   * 本轮调度时长（毫秒）。有在途请求时 = now - 起算点；否则 0。
   * 控制台用它显示"本轮已运行 …"（实时增长）。
   */
  currentSchedulingMs() {
    if (this._inFlight <= 0 || this._schedulingSince == null) return 0
    return Math.max(0, Date.now() - this._schedulingSince)
  }

  /** 结算本轮调度：上报时长给上层累加落盘，然后清空起算点。 */
  _settleScheduling() {
    const since = this._schedulingSince
    if (since == null) return
    const ms = Math.max(0, Date.now() - since)
    this._schedulingSince = null
    if (ms > 0) this._emitScheduling(ms)
    else this._notifyScheduleChange()
  }

  /**
   * 上报一次"本轮调度结束"（时长毫秒）。上层按账号累加进账本
   * （AccountStateStore），去抖落盘，不阻塞转发。
   */
  _emitScheduling(ms) {
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
   * 上报"本账号本轮调度正在运行"（起算点变化 / 本轮结束）。
   * 只用于把 `schedulingSince` 持久化，好让控制台在重启后仍能区分
   * "这个号刚才还在干活"和"从来没动过"。
   */
  _notifyScheduleChange() {
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

  /** 空闲自动释放时长（毫秒，0 = 关闭）。控制台设置优先于 config.yaml。 */
  idleReleaseMs() {
    const override = this._getSessionSettings?.()?.idleReleaseSec
    const sec = Number.isFinite(override)
      ? override
      : this.config.session.idleReleaseSec
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0
  }

  /**
   * 空闲自动释放：在途归零后空闲超过 session.idleReleaseSec 就早退 DELETE。
   *
   * ⚠️ 2026-09-13 实测（docs/account-scheduling-and-refund.md §3）：早退**不退款**。
   * admit 一次 = 实付整小时单价，之后用 3 秒还是 59 分钟扣的一样多；DELETE 只退还
   * session_units（每日模型额度），Freebucks 一分不退（freebucksRefund 恒为 0）。
   *
   * 所以这里释放的目的**不是省钱**，而是释放上游会话槽位（一个账号同时只有一条
   * session，且 session 绑定模型），让换模型/换账号能拿到槽位。省钱只能靠**少 admit**，
   * 因此默认空闲释放时长已上调到 600s，避免「释放 -> 再请求 -> 重买一小时」的抖动。
   */
  _armIdleRelease() {
    const ms = this.idleReleaseMs()
    if (!ms || !this.hasLiveSlot()) {
      this._clearIdleRelease()
      return
    }
    // 已有计时就不重置：后台轮询（GET /session）每 pollIntervalSec 一次，
    // 若每次都顺延，空闲释放永远触发不了。
    if (this._idleTimer) return
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null
      if (this._inFlight > 0 || !this.hasLiveSlot()) return
      if (this._hasPendingUser()) {
        // 有请求正排队等这条会话：别删，等它用完后重新计时。
        this._armIdleRelease()
        return
      }
      logger.info('releasing idle freebuff session (frees the account slot; no refund)', {
        instanceId: this.session?.instanceId,
        model: this.session?.model,
        idleSec: Math.round(ms / 1000),
      })
      this.release().catch((err) => {
        logger.warn('idle session release failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, ms)
    if (this._idleTimer.unref) this._idleTimer.unref()
  }

  _clearIdleRelease() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
  }

  /**
   * 该模型在这个账号上的 Freebucks 账目：
   *   { known, price, balance, affordable, quotaExempt, resetAt, reason }
   * known=false 表示还没有拿到过 freebucks 块（老上游/尚未探测）——此时不拦截。
   * 无 price 的模型 = 不计费（unmetered），永远可买。
   *
   * **上游的封号判定有两条**（issue #11 实测）：
   *   ① Freebucks 跑完了（今日池 `daily.remaining <= 0`）；
   *   ② 本次请求所需 Freebucks 高于剩余余额（`balance < prices[model]`）。
   * 命中任一条就可能直接封号，所以 `affordable === false` 必须同时覆盖两者
   * ——只判 ② 会漏掉"池子跑完但 balance 还留着数字"的账号，照样送上去撞封禁。
   * `reason` 标明是哪一条命中，便于日志与前端解释（不再只报"余额不够"）。
   * @param {string} model
   */
  freebucksFor(model) {
    const fb = this.freebucks
    if (!fb) return { known: false, price: null, balance: null, affordable: true }
    // 每日池重置时刻已过 → 本地数字自认过期（太平洋午夜刷新），不再据此
    // 拦截选号：让一次真实 admit 用上游的最新余额重新校准，而不是拿冻结的
    // 旧数字把账号一直排除在外。
    const resetAt = fb.daily?.resetAt ? Date.parse(fb.daily.resetAt) : NaN
    if (Number.isFinite(resetAt) && resetAt <= Date.now()) {
      return {
        known: false,
        price: null,
        balance: fb.balance,
        affordable: true,
        stale: true,
      }
    }
    const price = typeof fb.prices?.[model] === 'number' ? fb.prices[model] : null
    if (price == null) {
      return {
        known: true,
        price: null,
        balance: fb.balance,
        affordable: true,
        unmetered: true,
        resetAt: fb.daily?.resetAt || null,
      }
    }
    const monthlySpent =
      fb.monthly != null && Number(fb.monthly.remainingUsd) <= 0
    // 条件①：今日池跑完（`limit > 0` 才算真的有池子，避免把 limit=0 的
    // "没有池子" 误判成"池子跑完"）。resetAt 已过在上面就 return 了，所以这里
    // 的 remaining 一定是未重置周期的数字。quotaExempt 账号不受任何池限制。
    const dailyLimit = Number(fb.daily?.limit)
    const dailyRemaining = Number(fb.daily?.remaining)
    const dailyExhausted =
      Number.isFinite(dailyLimit) &&
      dailyLimit > 0 &&
      Number.isFinite(dailyRemaining) &&
      dailyRemaining <= 0
    // 条件②：余额买不起本次请求
    const shortOnBalance = Number(fb.balance) < price
    const exempt = fb.quotaExempt === true
    const affordable =
      exempt || (!dailyExhausted && !shortOnBalance && !monthlySpent)
    /** 命中哪一条（用于日志/前端解释；affordable=true 时为 null）。 */
    const reason = affordable
      ? null
      : dailyExhausted
        ? "daily_exhausted"
        : monthlySpent
          ? "monthly_exhausted"
          : "balance_shortfall"
    return {
      known: true,
      price,
      balance: fb.balance,
      affordable,
      unmetered: false,
      quotaExempt: exempt,
      dailyExhausted,
      dailyRemaining: Number.isFinite(dailyRemaining) ? dailyRemaining : null,
      dailyLimit: Number.isFinite(dailyLimit) ? dailyLimit : null,
      reason,
      resetAt: fb.daily?.resetAt || null,
    }
  }

  /** 当前在途请求数（监控/优雅释放用）。 */
  inFlightCount() {
    return this._inFlight
  }

  /**
   * 等待在途请求全部结束。默认不限时：每个在途 SSE 流都受自身 idle 超时
   * 约束（幽灵连接会在 streamIdleTimeoutSec 后被掐断并释放锁），健康的长流
   * 会正常结束——切换连接时绝不能掐断健康流，所以无限等待是安全的。
   * @param {number} [timeoutMs] >0 时强制设上限，超时直接返回（由调用方兜底）
   */
  async _waitForIdle(timeoutMs = 0) {
    if (this._inFlight <= 0) return
    await new Promise((resolve) => {
      const wake = () => {
        if (timer) clearTimeout(timer)
        resolve()
      }
      let timer = null
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

  /** Serialize admit/release operations. */
  async withLock(fn) {
    let release
    const wait = new Promise((resolve) => {
      release = resolve
    })
    const prev = this._mutex
    this._mutex = prev.then(() => wait)
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  getSnapshot() {
    const s = this.session
    if (!s) {
      return {
        status: 'none',
        quota: this.quota,
        freebucks: this.freebucks,
        lastRefund: this.lastRefund,
        lastProbe: this.lastProbe,
      }
    }
    const remainingMs =
      s.expiresAt != null
        ? Math.max(0, Date.parse(s.expiresAt) - Date.now())
        : s.remainingMs
    return {
      ...s,
      remainingMs,
      live: this.hasLiveSlot(s),
      quota: this.quota,
      freebucks: this.freebucks,
      lastRefund: this.lastRefund,
      lastProbe: this.lastProbe,
    }
  }

  hasLiveSlot(session = this.session) {
    if (!session) return false
    if (session.status === 'active' && session.instanceId) return true
    // grace window: ended but instance still present
    if (session.status === 'ended' && session.instanceId) return true
    return false
  }

  /**
   * 会话剩余时间低于该阈值（秒）后不再承接新请求，提前 re-admit 换新会话，
   * 避免请求发到马上过期的会话上、中途卡住（切换流量更平滑）。
   *
   * 按模型计费方式分层：
   * - 免费模型（daily/referral/limited_offer/helper）：剩余不足
   *   `session.free_model_re_admit_lead_sec`（默认 300s = 5 分钟）即不再调度——
   *   免费会话 admit 一次即买断整小时，过期中途被掐断会让响应截断，提前换最平滑；
   * - 付费模型（premium）：每次 admit 都是计费会话，尽量用到接近过期
   *   （沿用 `session.re_admit_lead_sec`，默认 60s），避免频繁新建付费会话。
   * @param {string} model
   */
  reAdmitLeadMs(model) {
    const sec = this.config.session.reAdmitLeadSec
    const base = (Number.isFinite(sec) && sec > 0 ? sec : 60) * 1000
    if (isFreeModel(model)) {
      const freeSec = this.config.session.freeModelReAdmitLeadSec
      const freeBase =
        (Number.isFinite(freeSec) && freeSec > 0 ? freeSec : 300) * 1000
      return Math.max(base, freeBase)
    }
    return base
  }

  /**
   * 会话切换等待在途请求的上界（毫秒）：约等于"持锁者最坏存活时长"——响应头
   * 等待（与 body idle 同量级）+ body idle 一个周期 + 余量。超过该值视为账号
   * 卡死（网络波动叠加），放弃本账号让上层冷却/换号，绝不无限等待。
   */
  switchWaitMs() {
    const idleSec = this.config.limits.streamIdleTimeoutSec
    const idleMs = (Number.isFinite(idleSec) && idleSec > 0 ? idleSec : 120) * 1000
    return 2 * idleMs + 60_000
  }

  isUsableForModel(model, session = this.session) {
    // 正在早退释放（空闲/换号）的会话不再被选号复用，避免 DELETE 与 chat 抢同一条会话。
    if (this._releasing) return false
    if (!this.hasLiveSlot(session)) return false
    if (!session?.model || !session.instanceId) return false
    if (session.status === 'ended') {
      // grace: can finish in-flight, but proxy policy: allow continue until
      // instance disappears if reAdmit not needed mid-request
      return session.model === model
    }
    if (this.config.session.reAdmitOnExpire) {
      // expiresAt 优先；上游只回 remainingMs 时用它兜底（admit 时的快照）。
      const left =
        session.expiresAt != null
          ? Date.parse(session.expiresAt) - Date.now()
          : typeof session.remainingMs === 'number'
            ? session.remainingMs
            : null
      // 已过期 / 剩余时间不足 lead → 新请求需要 re-admit（提前平滑切换）
      if (left != null && left <= this.reAdmitLeadMs(model)) return false
    }
    return session.status === 'active' && session.model === model
  }

  /**
   * Ensure an active free session bound to `model`.
   * @param {string} model upstream freebuff model id
   */
  async ensureSession(model) {
    if (!model) {
      throw new UpstreamError('model is required to admit a freebuff session', {
        status: 400,
        code: 'model_required',
      })
    }
    return this.withLock(async () => {
      if (this.isUsableForModel(model)) {
        return this.session
      }

      // 平滑切换的竞态保护：live 会话可能正被在途 SSE 流使用（例如热会话
      // 排队等待 chat 锁期间，另一个请求先走到这里）。此时若直接释放再
      // re-admit，会把正在传输的 session 从上游删掉——上游连接还在但
      // session 已消失，用户端会永久卡住。先等在途请求全部结束（受 stream
      // idle 超时约束，幽灵连接也会被掐断），再释放重建。
      // 用循环而非单次等待：某次归零的瞬间可能有新请求刚拿到 chat 锁开始
      // 在途，需继续等它，直到观察到真正的空闲窗口。
      // **等待必须有上界**：在途流若因网络波动长时间不结束（虽然最终会受
      // idle 超时约束结束），新请求不能无限干等——否则"一条链卡死 → 所有
      // 后续请求全部超时"。超时放弃本账号，由上层冷却/换下一个账号。
      const switchDeadline = Date.now() + this.switchWaitMs()
      while (
        this.hasLiveSlot() &&
        !this.isUsableForModel(model) &&
        this._inFlight > 0
      ) {
        const left = switchDeadline - Date.now()
        if (left <= 0) {
          logger.warn('session switch timed out waiting for in-flight requests', {
            model,
            from: this.session?.model,
            to: model,
            inFlight: this._inFlight,
            waitMs: this.switchWaitMs(),
          })
          throw new UpstreamError(
            'session switch timed out: in-flight requests did not finish in time',
            { status: 429, code: 'account_busy' },
          )
        }
        logger.info('waiting for in-flight requests before session switch', {
          model,
          from: this.session?.model,
          to: model,
          inFlight: this._inFlight,
        })
        await this._waitForIdle(Math.min(left, 2_000))
      }
      // 等待期间可能已被其他路径重建/续期，重新检查
      if (this.isUsableForModel(model)) return this.session

      // 持有的 slot 已不可用（模型不符 / 已过期 / 即将过期）：先释放再 admit，
      // 平滑切换——避免带着旧 session 直接 POST 造成上游 model_locked 或排队。
      if (this.hasLiveSlot() && !this.isUsableForModel(model)) {
        logger.info('releasing session before re-admit', {
          model,
          status: this.session?.status,
          from: this.session?.model,
          to: model,
        })
        await this._releaseUnlocked()
      }

      // 冷路径：本地已知"没有活跃会话"，直接 admit。
      //
      // 这里原本还要先 GET 一次（"in case another path left a row"）。但上游
      // **同一个账号同一时间只能有一个客户端在线**：本进程的会话状态由
      // session-manager 单点持有（admit/释放/轮询都经 withLock 串行化），
      // refresh() 与本方法同用一把锁，不存在"别人偷偷建了会话而我不知道"。
      // 那次 GET 只在**本进程之外**有人用同一个号时才有意义，代价却是每条
      // 冷请求都多一个完整 RTT（实测 +580ms 首字节，见
      // test/repro-firstbyte.mjs）。真正的兜底已经在上游：模型不符时 admit 会
      // 返回 model_locked，_admitUnlocked 内部会释放并重试一次。
      //
      // 换模型时仍需先释放旧会话（上游一次只服务一个模型），这段逻辑保留。
      if (this.hasLiveSlot() && !this.isUsableForModel(model)) {
        await this._releaseUnlocked()
      }

      return this._admitUnlocked(model)
    })
  }

  async _admitUnlocked(model, { forceReleaseLocked = false } = {}) {
    if (forceReleaseLocked) {
      await this._releaseUnlocked()
    }

    logger.info('admitting freebuff session', { model })
    const body = await this.upstream.freebuffSession('POST', { model })

    if (body?.status === 'active' && body.instanceId) {
      this.admitCount += 1
      this._apply(body)
      this._armPoll()
      logger.info('freebuff session active', {
        model: body.model,
        instanceId: body.instanceId,
        expiresAt: body.expiresAt,
        accessTier: body.accessTier,
      })
      return this.session
    }

    if (body?.status === 'model_locked') {
      // End current and re-claim requested model
      logger.info('model_locked; releasing and re-admitting', {
        currentModel: body.currentModel,
        requestedModel: body.requestedModel || model,
      })
      await this._releaseUnlocked()
      const again = await this.upstream.freebuffSession('POST', { model })
      if (again?.status === 'active' && again.instanceId) {
        this.admitCount += 1
        this._apply(again)
        this._armPoll()
        return this.session
      }
      throw this._terminalSessionError(again, model)
    }

    throw this._terminalSessionError(body, model)
  }

  _terminalSessionError(body, model) {
    const statusMap = {
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
        (body?.message ? ` — ${body.message}` : ''),
      {
        status: statusMap[st] || 502,
        code: st,
        body: { ...body, requestedModel: model },
        retryAfterMs: body?.retryAfterMs,
      },
    )
  }

  _apply(body) {
    if (!body || typeof body !== 'object') {
      this.session = { status: 'none' }
      return
    }
    const prev = this.session
    // 旧的 handle 还没删掉（DELETE 一直失败）而现在要换成新会话：不能就这么
    // 覆盖丢掉 instanceId——把它作为「待清理」交给上层落盘持久化，之后仍会
    // 继续尝试 DELETE（否则它就成了无法寻址的孤儿，一直占着上游会话槽位）。
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
    if (quota || freebucks) this._notifyStateChange()
    // admit 可能发生在没有任何在途请求时（选号阶段就 admit、随后才拿 chat
    // 锁）：这里兜底起空闲计时，否则会话会一直挂到过期。
    if (this._inFlight === 0) this._armIdleRelease()
    // 句柄落盘：进程退出/换容器后仍能凭 instanceId 去 DELETE 释放上游会话槽位。
    this._notifySessionChange()
  }

  async refresh() {
    return this.withLock(async () => {
      // 上游同一个号同一时间只能有一个客户端在线：轮询 GET 若撞上在途
      // chat 会干扰/顶掉活跃会话（428 waiting_room_required），因此跳过。
      if (this._inFlight > 0) return this.session
      const opts = {}
      if (this.session?.instanceId) opts.instanceId = this.session.instanceId
      try {
        const body = await this.upstream.freebuffSession('GET', opts)
        this._apply(body)
        this._setLastProbe({ ok: true })
        if (this.hasLiveSlot()) this._armPoll()
        else this._clearPoll()
        return this.session
      } catch (err) {
        this._setLastProbe({
          ok: false,
          code: err?.code || (err instanceof Error ? err.name : null),
          status: err?.status ?? null,
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    })
  }

  _setLastProbe(patch) {
    const now = new Date().toISOString()
    if (patch.ok) {
      this.lastProbe = { ok: true, at: now, code: null, status: null, message: null }
    } else {
      this.lastProbe = {
        ok: false,
        at: now,
        code: patch.code ?? null,
        status: patch.status ?? null,
        message: patch.message ?? null,
      }
    }
    this._notifyStateChange()
  }

  /** 释放会话（早退 DELETE 只退还 session_units，Freebucks 不退）。返回 true = 上游已确认结束。 */
  async release() {
    return this.withLock(() => this._releaseUnlocked())
  }

  /**
   * 优雅释放：先在途请求全部结束（受 idle 超时约束，不会永久阻塞），
   * 再释放 session。用于代理切换/账号重建——避免把正在传输的 SSE 掐断。
   */
  async releaseWhenIdle() {
    await this._waitForIdle()
    return this.withLock(() => this._releaseUnlocked())
  }

  /**
   * 释放会话（早退 DELETE：退还 session_units，**Freebucks 不退**，见 §3）。
   *
   * **失败时绝不丢弃 instanceId**：句柄没了就永远无法再删，这条会话会一直占着
   * 上游会话槽位（该账号再也 admit 不了别的新模型）。所以失败时保留 session（连同
   * instanceId）并置 _releasePending，由 _scheduleReleaseRetry 退避重试；即使
   * 重试耗尽也把句柄留在 sessions.json 里，交给下一次释放机会 / 下次进程启动
   * 的扫尾继续删。
   *
   * @returns {Promise<boolean>} true = 上游已确认结束（或本来就无会话）
   */
  async _releaseUnlocked({ retry = true } = {}) {
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
    /** @type {boolean} */
    let released = false
    // 退款**结算**是否已到终态。注意 released=true 只表示"上游确认会话已结束"，
    // 挂起（freebucksRefundPending）时同样是 true —— 所以不能用 released 来判断
    // 该不该摘掉 orphan（摘早了这笔预扣就永远要不回来）。
    let refundSettled = false
    try {
      // 必须带 instance id：上游 DELETE 没有 x-freebuff-instance-id 会 400
      // instance_required，会话既删不掉也拿不到 session_units 退还（issue #7 的元凶之一）。
      let body = await this.upstream.freebuffSession('DELETE', { instanceId })
      // 结算未完成（freebucksRefundPending）：用同一个 instance 重放 DELETE
      // 拿回执。**有界重放**，失败只记日志，绝不阻塞调用方。
      //
      // 2026-09 实测：上游对"提前结束"的会话会持续回 freebucksRefundPending，
      // 1.5s / 7s / 17s / 37s / 67s 五次重放全部仍为 pending。所以这里**既不
      // 能让挂起的回执冒充"退款 0"**（那是把"没结算完"错读成"退了 0 元"），
      // 也不能无限重放。重放两次后仍 pending 就保留句柄，交给下一次释放 /
      // 下次启动扫尾继续试。
      let refundPending = body?.freebucksRefundPending === true
      for (let i = 0; refundPending && i < 2; i += 1) {
        await sleep(i === 0 ? 1_500 : 4_000)
        body = await this.upstream.freebuffSession('DELETE', { instanceId })
        refundPending = body?.freebucksRefundPending === true
      }
      const settled = !refundPending && body?.status === 'ended'
      const refund =
        typeof body?.freebucksRefund === 'number' ? body.freebucksRefund : null
      if (settled) {
        // 只有拿到**终态**回执才算结算完成。没有金额 = 退款 0（vendor
        // af898dc 口径：ended 且不带 freebucksRefund 字段就是 0）。
        refundSettled = true
        // expected：按"实际占用时长"应付的退款（单价 × 未用满的小时数）。
        // 上游把结算挂在整点/5 的倍数上，expected 与 refund 的差就是需要解释的
        // 那部分——这正是"退款怎么都不是 5 的倍数"该被对账掉的地方。
        const price =
          typeof this.freebucks?.prices?.[model] === 'number'
            ? this.freebucks.prices[model]
            : null
        const admittedAt = this.session?.admittedAt
          ? Date.parse(this.session.admittedAt)
          : NaN
        const holdMs =
          Number.isFinite(admittedAt) && admittedAt > 0
            ? Math.max(0, Date.now() - admittedAt)
            : null
        const expected =
          price != null && holdMs != null
            ? Math.max(0, round2(price * (1 - holdMs / 3_600_000)))
            : null
        const entry = {
          instanceId,
          model,
          refund,
          expected,
          price,
          holdMs,
          at: new Date().toISOString(),
        }
        this.lastRefund = entry
        this._emitRefund(entry)
      } else {
        // 仍挂起：句柄必须留着（否则这笔预扣永远无法再结算），也**不能**上报成
        // 退款 0 —— 报 pending=true，让账本归到"待结算"而不是"疑似退款失败"。
        logger.warn('session refund still pending after replay', {
          instanceId,
          model,
          attempts: 3,
        })
        // 上游已确认会话 ended —— **这条 session 不能继续占着**，否则该账号
        // 永远无法 admit 新会话（等于把整号废掉）。把句柄登记为 orphan：
        // 额度占用解除，但 instanceId 落盘保留，交给启动扫尾 / 后续重放去
        // 把挂起的结算要回来（handle store 已实现这套持久化）。
        this._emitSessionEvent({
          type: 'orphan',
          key: this.accountKey,
          instanceId,
          model,
          admittedAt: this.session?.admittedAt ?? null,
          expiresAt: this.session?.expiresAt ?? null,
        })
      }
      const freebucks = extractFreebucks(body)
      if (freebucks) this.freebucks = freebucks
      else if (refund != null && this.freebucks) {
        // 上游只回回执、不回 freebucks 块时，本地按退款回填余额，
        // 让控制台和调度立刻看到「退款已到账」。
        this.freebucks = {
          ...this.freebucks,
          balance: round2(Number(this.freebucks.balance || 0) + refund),
          daily: this.freebucks.daily
            ? {
                ...this.freebucks.daily,
                spent: round2(
                  Math.max(0, Number(this.freebucks.daily.spent || 0) - refund),
                ),
                remaining: round2(
                  Number(this.freebucks.daily.remaining || 0) + refund,
                ),
              }
            : this.freebucks.daily,
          updatedAt: new Date().toISOString(),
        }
      }
      this._notifyStateChange()
      logger.info('released freebuff session', {
        instanceId,
        model,
        refund,
        balance: this.freebucks?.balance ?? null,
      })
      released = true
    } catch (err) {
      // 关键：**保留 handle**（不动 this.session）。丢弃 instanceId 会让这条会话
      // 变成无法寻址的孤儿：既删不掉，也会一直占着该账号的上游会话槽位。
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
    if (released) {
      // 只有**结算到终态**才摘 orphan。若仍挂起就保留它，交给下次启动扫尾继续
      // 重放——那时钱还没回来，摘掉就再也要不回来了。
      if (refundSettled) {
        this._emitSessionEvent({
          type: 'drop',
          key: this.accountKey,
          instanceId,
        })
      }
      this.session = { status: 'none' }
      this._releasePending = false
      this._releaseRetries = 0
      this._clearReleaseRetry()
      this._notifySessionChange()
    }
    return released
  }

  /**
   * 释放失败后的退避重试：0s → 5s → 15s → 60s（最多 4 次）。
   * 重试仍失败也**不丢句柄**——session 原样留着，等下一次释放机会（空闲计时 /
   * 换号 / 「断开全部连接」/ 重启前严格释放）或下次进程启动的扫尾继续删。
   */
  _scheduleReleaseRetry() {
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
      this.release().catch((err) => {
        logger.warn('session release retry failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, delay)
    if (this._releaseRetryTimer.unref) this._releaseRetryTimer.unref()
  }

  _clearReleaseRetry() {
    if (this._releaseRetryTimer) {
      clearTimeout(this._releaseRetryTimer)
      this._releaseRetryTimer = null
    }
  }

  /**
   * 通知上层把会话句柄落盘（/data/sessions.json）。进程退出/换容器后仍能
   * 凭 instanceId 去 DELETE 退款，而不是留下无法寻址的孤儿会话。
   */
  _notifySessionChange() {
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

  /** 上报会话事件（track / orphan）——上层据此维护会话句柄索引。 */
  _emitSessionEvent(entry) {
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

  /** 上报一笔已结算的退款（上层记进账号账本的退款流水）。 */
  _emitRefund(entry) {
    if (!this._onStateChange) return
    try {
      this._onStateChange({ refund: entry })
    } catch (err) {
      logger.warn('refund callback failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** 上报账号账目变化（freebucks / quota / lastProbe）——上层据此落盘。 */
  _notifyStateChange() {
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

  /** 带 handle 的严格释放：失败时返回 false（调用方据此重试/上报，不谎报成功）。 */
  async releaseIfLive() {
    return this.withLock(() => this._releaseUnlocked({ retry: false }))
  }

  /**
   * Force re-admit after gate error mid-request.
   * @param {string} model
   */
  async forceReadmit(model) {
    return this.withLock(async () => {
      await this._releaseUnlocked()
      return this._admitUnlocked(model)
    })
  }

  _armPoll() {
    this._clearPoll()
    const ms = Math.max(5_000, (this.config.session.pollIntervalSec || 30) * 1000)
    this._pollTimer = setInterval(() => {
      this.refresh().catch((err) => {
        logger.warn('session poll failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, ms)
  }

  _clearPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  }

  /** 该账号当前仍活着的上游 instance id（含一次也没删掉的句柄）。 */
  knownInstances() {
    const s = this.session
    if (!this.hasLiveSlot(s)) return []
    return [s.instanceId]
  }

  /**
   * 严格释放（用于「断开全部连接」/「重启服务」/进程退出）：
   * 逐次 DELETE 直到上游确认结束，或退避重试耗尽；返回结果明细，
   * **绝不谎报成功**——失败时句柄仍留在 sessions.json 里，下次启动扫尾。
   * @returns {Promise<{ok: boolean, instanceId?: string, attempts: number, error?: string}>}
   */
  async releaseStrict() {
    const delays = [0, 400, 1_500, 5_000]
    let attempts = 0
    let lastError = null
    for (const delay of delays) {
      if (!this.hasLiveSlot()) {
        return { ok: true, attempts }
      }
      if (delay > 0) await sleep(delay)
      attempts += 1
      try {
        const ok = await this.withLock(() =>
          this._releaseUnlocked({ retry: false }),
        )
        if (ok) return { ok: true, attempts }
      } catch (err) {
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

  async shutdown() {
    this._clearPoll()
    this._clearIdleRelease()
    this._clearReleaseRetry()
    if (this.config.session.releaseOnShutdown) {
      await this.release()
    }
  }
}


/**
 * Pull daily-session quota out of a Freebuff session payload.
 * Present on admit (POST) and on GET while a slot is live; absent when
 * status is none. Returns null when the payload has no quota info.
 * @param {any} body
 * @returns {null | { byModel: Record<string, any>, rateLimit: any, updatedAt: string }}
 */
function extractQuota(body) {
  if (!body || typeof body !== 'object') return null
  const byModel =
    body.rateLimitsByModel && typeof body.rateLimitsByModel === 'object'
      ? body.rateLimitsByModel
      : null
  if (!byModel && !body.rateLimit) return null
  const single = byModel || {}
  if (body.rateLimit && body.rateLimit.model) {
    single[body.rateLimit.model] = body.rateLimit
  }
  return {
    byModel: single,
    rateLimit: body.rateLimit || null,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Pull the Freebucks meter out of a Freebuff session payload (2026-09 计费改版).
 *
 * 上游把「计费货币」放在每个 session 响应的 freebucks 字段里：
 *   { balance, daily:{limit,spent,remaining,resetAt}, wallet:{...},
 *     prices:{ modelId: price }, quotaExempt, planId, monthly, peak, priceChanges }
 * admit 按整小时单价预扣、**提前 DELETE 不退**（2026-09-13 实测，见 §3），所以本地必须知道
 * 「每个模型多少钱」和「这个账号还买不买得起」，否则会白白 admit 一堆计费会话。
 * 老上游/未登录状态没有该字段 → 返回 null，调度退回旧行为（不拦截）。
 * @param {any} body
 */
function extractFreebucks(body) {
  if (!body || typeof body !== 'object') return null
  const fb = body.freebucks
  if (!fb || typeof fb !== 'object') return null
  const daily = fb.daily && typeof fb.daily === 'object' ? fb.daily : {}
  const wallet = fb.wallet && typeof fb.wallet === 'object' ? fb.wallet : {}
  /** @type {Record<string, number>} */
  const prices = {}
  if (fb.prices && typeof fb.prices === 'object') {
    for (const [id, price] of Object.entries(fb.prices)) {
      const n = Number(price)
      if (Number.isFinite(n)) prices[id] = n
    }
  }
  const monthly =
    fb.monthly && typeof fb.monthly === 'object'
      ? {
          limitUsd: num(fb.monthly.limitUsd),
          spentUsd: num(fb.monthly.spentUsd),
          remainingUsd: num(fb.monthly.remainingUsd),
          resetAt: fb.monthly.resetAt ?? null,
        }
      : null
  return {
    balance: num(fb.balance),
    daily: {
      limit: num(daily.limit),
      spent: num(daily.spent),
      remaining: num(daily.remaining),
      resetAt: daily.resetAt ?? null,
    },
    wallet: {
      balance: num(wallet.balance),
      monthlyBonus: num(wallet.monthlyBonus),
      nextBonusAt: wallet.nextBonusAt ?? null,
    },
    prices,
    quotaExempt: fb.quotaExempt === true,
    planId: typeof fb.planId === 'string' ? fb.planId : null,
    monthly,
    peak: fb.peak && typeof fb.peak === 'object' ? fb.peak : null,
    updatedAt: new Date().toISOString(),
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/** 有界等待（毫秒）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}
