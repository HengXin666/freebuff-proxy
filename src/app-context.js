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
 * 账号级 chat 并发信号量（公平 FIFO + 有界等待）：
 * 默认容量 1（一个账号同一时间只处理一个 chat，避免上游会话不稳定时
 * 并发互相干扰/顶号）；可在控制台「负载均衡」调大（一个账号可同时
 * 转发多个 SSE 响应流，实测同一 instanceId 支持并发 chat）。
 * timeoutMs=0 表示无限等待；持锁者受 streamIdleTimeoutSec / 各 HTTP 阶段
 * 超时约束，无限等待在实际运行中是有上界的。
 */
class ChatMutex {
  /**
   * @param {number} [capacity] 同一账号最大并发 chat 数（>=1）
   */
  constructor(capacity = 1) {
    this._capacity = Math.max(1, Math.floor(capacity) || 1)
    /** 当前在途 chat 数（含已授予的等待者）。 */
    this._held = 0
    /** @type {Array<{resolve: Function, reject: Function, timer: NodeJS.Timeout | null}>} */
    this._queue = []
  }

  /** 是否已达到并发上限（不再有可用槽位）。 */
  get busy() {
    return this._held >= this._capacity
  }

  /** 当前在途 chat 数（监控用）。 */
  get inFlight() {
    return this._held
  }

  /** 当前并发上限（监控用）。 */
  get capacity() {
    return this._capacity
  }

  /**
   * 动态调整并发上限（控制台保存后立即生效）。已授予的在途不受影响；
   * 调大时立即把空出的槽位授予排队的等待者。
   * @param {number} n
   */
  setCapacity(n) {
    const next = Math.max(1, Math.floor(n) || 1)
    if (next === this._capacity) return
    this._capacity = next
    while (this._queue.length && this._held < this._capacity) {
      const entry = this._queue.shift()
      if (entry.timer) clearTimeout(entry.timer)
      this._held += 1
      entry.resolve(this._makeRelease())
    }
  }

  /**
   * @param {number} timeoutMs 0 = 无限等待
   * @returns {Promise<() => void>} 释放函数
   */
  acquire(timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const idx = this._queue.indexOf(entry)
          if (idx >= 0) this._queue.splice(idx, 1)
          reject(
            new UpstreamError('account busy; timed out waiting for chat slot', {
              status: 429,
              code: 'account_busy',
            }),
          )
        }, timeoutMs)
        if (entry.timer.unref) entry.timer.unref()
      }
      if (this._held < this._capacity) {
        this._held += 1
        if (entry.timer) clearTimeout(entry.timer)
        resolve(this._makeRelease())
      } else {
        this._queue.push(entry)
      }
    })
  }

  /**
   * 全部断开重连时调用：清空在途计数并立即放行所有排队等待者
   * （等待者会在 chat 流程里重新检查 session 并 re-admit，不会卡死）。
   */
  reset() {
    this._held = 0
    while (this._queue.length) {
      const entry = this._queue.shift()
      if (entry.timer) clearTimeout(entry.timer)
      this._held += 1
      entry.resolve(this._makeRelease())
    }
  }

  _makeRelease() {
    let released = false
    return () => {
      if (released) return
      released = true
      this._held = Math.max(0, this._held - 1)
      while (this._queue.length && this._held < this._capacity) {
        const next = this._queue.shift()
        if (next.timer) clearTimeout(next.timer)
        this._held += 1
        next.resolve(this._makeRelease())
      }
    }
  }
}

/**
 * Multi-account pool. 账号以「account key」标识：
 * key = Freebuff 用户 id（优先），无 id（历史数据）回落邮箱。
 * GitHub / Google 登录同一邮箱但 id 不同 → 两个独立账号，互不覆盖。
 */
export class AccountRuntimes {
  /**
   * @param {import('./config.js').ProxyConfig} config
   * @param {{ getAccountConcurrency?: () => number, getSpreadAccounts?: () => number, getCustomModels?: () => { id: string, pool?: string, agentId?: string, fallbackAgentId?: string, displayName?: string, multimodal?: boolean, note?: string }[] }} [opts]
   *   getAccountConcurrency: 每个账号的并发上限来源（控制台设置/配置），
   *   默认取 config.limits.accountMaxConcurrency。
   *   getSpreadAccounts: 平摊请求的账号数上限（控制台「负载均衡设置」可调，
   *   默认 3）：并发请求最多同时铺开 N 个账号——先账号间负载均衡（未满开新
   *   账号消费会话），再账号内负载均衡（单账号最多 accountMaxConcurrency）。
   *   getCustomModels: 前端「模型管理」的自定义模型列表（覆盖内置目录），
   *   影响 agent id 解析。
   */
  constructor(config, opts = {}) {
    this.config = config
    this.dir = resolveCredentialsDir(config)
    this._getAccountConcurrency =
      typeof opts.getAccountConcurrency === 'function'
        ? opts.getAccountConcurrency
        : () => this.config.limits.accountMaxConcurrency || 1
    this._getSpreadAccounts =
      typeof opts.getSpreadAccounts === 'function'
        ? opts.getSpreadAccounts
        : () => 3
    this._getCustomModels =
      typeof opts.getCustomModels === 'function'
        ? opts.getCustomModels
        : () => []
    /** @type {Map<string, { key: string, email: string, id: string | null, authToken: string, user: any, upstream: any, sessions: SessionManager, source: string }>} */
    this.byKey = new Map()
    /**
     * Cooldown key: account key  (whole account) or key\0model (per-model).
     * @type {Map<string, { until: number, code?: string, model?: string }>}
     */
    this.cooldowns = new Map()
    this._rr = 0
    /** Serialize account selection + session admission on cold start. */
    this._acquireMutex = Promise.resolve()
    /** 账号级 chat 串行化锁（key → ChatMutex），跨 runtime 重建保持同一账号互斥。 */
    this.chatLocks = new Map()
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
      const chatLock = this.chatLocks.get(a.key)
      return {
        ...a,
        lastUsed: this._lastSuccessKey === a.key,
        available: !cooling,
        cooldownUntil: cooling ? new Date(cd.until).toISOString() : null,
        cooldownCode: cooling ? cd.code : null,
        requests: this.stats.byKey.get(a.key) || 0,
        // 负载均衡监控：当前在途 SSE 流数 / 账号并发上限
        inFlight: chatLock?.inFlight || 0,
        concurrency: chatLock?.capacity || this._accountConcurrency(),
        effectiveProxy: rt?.effectiveProxy || null,
        // 最近一次探测（refresh GET / probe）结果：让控制台展示"为什么刷新失败"
        // （country_blocked 强风控 / rate_limited / banned / 凭证无效…）
        lastProbe: snap?.lastProbe || null,
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
      // 账号信息变更（token/代理）：旧 runtime 立即让位，session 等在途
      // 请求结束后再优雅释放（避免掐断正在传输的 SSE；等待方会在 chat
      // 流程通过 isCurrentRuntime 检测到已被顶替并重新选号）。
      existing.sessions.releaseWhenIdle().catch(() => {})
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

  /** 每个账号的当前并发上限（控制台设置，实时生效）。 */
  _accountConcurrency() {
    const n = this._getAccountConcurrency()
    return Number.isFinite(n) && n >= 1 ? Math.min(16, Math.floor(n)) : 1
  }

  /** 平摊请求的账号数上限（控制台设置，实时生效）：1..账号数。 */
  _spreadAccounts() {
    const n = this._getSpreadAccounts()
    const total = this.allKeys().length
    if (!Number.isFinite(n) || n < 1) return Math.min(3, Math.max(1, total))
    return Math.min(Math.floor(n), Math.max(1, total))
  }

  chatLockFor(key) {
    let lock = this.chatLocks.get(key)
    if (!lock) {
      lock = new ChatMutex(this._accountConcurrency())
      this.chatLocks.set(key, lock)
    } else {
      lock.setCapacity(this._accountConcurrency())
    }
    return lock
  }

  /** 账号当前是否已达到并发上限（无可用 chat 槽位）。 */
  isChatBusy(key) {
    return this.chatLocks.get(key)?.busy || false
  }

  /** 账号当前在途 chat 数（监控用）。 */
  chatInFlight(key) {
    return this.chatLocks.get(key)?.inFlight || 0
  }

  /**
   * 获取账号的 chat 并发槽位。
   * @param {string} key
   * @param {number} timeoutMs 0 = 无限等待
   * @returns {Promise<() => void>}
   */
  acquireChat(key, timeoutMs) {
    return this.chatLockFor(key).acquire(timeoutMs)
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

  async _withAcquireLock(fn) {
    let release
    const wait = new Promise((resolve) => {
      release = resolve
    })
    const prev = this._acquireMutex
    this._acquireMutex = prev.then(() => wait)
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * @param {string} model
   */
  candidateKeys(model) {
    const keys = this.allKeys()
    if (!keys.length) return []

    // 平摊请求调度（所有模型统一）：
    // 1. 先账号间负载均衡：账号并发没满时，新请求可以直接开新账号消费一个会话
    //    （而不是钉在已有账号上排队）——并发请求平摊到最多 `spreadAccounts` 个账号。
    // 2. 再账号内负载均衡：同一账号内最多 `accountMaxConcurrency` 个并发会话，
    //    满了必须开新账号。
    // 排序核心：未满员账号 > 满员账号；未满员里优先热 session 复用（省 admit），
    // 但还没达到平摊上限时优先开新账号；满员账号永远排最后。
    const spreadLimit = this._spreadAccounts()
    const start = this._rr % keys.length
    const candidates = []
    // 当前有活跃会话/在途的账号数（决定是否还可以开新账号平摊）
    let activeAccounts = 0
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length]
      if (this.isCoolingDown(key, model)) continue
      const sessions = this.byKey.get(key)?.sessions
      const snap = sessions?.getSnapshot?.()
      const hasLive = snap?.instanceId != null
      if (hasLive) activeAccounts++
    }
    if (process.env.FB_DEBUG_SCHED) {
      console.error(`[sched] model=${model} activeAccounts=${activeAccounts}/${spreadLimit} keys=${keys.join(',')}`)
    }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length]
      if (this.isCoolingDown(key, model)) continue
      const sessions = this.byKey.get(key)?.sessions
      const usable = sessions?.isUsableForModel?.(model) === true
      const live = sessions?.hasLiveSlot?.() === true
      const snap = sessions?.getSnapshot?.()
      const hasLive = snap?.instanceId != null
      const quota = snap?.quota?.byModel?.[model]
      const exhausted =
        !usable &&
        quota &&
        Number.isFinite(quota.limit) &&
        quota.limit > 0 &&
        (Number(quota.recentCount) || 0) >= quota.limit
      const chatLock = this.chatLocks.get(key)
      const inFlight = chatLock?.inFlight || 0
      const capacity = chatLock?.capacity || this._accountConcurrency()
      const sameModel = snap?.model === model
      // 同模型即将过期（live 但不可复用）且正被在途流占用：re-admit 必须等
      // 流结束（见 SessionManager.ensureSession），有账号空闲时不应让新请求
      // 干等——把它降为最后梯队，只有没有空闲账号时才等它续期。
      const busyNearExpiry =
        live &&
        sameModel &&
        !usable &&
        (sessions?.inFlightCount?.() || 0) > 0
      // 未满员账号：负载均衡第一层——账号间平摊。
      //   spreadReady = 还可以开新账号（活跃账号数 < 平摊上限）且本账号冷
      //   （无活跃会话）→ 最高优先：把并发平摊到新账号
      //   usable = 有同模型热 session → 优先复用（省 admit、保持出口稳定）
      //   否则冷账号排前面，让请求分散
      const canOpen = activeAccounts < spreadLimit && !hasLive
      if (process.env.FB_DEBUG_SCHED) {
        console.error(`[sched]   ${key} hasLive=${hasLive} usable=${usable} busy=${inFlight >= capacity} inFlight=${inFlight} canOpen=${canOpen}`)
      }
      candidates.push({
        key,
        busy: inFlight >= capacity ? 1 : 0,
        // 冷账号且还可平摊：最高优先（开新账号消费会话）
        open: canOpen ? 1 : 0,
        // 有热 session 的排前面（复用省 admit）；同模型续期次之
        tier: usable ? 0 : live && !sameModel ? 2 : busyNearExpiry ? 2 : 1,
        sameModel: sameModel ? 1 : 0,
        load: inFlight,
        exhausted: exhausted ? 1 : 0,
        rotation: i,
      })
    }
    candidates.sort(
      (a, b) =>
        // 并发已满的账号排最后（核心）：单账号在途 >= 上限时，新请求优先去
        // 有空闲槽位的账号，而不是继续钉在满员账号上排队。
        a.busy - b.busy ||
        // 还能开新账号（未达平摊上限）的账号最优先——账号间负载均衡：
        // 并发请求先铺满 N 个账号（每账号一个会话），绝不钉在第一个账号上
        // （即使它有热 session）；只有活跃账号数 >= 平摊上限时才降级为复用。
        b.open - a.open ||
        // 未满员里：热 session → 同模型续期 → 冷账号 → 在途少 → 轮询
        a.tier - b.tier ||
        b.sameModel - a.sameModel ||
        a.load - b.load ||
        a.exhausted - b.exhausted ||
        a.rotation - b.rotation,
    )
    if (process.env.FB_DEBUG_SCHED) {
      console.error(`[sched]   order: ${candidates.map((c) => c.key).join(',')}`)
    }
    return candidates.map((item) => item.key)
  }

  /**
   * Prefer a reusable same-model session; cold accounts and model replacement
   * are fallbacks; round-robin only breaks ties within those groups.
   * 并发满员（在途 >= 账号并发上限）的账号永远排最后——上限即"满了换号"的阈值。
   * @param {string} model
   */
  async acquireForModel(model) {
    return this._withAcquireLock(() => this._acquireForModelUnlocked(model))
  }

  async _acquireForModelUnlocked(model) {
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
        const reusedSession = rt.sessions.isUsableForModel(model)
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
          reusedSession,
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
   * - switchAccount（429/5xx/403 账号级故障）→ 冷却当前账号，然后换下一个账号；
   *   noCooldown（如 free_mode_capacity_deferred 瞬时容量）→ 不冷却，优先复用热 session；
   * - 纯 gate 错误（session_expired/superseded 等）→ 同号强制 re-admit 一次（不冷却），
   *   失败则换号。
   * @param {string} model
   * @param {{ preferredKey?: string | null, gateCode?: string | null, retryAfterMs?: number | null, switchAccount?: boolean, noCooldown?: boolean }} [opts]
   */
  async reacquireAfterGate(model, opts = {}) {
    return this._withAcquireLock(() =>
      this._reacquireAfterGateUnlocked(model, opts),
    )
  }

  async _reacquireAfterGateUnlocked(model, opts = {}) {
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
        } else if (opts.switchAccount) {
          // noCooldown 且 switchAccount（free_mode_capacity_deferred /
          // account_busy / runtime_superseded）：**不是真故障**。
          // 分两种情况：
          // 1) account_busy / runtime_superseded：调用方（chat 流程）**未持有**
          //    原账号的锁（acquire 超时 / 已被顶替），此时 busy 判断是准确的
          //    ——原账号在途已满时不再把它钉住，走全新选号让有空闲槽位的账号
          //    承接（并发上限即"满了换号"的阈值，见 candidateKeys）。
          // 2) 其他瞬时 gate（capacity_deferred 等）：调用方**仍持有**原账号的
          //    锁，busy 是"自己在用自己"造成的误判——session 仍可复用时直接
          //    复用，不为瞬时容量无谓新建计费 session。
          try {
            const rt = this.get(opts.preferredKey)
            const callerHoldsLock =
              opts.gateCode !== 'account_busy' &&
              opts.gateCode !== 'runtime_superseded'
            if (
              rt.sessions.isUsableForModel(model) &&
              (callerHoldsLock || !this.isChatBusy(opts.preferredKey))
            ) {
              this.clearCooldown(opts.preferredKey, model)
              this._lastSuccessKey = opts.preferredKey
              return rt
            }
          } catch {
            // 账号已不可用（凭据变更等）→ 走全新选号
          }
        }
      } else {
        try {
          // 同账号 gate 重试时，调用方（chat 流程）已持有该账号的串行化锁，
          // 不会与另一个在途 chat 冲突，可直接 forceReadmit。
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
    return this._acquireForModelUnlocked(model)
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
   * 该 runtime 是否仍是该账号当前缓存的 runtime。
   * 代理/账号信息切换后旧 runtime 会被顶替（byKey 指向新 runtime），
   * chat 流程借此识别"排队等锁期间已被切换"的请求并重新选号，
   * 而不是拿着旧出口的 runtime 去撞已被释放的旧 session。
   * @param {{ key: string }} rt
   */
  isCurrentRuntime(rt) {
    return this.byKey.get(rt.key) === rt
  }

  /**
   * 丢弃单个账号的缓存 runtime（删除/改代理后调用，让新状态立即生效）。
   * 立即让位（新请求走新 runtime），旧 session 等在途 SSE 结束后优雅释放，
   * 避免把正在传输的连接掐断。
   * @param {string} key
   */
  async invalidate(key) {
    const rt = this.byKey.get(key)
    if (!rt) return
    this.byKey.delete(key)
    rt.sessions.releaseWhenIdle().catch((err) => {
      logger.warn('account invalidated; deferred session release failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * 全部断开重连（比重启更轻量）：释放所有账号的 session（清理死任务），
   * 并重置账号并发信号量（放行等待者，等待者会在 chat 流程重新 re-admit）。
   * 不重启进程；下一个请求自动 admit 全新 session。
   * @returns {Promise<Array<{key: string, email?: string, ok: boolean, error?: string}>>}
   */
  async reconnectAll() {
    // 并发信号量与 runtime 的并集：无账号凭据的锁（如单元测试）也要重置
    const keys = [...new Set([...this.chatLocks.keys(), ...this.byKey.keys()])]
    const results = await Promise.all(
      keys.map(async (key) => {
        const rt = this.byKey.get(key)
        try {
          if (rt) await rt.sessions.release()
          // 信号量重置：清空在途计数并放行排队等待者（等待者会在 chat
          // 流程重新检查 session 并 re-admit，不会卡死）
          this.chatLocks.get(key)?.reset()
          return { key, email: rt?.email, ok: true }
        } catch (err) {
          return {
            key,
            email: rt?.email,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )
    logger.info('all sessions disconnected via web console', {
      accounts: keys.length,
      ok: results.filter((r) => r.ok).length,
    })
    return results
  }

  /**
   * 代理池变更后调用：立即重建所有缓存 runtime（新出口对新请求生效），
   * 旧 runtime 的 session 等在途 SSE 结束后在后台优雅释放——不再像以前
   * 那样直接 DELETE，避免把正在传输的流掐断导致客户端永久卡住。
   */
  async invalidateProxies() {
    const oldRuntimes = [...this.byKey.values()]
    this.byKey.clear()
    for (const rt of oldRuntimes) {
      rt.sessions.releaseWhenIdle().catch((err) => {
        logger.warn('proxy pool changed; deferred session release failed', {
          key: rt.key,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    logger.info('proxy pool changed; cached runtimes invalidated', {
      count: oldRuntimes.length,
    })
  }

  async shutdown() {
    const tasks = [...this.byKey.values()].map((rt) => rt.sessions.shutdown())
    await Promise.allSettled(tasks)
    this.byKey.clear()
  }
}

/**
 * @param {import('./config.js').ProxyConfig} config
 * @param {{ getAccountConcurrency?: () => number, getSpreadFreeModels?: () => boolean, getCustomModels?: () => { id: string, pool?: string, agentId?: string, fallbackAgentId?: string, displayName?: string, multimodal?: boolean, note?: string }[] }} [opts] 透传给 AccountRuntimes
 */
export function buildAppContext(config, opts = {}) {
  const runtimes = new AccountRuntimes(config, opts)
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
