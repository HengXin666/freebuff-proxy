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
  constructor({ upstream, config }) {
    this.upstream = upstream
    this.config = config
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
  }

  /** 请求开始（在途计数 +1，轮询跳过）。 */
  beginRequest() {
    this._inFlight += 1
  }

  /** 请求结束（在途计数 -1），归零时唤醒等待方。 */
  endRequest() {
    const before = this._inFlight
    this._inFlight = Math.max(0, this._inFlight - 1)
    if (before > 0 && this._inFlight === 0) {
      const waiters = this._idleWaiters
      this._idleWaiters = []
      for (const wake of waiters) wake()
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
    if (!s) return { status: 'none', quota: this.quota, lastProbe: this.lastProbe }
    const remainingMs =
      s.expiresAt != null
        ? Math.max(0, Date.parse(s.expiresAt) - Date.now())
        : s.remainingMs
    return {
      ...s,
      remainingMs,
      live: this.hasLiveSlot(s),
      quota: this.quota,
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
    if (!this.hasLiveSlot()) {
      this.session = { status: 'none' }
      return
    }
    try {
      await this.upstream.freebuffSession('DELETE')
      logger.info('released freebuff session', {
        instanceId: this.session?.instanceId,
        model: this.session?.model,
      })
    } catch (err) {
      logger.warn('session DELETE failed', {
        error: err instanceof Error ? err.message : String(err),
      })
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
