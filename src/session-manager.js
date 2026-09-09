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
   */
  constructor({ upstream, config, getSessionSettings, hasPendingUser }) {
    this.upstream = upstream
    this.config = config
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
    /** 最近一次早退 DELETE 的退款回执（控制台展示/排查用）。 */
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
  }

  /** 请求开始（在途计数 +1，轮询跳过，取消空闲释放计时）。 */
  beginRequest() {
    this._inFlight += 1
    this._clearIdleRelease()
  }

  /** 请求结束（在途计数 -1），归零时唤醒等待方并开始空闲释放计时。 */
  endRequest() {
    const before = this._inFlight
    this._inFlight = Math.max(0, this._inFlight - 1)
    if (before > 0 && this._inFlight === 0) {
      const waiters = this._idleWaiters
      this._idleWaiters = []
      for (const wake of waiters) wake()
      this._armIdleRelease()
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
   * 上游 2026-09 起按 Freebucks 计费——session 是「1 小时计费行，admit 时
   * 一次性扣费，提前结束（DELETE）退款」。旧行为把 session 一直留到过期，
   * 哪怕只发了一条请求也照扣一小时（多账号时几个账号一起在后台白扣）。
   * 这里在空闲后主动早退拿退款，是「多账号用更久」的核心。
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
      logger.info('releasing idle freebuff session (early end refunds Freebucks)', {
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
   *   { known, price, balance, affordable, quotaExempt, resetAt }
   * known=false 表示还没有拿到过 freebucks 块（老上游/尚未探测）——此时不拦截。
   * 无 price 的模型 = 不计费（unmetered），永远可买。
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
    const affordable =
      fb.quotaExempt === true ||
      (Number(fb.balance) >= price && !monthlySpent)
    return {
      known: true,
      price,
      balance: fb.balance,
      affordable,
      unmetered: false,
      quotaExempt: fb.quotaExempt === true,
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
   *   免费会话按次结算，过期中途被掐断会白占额度且响应截断，提前换最平滑；
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

      // Try GET first in case another path left a row
      if (!this.hasLiveSlot()) {
        try {
          const got = await this.upstream.freebuffSession('GET')
          this._apply(got)
          if (this.isUsableForModel(model)) return this.session
          if (
            this.hasLiveSlot() &&
            this.session?.model &&
            this.session.model !== model
          ) {
            await this._releaseUnlocked()
          }
        } catch (err) {
          logger.warn('session GET failed before admit', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
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
    // admit 可能发生在没有任何在途请求时（选号阶段就 admit、随后才拿 chat
    // 锁）：这里兜底起空闲计时，否则会话会一直挂到过期。
    if (this._inFlight === 0) this._armIdleRelease()
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
  }

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

  async _releaseUnlocked() {
    this._clearPoll()
    this._clearIdleRelease()
    if (!this.hasLiveSlot()) {
      this.session = { status: 'none' }
      return
    }
    const instanceId = this.session?.instanceId
    const model = this.session?.model
    this._releasing = true
    try {
      // 必须带 instance id：上游 DELETE 没有 x-freebuff-instance-id 会 400
      // instance_required，会话既删不掉也拿不到退款（issue #7 的元凶之一）。
      let body = await this.upstream.freebuffSession('DELETE', { instanceId })
      // 结算未完成（freebucksRefundPending）：用同一个 instance 重放 DELETE
      // 拿回执。有界重放一次，失败只记日志，绝不阻塞调用方。
      if (body?.freebucksRefundPending === true) {
        await sleep(1_500)
        body = await this.upstream.freebuffSession('DELETE', { instanceId })
      }
      const refund =
        typeof body?.freebucksRefund === 'number' ? body.freebucksRefund : null
      if (refund != null || body?.freebucks) {
        this.lastRefund = {
          instanceId,
          model,
          refund,
          at: new Date().toISOString(),
        }
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
      logger.info('released freebuff session', {
        instanceId,
        model,
        refund,
        balance: this.freebucks?.balance ?? null,
      })
    } catch (err) {
      logger.warn('session DELETE failed', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
        code: err?.code,
      })
    } finally {
      this._releasing = false
    }
    this.session = { status: 'none' }
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

  async shutdown() {
    this._clearPoll()
    this._clearIdleRelease()
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
 * session 按小时计价、admit 时一次性扣费、提前 DELETE 退款，所以本地必须知道
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

