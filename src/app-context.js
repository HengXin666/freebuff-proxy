import {
  resolveCredentialsDir,
  listAccounts,
  readAccountUser,
  accountKeyOf,
  freebuffAuthHeaders,
} from './auth-store.js'
import { createUpstreamClient } from './upstream/client.js'
import { SessionManager } from './session-manager.js'
import { UpstreamError } from './upstream/client.js'
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
 * Multi-account pool. 账号以「account key」标识：
 * key = Freebuff 用户 id（优先），无 id（历史数据）回落邮箱。
 * GitHub / Google 登录同一邮箱但 id 不同 → 两个独立账号，互不覆盖。
 */
export class AccountRuntimes {
  /**
   * @param {import('./config.js').ProxyConfig} config
   */
  constructor(config) {
    this.config = config
    this.dir = resolveCredentialsDir(config)
    /** @type {Map<string, { key: string, email: string, id: string | null, authToken: string, user: any, upstream: any, sessions: SessionManager, source: string }>} */
    this.byKey = new Map()
    /**
     * Cooldown key: account key  (whole account) or key\0model (per-model).
     * @type {Map<string, { until: number, code?: string, model?: string }>}
     */
    this.cooldowns = new Map()
    this._rr = 0
    this._lastSuccessKey = null
    /** Per-account success counters (in-memory, for load-balance visibility). */
    this.stats = { total: 0, byKey: new Map() }
  }

  list() {
    const now = Date.now()
    return listAccounts(this.dir).map((a) => {
      const cd = this.cooldowns.get(a.key)
      const cooling = Boolean(cd && cd.until > now)
      const rt = this.byKey.get(a.key)
      const snap = rt?.sessions?.getSnapshot?.()
      return {
        ...a,
        lastUsed: this._lastSuccessKey === a.key,
        available: !cooling,
        cooldownUntil: cooling ? new Date(cd.until).toISOString() : null,
        cooldownCode: cooling ? cd.code : null,
        requests: this.stats.byKey.get(a.key) || 0,
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
        quota: snap?.quota || null,
      }
    })
  }

  /**
   * @param {string} key 账号 key（id 或历史邮箱）
   */
  get(key) {
    const user = readAccountUser(this.dir, key)
    if (!user?.authToken) {
      throw new UpstreamError(`Account not found or not logged in: ${key}`, {
        status: 401,
        code: 'upstream_auth_missing',
      })
    }
    const accountKey = accountKeyOf(user)

    const existing = this.byKey.get(accountKey)
    if (
      existing &&
      existing.authToken === user.authToken &&
      existing.proxy === (user.proxy || null)
    ) {
      return existing
    }
    if (existing) {
      existing.sessions.shutdown().catch(() => {})
      this.byKey.delete(accountKey)
    }

    const upstream = createUpstreamClient(this.config, user.authToken, {
      proxy: user.proxy || null,
      accountId: accountKey,
    })
    const sessions = new SessionManager({ upstream, config: this.config })
    const runtime = {
      key: accountKey,
      id: user.id || null,
      email: user.email,
      authToken: user.authToken,
      proxy: user.proxy || null,
      /** 实际生效的出网代理（全局池分配 / 账号覆盖 / env） */
      effectiveProxy: upstream.proxyUrl || null,
      user,
      upstream,
      sessions,
      source: `credentials:${accountKey}`,
    }
    this.byKey.set(accountKey, runtime)
    return runtime
  }

  /** 账号 key 列表（id 优先，历史账号为邮箱）。 */
  allKeys() {
    return listAccounts(this.dir).map((a) => a.key)
  }

  _cooldownKey(key, model) {
    return model ? `${key}\0${model}` : key
  }

  /**
   * Account-level OR (if model given) model-level cooldown blocks selection.
   * @param {string} key
   * @param {string | null} [model]
   */
  isCoolingDown(key, model = null) {
    this._pruneCooldown(key)
    if (this.cooldowns.has(key)) return true
    if (model) {
      const k = this._cooldownKey(key, model)
      this._pruneCooldown(k)
      if (this.cooldowns.has(k)) return true
    }
    return false
  }

  _pruneCooldown(key) {
    const cd = this.cooldowns.get(key)
    if (cd && cd.until <= Date.now()) this.cooldowns.delete(key)
  }

  /**
   * @param {string} key
   * @param {import('./upstream/client.js').UpstreamError | { code?: string, retryAfterMs?: number }} err
   * @param {string | null} [model]
   */
  markCooldown(key, err, model = null) {
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
    const k = perModel ? this._cooldownKey(key, model) : key
    const until = Date.now() + Math.min(ms, DAY_MS)
    this.cooldowns.set(k, {
      until,
      code,
      model: perModel ? model : undefined,
    })
    logger.info('account cooling down; will try others', {
      key,
      code,
      until: new Date(until).toISOString(),
      model: perModel ? model : null,
      scope: perModel ? 'model' : 'account',
    })
  }

  clearCooldown(key, model = null) {
    this.cooldowns.delete(key)
    if (model) this.cooldowns.delete(this._cooldownKey(key, model))
  }

  _recordSuccess(key) {
    this.stats.total += 1
    this.stats.byKey.set(key, (this.stats.byKey.get(key) || 0) + 1)
  }

  /**
   * @param {string} model
   */
  candidateKeys(model) {
    const keys = this.allKeys()
    if (!keys.length) return []
    // 强制轮询：每次请求按 第1、第2、第3…个账号轮流分配，
    // 冷却中的账号跳过。上游无状态（每次请求带全量历史），
    // 不做会话粘性/分组，也不做配额加权（否则会打破轮询，把请求吸回同一账号）。
    // 每个账号自己的 free session 仍会在轮到它时被复用，热 session 不丢。
    const start = this._rr % keys.length
    const order = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length]
      if (this.isCoolingDown(key, model)) continue
      order.push(key)
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

    const rows = listAccounts(this.dir)
    const keys = rows.map((r) => r.key)
    if (!keys.length) {
      throw new UpstreamError(
        'No Freebuff accounts. Add one via the web console (账号管理 → 添加账号) or run `npm run login`.',
        { status: 401, code: 'upstream_auth_missing' },
      )
    }
    const emailByKey = new Map(rows.map((r) => [r.key, r.email]))

    const order = this.candidateKeys(model)
    /** @type {Array<{ key: string, email?: string, code?: string, message: string }>} */
    const failures = []

    // 全部账号都在冷却/无可用账号时，把冷却明细带进报错（而不是 "Tried 0"），
    // 让用户一眼看出每个账号冷却到几点、因为什么。
    if (!order.length) {
      for (const key of keys) {
        if (this.isCoolingDown(key, model)) {
          const cd =
            this.cooldowns.get(key) ||
            this.cooldowns.get(this._cooldownKey(key, model))
          failures.push({
            key,
            email: emailByKey.get(key),
            code: cd?.code || 'cooldown',
            message: `cooling down until ${cd ? new Date(cd.until).toISOString() : '?'}`,
          })
        }
      }
    }

    for (const key of order) {
      if (this.isCoolingDown(key, model)) {
        const cd =
          this.cooldowns.get(key) ||
          this.cooldowns.get(this._cooldownKey(key, model))
        failures.push({
          key,
          email: emailByKey.get(key),
          code: cd?.code || 'cooldown',
          message: `cooling down until ${cd ? new Date(cd.until).toISOString() : '?'}`,
        })
        continue
      }

      let rt
      try {
        rt = this.get(key)
      } catch (err) {
        failures.push({
          key,
          email: emailByKey.get(key),
          code: err?.code,
          message: err instanceof Error ? err.message : String(err),
        })
        continue
      }

      try {
        await rt.sessions.ensureSession(model)
        this.clearCooldown(key, model)
        this._lastSuccessKey = key
        // 指针推进到"被选中账号"的下一位：冷却账号被跳过时依然保持公平轮询
        // （若只按 +1 推进，跳过冷却账号会让列表末尾的账号被选中两次）。
        this._rr = (keys.indexOf(key) + 1) % Math.max(keys.length, 1)
        this._recordSuccess(key)
        logger.info('selected account for model', {
          key,
          email: rt.email,
          model,
        })
        return rt
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failures.push({ key, email: emailByKey.get(key), code: err?.code, message })
        const wrap =
          err instanceof UpstreamError
            ? err
            : new UpstreamError(message, { status: 502, code: 'admit_failed' })
        this.markCooldown(key, wrap, model)
        logger.warn('account ensureSession failed; trying next', {
          key,
          email: emailByKey.get(key),
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
   *   noCooldown（如 free_mode_capacity_deferred 瞬时容量）→ 换号但不冷却；
   * - 纯 gate 错误（session_expired/superseded 等）→ 同号强制 re-admit 一次（不冷却），
   *   失败则按轮询换号。
   * @param {string} model
   * @param {{ preferredKey?: string | null, gateCode?: string | null, retryAfterMs?: number | null, switchAccount?: boolean, noCooldown?: boolean }} [opts]
   */
  async reacquireAfterGate(model, opts = {}) {
    if (opts.preferredKey) {
      if (
        opts.switchAccount ||
        (opts.gateCode && SWITCHABLE_CODES.has(opts.gateCode))
      ) {
        if (!opts.noCooldown) {
          this.markCooldown(
            opts.preferredKey,
            new UpstreamError(opts.gateCode, {
              code: opts.gateCode,
              status: 429,
              retryAfterMs: opts.retryAfterMs ?? 30_000,
            }),
            model,
          )
        }
      } else {
        try {
          const rt = this.get(opts.preferredKey)
          await rt.sessions.forceReadmit(model)
          this.clearCooldown(opts.preferredKey, model)
          this._lastSuccessKey = opts.preferredKey
          return rt
        } catch (err) {
          const wrap =
            err instanceof UpstreamError
              ? err
              : new UpstreamError(String(err), { code: 'admit_failed' })
          this.markCooldown(opts.preferredKey, wrap, model)
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
    const keys = this.allKeys()
    if (!keys.length) {
      throw new UpstreamError(
        'No Freebuff accounts. Run `npm run login` (saves credentials/<key>.json).',
        { status: 401, code: 'upstream_auth_missing' },
      )
    }
    const preferred = this._lastSuccessKey || keys[0]
    return this.get(preferred)
  }

  /**
   * 丢弃单个账号的缓存 runtime（删除/改代理后调用，让新状态立即生效）。
   * @param {string} key
   */
  async invalidate(key) {
    const rt = this.byKey.get(key)
    if (!rt) return
    try {
      await rt.sessions.shutdown()
    } catch {
      // ignore
    }
    this.byKey.delete(key)
  }

  /** 代理池变更后调用：释放并重建所有缓存 runtime，让新出口立即生效 */
  async invalidateProxies() {
    const tasks = [...this.byKey.values()].map((rt) => rt.sessions.shutdown())
    await Promise.allSettled(tasks)
    const count = this.byKey.size
    this.byKey.clear()
    logger.info('proxy pool changed; cached runtimes invalidated', { count })
  }

  async shutdown() {
    const tasks = [...this.byKey.values()].map((rt) => rt.sessions.shutdown())
    await Promise.allSettled(tasks)
    this.byKey.clear()
  }
}

/**
 * @param {import('./config.js').ProxyConfig} config
 */
export function buildAppContext(config) {
  const runtimes = new AccountRuntimes(config)
  const keys = runtimes.allKeys()
  if (!keys.length) {
    // Zero-account startup is allowed: the web console can add Freebuff
    // accounts later. Runtime endpoints report 401 until one exists.
    return {
      config,
      dir: runtimes.dir,
      runtimes,
      authToken: null,
      authSource: null,
      authEmail: null,
      authKey: null,
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
    authKey: current.key,
    upstream: current.upstream,
    sessions: current.sessions,
  }
}

export { freebuffAuthHeaders }
