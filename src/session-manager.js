import { logger } from './util/log.js'
import { UpstreamError } from './upstream/client.js'

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
    if (!s) return { status: 'none', quota: this.quota }
    const remainingMs =
      s.expiresAt != null
        ? Math.max(0, Date.parse(s.expiresAt) - Date.now())
        : s.remainingMs
    return {
      ...s,
      remainingMs,
      live: this.hasLiveSlot(s),
      quota: this.quota,
    }
  }

  hasLiveSlot(session = this.session) {
    if (!session) return false
    if (session.status === 'active' && session.instanceId) return true
    // grace window: ended but instance still present
    if (session.status === 'ended' && session.instanceId) return true
    return false
  }

  isUsableForModel(model, session = this.session) {
    if (!this.hasLiveSlot(session)) return false
    if (!session?.model || !session.instanceId) return false
    if (session.status === 'ended') {
      // grace: can finish in-flight, but proxy policy: allow continue until
      // instance disappears if reAdmit not needed mid-request
      return session.model === model
    }
    if (session.expiresAt) {
      const left = Date.parse(session.expiresAt) - Date.now()
      // treat fully expired (past expiresAt) as needing re-admit for NEW work
      if (left <= 0 && this.config.session.reAdmitOnExpire) return false
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

      // Different model while holding a slot → release first
      if (
        this.hasLiveSlot() &&
        this.session?.model &&
        this.session.model !== model
      ) {
        logger.info('switching freebuff session model', {
          from: this.session.model,
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
      const opts = {}
      if (this.session?.instanceId) opts.instanceId = this.session.instanceId
      const body = await this.upstream.freebuffSession('GET', opts)
      this._apply(body)
      if (this.hasLiveSlot()) this._armPoll()
      else this._clearPoll()
      return this.session
    })
  }

  async release() {
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
