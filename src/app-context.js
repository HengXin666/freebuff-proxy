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
  'free_mode_rate_limited',
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
  'free_mode_rate_limited',
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
        effectiveProxy: rt?.effectiveProxy || null,
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
      accountId: user.email,
    })
    const sessions = new SessionManager({ upstream, config: this.config })
    const runtime = {
      email: user.email,
      authToken: user.authToken,
      proxy: user.proxy || null,
      /** 实际生效的出网代理（全局池分配 / 账号覆盖 / env） */
      effectiveProxy: upstream.proxyUrl || null,
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
    // 强制轮询：每次请求按 第1、第2、第3…个账号轮流分配，
    // 冷却中的账号跳过。上游无状态（每次请求带全量历史），
    // 不做会话粘性/分组，也不做配额加权（否则会打破轮询，把请求吸回同一账号）。
    // 每个账号自己的 free session 仍会在轮到它时被复用，热 session 不丢。
    const start = this._rr % emails.length
    const order = []
    for (let i = 0; i < emails.length; i++) {
      const email = emails[(start + i) % emails.length]
      if (this.isCoolingDown(email, model)) continue
      order.push(email)
    }
    return order
  }

  /**
   * 强制轮询选号：从轮询指针开始按账号顺序尝试，冷却中的账号跳过。
   * 上游无状态（每次请求带全量历史），不做会话粘性/分组。
   * @param {string} model
   */
  async acquireForModel(model) {
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
        // 指针推进到"被选中账号"的下一位：冷却账号被跳过时依然保持公平轮询
        // （若只按 +1 推进，跳过冷却账号会让列表末尾的账号被选中两次）。
        this._rr = (emails.indexOf(email) + 1) % Math.max(emails.length, 1)
        this._recordSuccess(email)
        logger.info('selected account for model', {
          email,
          model,
        })
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
   * 换号/重试选号：
   * - switchAccount（429/5xx/403 账号级故障）→ 冷却当前账号，然后按轮询换下一个账号；
   * - 纯 gate 错误（session_expired/superseded 等）→ 同号强制 re-admit 一次（不冷却），
   *   失败则按轮询换号。
   * @param {string} model
   * @param {{ preferredEmail?: string | null, gateCode?: string | null, retryAfterMs?: number | null, switchAccount?: boolean }} [opts]
   */
  async reacquireAfterGate(model, opts = {}) {
    if (opts.preferredEmail) {
      if (
        opts.switchAccount ||
        (opts.gateCode && SWITCHABLE_CODES.has(opts.gateCode))
      ) {
        this.markCooldown(
          opts.preferredEmail,
          new UpstreamError(opts.gateCode, {
            code: opts.gateCode,
            status: 429,
            retryAfterMs: opts.retryAfterMs ?? 30_000,
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

  /** 代理池变更后调用：释放并重建所有缓存 runtime，让新出口立即生效 */
  async invalidateProxies() {
    const tasks = [...this.byEmail.values()].map((rt) => rt.sessions.shutdown())
    await Promise.allSettled(tasks)
    const count = this.byEmail.size
    this.byEmail.clear()
    logger.info('proxy pool changed; cached runtimes invalidated', { count })
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
