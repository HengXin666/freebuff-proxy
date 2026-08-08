import {
  resolveCredentialsDir,
  listAccounts,
  readAccountUser,
  freebuffAuthHeaders,
} from './auth-store.js'
import { createUpstreamClient } from './upstream/client.js'
import { SessionManager } from './session-manager.js'
import { UpstreamError } from './upstream/client.js'
import { isUnlimitedModel } from './model.js'
import { logger } from './util/log.js'

/** Errors where trying another logged-in account may succeed. */
const SWITCHABLE_CODES = new Set([
  'rate_limited',
  'spend_limited',
  'ip_capped',
  'premium_slot_taken',
  'model_unavailable',
  'banned',
  'no_session',
  'admit_failed',
])

/** Whole-account cooldown (any model). */
const ACCOUNT_COOLDOWN_CODES = new Set([
  'rate_limited',
  'spend_limited',
  'ip_capped',
  'banned',
  'premium_slot_taken',
])

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_COOLDOWN_MS = 60_000
const BANNED_COOLDOWN_MS = DAY_MS

/**
 * Multi-account pool. Single selection path: availability-based auto pick.
 */
export class AccountRuntimes {
  /**
   * @param {import('./config.js').ProxyConfig} config
   */
  constructor(config) {
    this.config = config
    this.dir = resolveCredentialsDir(config)
    /** @type {Map<string, { email: string, authToken: string, user: any, upstream: any, sessions: SessionManager, source: string }>} */
    this.byEmail = new Map()
    /**
     * Cooldown key: email  (whole account) or email\0model (per-model).
     * @type {Map<string, { until: number, code?: string, model?: string }>}
     */
    this.cooldowns = new Map()
    this._rr = 0
    this._lastSuccessEmail = null
    /** Per-account success counters (in-memory, for load-balance visibility). */
    this.stats = { total: 0, byEmail: new Map() }
  }

  list() {
    const now = Date.now()
    return listAccounts(this.dir).map((a) => {
      const cd = this.cooldowns.get(a.email)
      const cooling = Boolean(cd && cd.until > now)
      const rt = this.byEmail.get(a.email)
      const snap = rt?.sessions?.getSnapshot?.()
      return {
        ...a,
        lastUsed: this._lastSuccessEmail === a.email,
        available: !cooling,
        cooldownUntil: cooling ? new Date(cd.until).toISOString() : null,
        cooldownCode: cooling ? cd.code : null,
        requests: this.stats.byEmail.get(a.email) || 0,
        session: snap
          ? {
              status: snap.status,
              model: snap.model,
              remainingMs: snap.remainingMs,
              live: snap.live,
            }
          : null,
        // 每日免费 session 额度（来自最近一次 admit/refresh 的上游返回）
        quota: decorateQuota(snap?.quota),
      }
    })
  }

  /**
   * @param {string} email
   */
  get(email) {
    const normalized = String(email || '')
      .trim()
      .toLowerCase()
    const user = readAccountUser(this.dir, normalized)
    if (!user?.authToken) {
      throw new UpstreamError(`Account not found or not logged in: ${email}`, {
        status: 401,
        code: 'upstream_auth_missing',
      })
    }

    const existing = this.byEmail.get(user.email)
    if (
      existing &&
      existing.authToken === user.authToken &&
      existing.proxy === (user.proxy || null)
    ) {
      return existing
    }
    if (existing) {
      existing.sessions.shutdown().catch(() => {})
      this.byEmail.delete(user.email)
    }

    const upstream = createUpstreamClient(this.config, user.authToken, {
      proxy: user.proxy || null,
    })
    const sessions = new SessionManager({ upstream, config: this.config })
    const runtime = {
      email: user.email,
      authToken: user.authToken,
      proxy: user.proxy || null,
      user,
      upstream,
      sessions,
      source: `credentials:${user.email}`,
    }
    this.byEmail.set(user.email, runtime)
    return runtime
  }

  allEmails() {
    return listAccounts(this.dir).map((a) => a.email)
  }

  _cooldownKey(email, model) {
    return model ? `${email}\0${model}` : email
  }

  /**
   * Account-level OR (if model given) model-level cooldown blocks selection.
   * @param {string} email
   * @param {string | null} [model]
   */
  isCoolingDown(email, model = null) {
    this._pruneCooldown(email)
    if (this.cooldowns.has(email)) return true
    if (model) {
      const key = this._cooldownKey(email, model)
      this._pruneCooldown(key)
      if (this.cooldowns.has(key)) return true
    }
    return false
  }

  _pruneCooldown(key) {
    const cd = this.cooldowns.get(key)
    if (cd && cd.until <= Date.now()) this.cooldowns.delete(key)
  }

  /**
   * @param {string} email
   * @param {import('./upstream/client.js').UpstreamError | { code?: string, retryAfterMs?: number }} err
   * @param {string | null} [model]
   */
  markCooldown(email, err, model = null) {
    const code = err?.code
    let ms =
      typeof err?.retryAfterMs === 'number' && err.retryAfterMs > 0
        ? err.retryAfterMs
        : DEFAULT_COOLDOWN_MS

    if (code === 'banned') {
      ms = Math.max(ms, BANNED_COOLDOWN_MS)
    }

    // model_unavailable / similar: only block that model on this account
    const perModel =
      code === 'model_unavailable' && model && !ACCOUNT_COOLDOWN_CODES.has(code)
    const key = perModel ? this._cooldownKey(email, model) : email
    const until = Date.now() + Math.min(ms, DAY_MS)
    this.cooldowns.set(key, {
      until,
      code,
      model: perModel ? model : undefined,
    })
    logger.info('account cooling down; will try others', {
      email,
      code,
      until: new Date(until).toISOString(),
      model: perModel ? model : null,
      scope: perModel ? 'model' : 'account',
    })
  }

  clearCooldown(email, model = null) {
    this.cooldowns.delete(email)
    if (model) this.cooldowns.delete(this._cooldownKey(email, model))
  }

  _recordSuccess(email) {
    this.stats.total += 1
    this.stats.byEmail.set(email, (this.stats.byEmail.get(email) || 0) + 1)
  }

  /**
   * @param {string} model
   */
  candidateEmails(model) {
    const emails = this.allEmails()
    if (!emails.length) return []

    const scored = emails.map((email, idx) => {
      let score = 0
      const rt = this.byEmail.get(email)
      if (rt?.sessions?.isUsableForModel?.(model)) score += 100
      if (email === this._lastSuccessEmail) score += 10
      const rot =
        (idx + emails.length - (this._rr % emails.length)) % emails.length
      score += (emails.length - rot) / 100
      if (this.isCoolingDown(email, model)) score -= 1000
      // 配额感知：仅对"限额"模型生效（flash/mimo 等 unlimited 池不限量，
      // 不应按 rateLimitsByModel 的已用/上限来切换账号，避免无谓的 session 替换）
      if (!isUnlimitedModel(model)) {
        const q = rt?.sessions?.getSnapshot?.()?.quota?.byModel?.[model]
        if (q && Number.isFinite(q.limit) && q.limit > 0) {
          const used = Number(q.recentCount) || 0
          const remaining = Math.max(0, q.limit - used)
          score += Math.min(10, (remaining / q.limit) * 10)
          if (remaining <= 0) score -= 500
        }
      }
      return { email, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.map((s) => s.email)
  }

  /**
   * @param {string} model
   * @param {{ preferredEmail?: string | null }} [opts] sticky pin: try this
   *   account first when it is not cooling down; fall back to the pool.
   */
  async acquireForModel(model, opts = {}) {
    if (!model) {
      throw new UpstreamError('model is required', {
        status: 400,
        code: 'model_required',
      })
    }

    const emails = this.allEmails()
    if (!emails.length) {
      throw new UpstreamError(
        'No Freebuff accounts. Add one via the web console (账号管理 → 添加账号) or run `npm run login`.',
        { status: 401, code: 'upstream_auth_missing' },
      )
    }

    const order = this.candidateEmails(model)
    /** @type {Array<{ email: string, code?: string, message: string }>} */
    const failures = []

    // Sticky path: honor the caller's preferred (sticky) account first.
    const preferred = opts.preferredEmail
    if (
      preferred &&
      emails.includes(preferred) &&
      !this.isCoolingDown(preferred, model)
    ) {
      try {
        const rt = this.get(preferred)
        await rt.sessions.ensureSession(model)
        this.clearCooldown(preferred, model)
        this._lastSuccessEmail = preferred
        this._recordSuccess(preferred)
        logger.info('sticky account selected', { email: preferred, model })
        return rt
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failures.push({ email: preferred, code: err?.code, message })
        const wrap =
          err instanceof UpstreamError
            ? err
            : new UpstreamError(message, { status: 502, code: 'admit_failed' })
        this.markCooldown(preferred, wrap, model)
        logger.warn('sticky account failed; falling back to pool', {
          email: preferred,
          model,
          error: message,
        })
      }
    }

    for (const email of order) {
      if (this.isCoolingDown(email, model)) {
        const cd =
          this.cooldowns.get(email) ||
          this.cooldowns.get(this._cooldownKey(email, model))
        failures.push({
          email,
          code: cd?.code || 'cooldown',
          message: `cooling down until ${cd ? new Date(cd.until).toISOString() : '?'}`,
        })
        continue
      }

      let rt
      try {
        rt = this.get(email)
      } catch (err) {
        failures.push({
          email,
          code: err?.code,
          message: err instanceof Error ? err.message : String(err),
        })
        continue
      }

      try {
        await rt.sessions.ensureSession(model)
        this.clearCooldown(email, model)
        this._lastSuccessEmail = email
        this._rr = (this._rr + 1) % Math.max(emails.length, 1)
        this._recordSuccess(email)
        logger.info('selected account for model', { email, model })
        return rt
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failures.push({ email, code: err?.code, message })
        const wrap =
          err instanceof UpstreamError
            ? err
            : new UpstreamError(message, { status: 502, code: 'admit_failed' })
        this.markCooldown(email, wrap, model)
        logger.warn('account ensureSession failed; trying next', {
          email,
          model,
          error: message,
          code: err?.code,
        })
      }
    }

    throw new UpstreamError(
      `No available Freebuff account for model ${model}. Tried ${failures.length} account(s).`,
      {
        status: 429,
        code: 'no_available_account',
        body: { model, failures },
        retryAfterMs: this.earliestCooldownMs(),
      },
    )
  }

  /**
   * @param {string} model
   * @param {{ preferredEmail?: string | null, gateCode?: string | null }} [opts]
   */
  async reacquireAfterGate(model, opts = {}) {
    if (opts.preferredEmail) {
      if (opts.gateCode && SWITCHABLE_CODES.has(opts.gateCode)) {
        this.markCooldown(
          opts.preferredEmail,
          new UpstreamError(opts.gateCode, {
            code: opts.gateCode,
            status: 429,
            retryAfterMs: 30_000,
          }),
          model,
        )
      } else {
        try {
          const rt = this.get(opts.preferredEmail)
          await rt.sessions.forceReadmit(model)
          this.clearCooldown(opts.preferredEmail, model)
          this._lastSuccessEmail = opts.preferredEmail
          return rt
        } catch (err) {
          const wrap =
            err instanceof UpstreamError
              ? err
              : new UpstreamError(String(err), { code: 'admit_failed' })
          this.markCooldown(opts.preferredEmail, wrap, model)
        }
      }
    }
    return this.acquireForModel(model)
  }

  earliestCooldownMs() {
    const now = Date.now()
    let min = null
    for (const cd of this.cooldowns.values()) {
      if (cd.until > now) {
        const left = cd.until - now
        if (min == null || left < min) min = left
      }
    }
    return min ?? DEFAULT_COOLDOWN_MS
  }

  /** Any account for status/doctor (not used for chat selection). */
  getAny() {
    const emails = this.allEmails()
    if (!emails.length) {
      throw new UpstreamError(
        'No Freebuff accounts. Run `npm run login` (saves credentials/<email>.json).',
        { status: 401, code: 'upstream_auth_missing' },
      )
    }
    const preferred = this._lastSuccessEmail || emails[0]
    return this.get(preferred)
  }

  async shutdown() {
    const tasks = [...this.byEmail.values()].map((rt) => rt.sessions.shutdown())
    await Promise.allSettled(tasks)
    this.byEmail.clear()
  }
}

/**
 * 标注额度中的不限量模型（upstream 可能仍返回 limit 条目，但按目录 pool 视为不限）。
 * @param {any} quota
 */
function decorateQuota(quota) {
  if (!quota || typeof quota !== 'object') return null
  const byModel = {}
  for (const [model, entry] of Object.entries(quota.byModel || {})) {
    if (entry && typeof entry === 'object') {
      byModel[model] = isUnlimitedModel(model)
        ? { ...entry, unlimited: true }
        : entry
    } else {
      byModel[model] = entry
    }
  }
  return { ...quota, byModel }
}

/**
 * @param {import('./config.js').ProxyConfig} config
 */
export function buildAppContext(config) {
  const runtimes = new AccountRuntimes(config)
  const emails = runtimes.allEmails()
  if (!emails.length) {
    // Zero-account startup is allowed: the web console can add Freebuff
    // accounts later. Runtime endpoints report 401 until one exists.
    return {
      config,
      dir: runtimes.dir,
      runtimes,
      authToken: null,
      authSource: null,
      authEmail: null,
      upstream: null,
      sessions: null,
    }
  }
  const current = runtimes.getAny()
  return {
    config,
    dir: runtimes.dir,
    runtimes,
    // Convenience mirrors of getAny() for CLI status/doctor
    authToken: current.authToken,
    authSource: current.source,
    authEmail: current.email,
    upstream: current.upstream,
    sessions: current.sessions,
  }
}

export { freebuffAuthHeaders }
