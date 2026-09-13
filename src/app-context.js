import path from 'node:path'
import fs from 'node:fs'
import {
  resolveCredentialsDir,
  listAccounts,
  readAccountUser,
  accountKeyOf,
  accountCredentialsPath,
  freebuffAuthHeaders,
} from './auth-store.js'
import { createUpstreamClient } from './upstream/client.js'
import { SessionManager } from './session-manager.js'
import { SessionHandleStore } from './session-handles.js'
import { AccountStateStore } from './account-state-store.js'
import { UpstreamError, isSessionRecoverableGate } from './upstream/client.js'
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

  /** 排队等待槽位的请求数（监控/空闲释放判断用）。 */
  get queued() {
    return this._queue.length
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
   * @param {{ getAccountConcurrency?: () => number, getSessionSettings?: () => { idleReleaseSec?: number, maxNewSessionsPerRequest?: number } | null, getCustomModels?: () => { id: string, pool?: string, agentId?: string, fallbackAgentId?: string, displayName?: string, multimodal?: boolean, note?: string }[] }} [opts]
   *   getAccountConcurrency: 每个账号的并发上限来源（控制台设置/配置），
   *   默认取 config.limits.accountMaxConcurrency。账号调度是"粘性优先"：
   *   并发请求先挤同一账号（上限即溢出阈值），不主动平摊到新账号。
   *   getCustomModels: 前端「模型管理」的自定义模型列表（覆盖内置目录），
   *   影响 agent id 解析。
   */
  constructor(config, opts = {}) {
    this.config = config
    this.dir = resolveCredentialsDir(config)
    /**
     * 上游会话句柄的持久化索引（/data/sessions.json）：admit/释放都落盘，
     * 进程退出/换容器后仍能凭 instanceId 去 DELETE 退款；释放失败的句柄也
     * 留在这里等下次清理（绝不丢 = 绝不留下无法寻址的计费孤儿）。
     */
    this.handleStore = new SessionHandleStore(resolveSessionIndexPath(config))
    /**
     * 账号运行状态的持久化账本（/data/account-state.json）：加入/封禁时间、
     * 请求数、最近使用、冷却、Freebucks 余额与单价、每日额度、最近探测结果。
     * 这些原本只在内存里，一次重启就全丢——重启后控制台分不出"干净的未用号"
     * 和"已经打废的号"，且 freebucks 归零会让"买不起就别 admit"的闸门失效。
     */
    this.accountState = new AccountStateStore(resolveAccountStatePath(config))
    this._getAccountConcurrency =
      typeof opts.getAccountConcurrency === 'function'
        ? opts.getAccountConcurrency
        : () => this.config.limits.accountMaxConcurrency || 1
    this._getCustomModels =
      typeof opts.getCustomModels === 'function'
        ? opts.getCustomModels
        : () => []
    /**
     * 前端「额度保护」设置来源（settings.json，实时生效）：
     * idleReleaseSec / maxNewSessionsPerRequest。缺省回落 config.yaml。
     */
    this._getSessionSettings =
      typeof opts.getSessionSettings === 'function'
        ? opts.getSessionSettings
        : () => null
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
    /**
     * 每个账号最近一次被选中/成功的时间戳（粘性调度的核心输入）：
     * 优先继续用刚用过的账号，而不是轮换到下一个健康账号。
     * @type {Map<string, number>}
     */
    this._lastUsedAt = new Map()
    // 必须在**所有**上述容器（cooldowns/stats/_lastUsedAt）初始化之后回灌，
    // 否则账本里存着的计数/冷却没有地方放（早先放在构造函数开头，smoke 直接
    // 以 "Cannot read properties of undefined" 抓到）。
    this._restoreAccountState()
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
        // 账号生命周期（持久化账本）：加入时间 / 封禁时间。重启后仍在，
        // 控制台据此区分"从未使用过 / 正在调度 / 额度不足 / 已被封禁"。
        firstSeenAt:
          this.accountState.account(a.key, this._importedAtHint(a.key))
            ?.firstSeenAt || null,
        bannedAt: this.accountState.account(a.key)?.bannedAt || null,
        // 退款流水（最近 100 条）+ 累计对账：回答"退款到底成没成功、金额对不对"
        refunds: this.accountState.refunds(a.key).slice(0, 20),
        refundTotal: this.accountState.account(a.key)?.refundTotal ?? 0,
        refundExpectedTotal:
          this.accountState.account(a.key)?.refundExpectedTotal ?? 0,
        refundPendingCount:
          this.accountState.account(a.key)?.refundPendingCount ?? 0,
        // 是否被使用过（粘性调度：未用过的账号排最后启用）+ 最近使用时间
        used: this.everUsed(a.key),
        lastUsedAt: this._lastUsedAt.has(a.key)
          ? new Date(this._lastUsedAt.get(a.key)).toISOString()
          : null,
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
        // Freebucks 计量（2026-09 改版）：余额 / 每日池 / 每模型 session 单价。
        // 控制台据此显示"这个号还剩多少、这个模型一次多少钱"。
        freebucks: snap?.freebucks || null,
        // 最近一次早退 DELETE 的退款回执（空闲释放/换号释放都会产生）
        lastRefund: snap?.lastRefund || null,
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
    const sessions = new SessionManager({
      upstream,
      config: this.config,
      accountKey,
      // 句柄变更落盘（track/clear/orphan）——见 SessionHandleStore。
      onSessionChange: (ev) => this.handleStore.handleEvent(ev),
      // 账号账目落盘（freebucks/quota/lastProbe）——见 AccountStateStore。
      onStateChange: (snap) => this._persistAccountState(accountKey, snap),
      getSessionSettings: this._getSessionSettings,
      // 该账号还有在途/排队的 chat 时，空闲释放让路（见 SessionManager._armIdleRelease）
      hasPendingUser: () => {
        const lock = this.chatLocks.get(accountKey)
        return Boolean(lock && (lock.inFlight > 0 || lock.queued > 0))
      },
    })
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
    // 账本回灌（freebucks/quota/lastProbe/冷却）：必须在这里做，不能只在构造
    // 函数里做——runtime 是**懒创建**的，构造函数执行时 byKey 还是空的。
    // freebucks 尤其关键：它让"余额买不起就别 admit"的闸门在重启后依然生效。
    this._hydrateRuntime(runtime)
    this.accountState.patch(accountKey, { email: user.email })
    return runtime
  }

  /**
   * 把账本里某账号的状态灌回它的 runtime（懒创建时调用）+ 内存冷却表。
   * @param {{ key: string, sessions: import('./session-manager.js').SessionManager, email?: string }} runtime
   */
  _hydrateRuntime(runtime) {
    const key = runtime?.key
    const rec = key
      ? this.accountState.account(key, this._importedAtHint(key))
      : null
    if (!rec || !runtime?.sessions) return
    const s = runtime.sessions
    if (rec.freebucks && typeof rec.freebucks === 'object') {
      s.freebucks = rec.freebucks
    }
    if (rec.quota && typeof rec.quota === 'object') s.quota = rec.quota
    if (rec.lastProbe && typeof rec.lastProbe === 'object') {
      s.lastProbe = rec.lastProbe
    }
    const cds = rec.cooldowns
    if (cds && typeof cds === 'object') {
      const now = Date.now()
      const prefix = `${key}\0`
      for (const [k, cd] of Object.entries(cds)) {
        // 必须精确匹配账号 key 或 `key\0model`：用 startsWith(key) 会让账号
        // "ab" 的冷却灌进账号 "a"（前缀撞车，单字符 key 的测试测不出来）。
        if (k !== key && !k.startsWith(prefix)) continue
        const until = Number(cd?.until)
        // 过期的冷却直接丢：重启不该把号永久锁死。
        if (!Number.isFinite(until) || until <= now) continue
        this.cooldowns.set(k, { until, code: cd.code ?? null, model: cd.model })
      }
    }
  }

  /**
   * "这个号什么时候进来的"——取凭据文件的创建时间（birthtime，回退 mtime）。
   * 为什么不直接用"账本第一次看到它"：老账号升级到本账本时会被记成今天刚
   * 加入，控制台的"从未使用 / 老号"分区就全错了。
   * @param {string} key
   * @returns {string | null}
   */
  _importedAtHint(key) {
    try {
      const p = accountCredentialsPath(this.dir, key)
      const st = fs.statSync(p)
      const t = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
      return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null
    } catch {
      return null
    }
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
      // 封禁是账号生命周期的终点：不只冷却，还要记下"什么时候开始被封的"
      // （chat 阶段撞到 banned 与探测发现 banned 同等重要，控制台分区靠它）。
      const rec = this.accountState.account(key, this._importedAtHint(key))
      if (rec && !rec.bannedAt) {
        this.accountState.patch(key, { bannedAt: new Date().toISOString() })
      }
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
    this._persistCooldowns(key)
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
    this._persistCooldowns(key)
  }

  /**
   * 更新"最后成功账号"（粘性调度核心输入）并落盘。
   * 集中一处：原先有 4 个赋值点，只有 1 个写了账本，重启后粘性就跑了。
   * @param {string} key
   */
  _setLastSuccessKey(key) {
    if (!key) return
    this._lastSuccessKey = key
    this.accountState.state.lastSuccessKey = key
    this.accountState.touch()
  }

  _recordSuccess(key) {
    this.stats.total += 1
    this.stats.byKey.set(key, (this.stats.byKey.get(key) || 0) + 1)
    this._lastUsedAt.set(key, Date.now())
    // 请求计数/最近使用落盘：重启后「用过没有 / 最近什么时候用的」不该归零，
    // 否则粘性调度会把已经打过废的账号当成全新账号重新启用一遍。
    this.accountState.patch(key, {
      requests: this.stats.byKey.get(key) || 0,
      lastUsedAt: new Date(this._lastUsedAt.get(key)).toISOString(),
    })
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
   * 选号排序（2026-09 Freebucks 改版 + 参考项目 ADR-0012 反封控契约）：
   *
   * **粘性优先 / drain, not rotate**——把请求集中到尽可能少的账号上，用尽
   * （限流 / 额度耗尽 / 冷却 / 满员排队超时）才换下一个；**从未用过的账号
   * 排最后**，只有已用账号都不可用时才启用。上游把"轮换健康账号"直接当作
   * 账号农场特征（ADR-0012: cycling healthy keys looks like account farming），
   * 而 Freebucks 按会话占用时长计费，换号 = 新买一条计费行。
   *
   * 排序维度（从前到后）：
   *   1. tier（会话状态）：同模型热 session（复用零成本）> 冷账号 > 活跃 session
   *      绑在别的模型上（换模型要释放它）。冷账号优先于"杀掉另一个模型的热会话"，
   *      否则多模型交替会在同一账号上反复 release/admit（每次都买一条计费会话）；
   *   2. used：同一 tier 内**已用过的账号 > 从未用过的账号**（不轻易碰新账号）；
   *   3. busy：优先有空闲槽位的。满员账号**不再一律排最后**——它只要属于已用账号，
   *      仍排在"从未用过的账号"之前，新请求会在它上面做一次有界排队（省一条计费
   *      会话），超时后由 proxy.js 加进 skipKeys 才真正溢出；
   *   4. lastUsedAt 倒序（粘性：优先继续用刚用过的那个）；
   *   5. 在途少 > 额度耗尽 > 余额不足 > 轮询（平局打破）。
   * @param {string} model
   * @param {{ skipKeys?: Set<string> }} [opts] skipKeys：本次请求已经排队超时过的
   *   账号，不再重复选中（否则会一直排在第一位反复等）。
   */
  candidateKeys(model, opts = {}) {
    const keys = this.allKeys()
    if (!keys.length) return []
    const skip = opts.skipKeys instanceof Set ? opts.skipKeys : null
    const start = this._rr % keys.length
    const candidates = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length]
      if (skip?.has(key)) continue
      if (this.isCoolingDown(key, model)) continue
      const sessions = this.byKey.get(key)?.sessions
      const usable = sessions?.isUsableForModel?.(model) === true
      const snap = sessions?.getSnapshot?.()
      const quota = snap?.quota?.byModel?.[model]
      const exhausted =
        !usable &&
        quota &&
        Number.isFinite(quota.limit) &&
        quota.limit > 0 &&
        (Number(quota.recentCount) || 0) >= quota.limit
      const live = sessions?.hasLiveSlot?.() === true
      const sameModel = snap?.model === model
      const chatLock = this.chatLocks.get(key)
      const inFlight = chatLock?.inFlight || 0
      const capacity = chatLock?.capacity || this._accountConcurrency()
      // Freebucks 余额买不起该模型（balance < prices[model]）→ 排到最后：
      // 调度不会为了它白开一条计费 session（上游反正也会 429）。
      const fbInfo = sessions?.freebucksFor?.(model)
      const unaffordable = fbInfo?.known && fbInfo.affordable === false ? 1 : 0
      const used = this.everUsed(key, sessions)
      // tier 按"会话状态"分（与 used 无关）：
      //   0 = 同模型热 session（复用零成本）
      //   1 = 冷账号（没有活跃会话）或同模型即将过期
      //   2 = 活跃 session 绑在别的模型上（换模型要释放它）
      // 先按 tier 排：冷账号优先于"杀掉另一个模型的热会话"——否则多模型
      // 交替使用会在同一个账号上反复 release/admit（每次都是一条计费会话）。
      const otherModelLive = live && sameModel === false
      const busyNearExpiry =
        live && sameModel && !usable && (sessions?.inFlightCount?.() || 0) > 0
      const tier = usable ? 0 : otherModelLive || busyNearExpiry ? 2 : 1
      if (process.env.FB_DEBUG_SCHED) {
        console.error(
          `[sched]   ${key} tier=${tier} used=${used} usable=${usable} inFlight=${inFlight}/${capacity}`,
        )
      }
      candidates.push({
        key,
        tier,
        // 已用过的账号优先于从未用过的（同一 tier 内）——"最少换号"的核心
        used: used ? 0 : 1,
        busy: inFlight >= capacity ? 1 : 0,
        lastUsedAt: this._lastUsedAt.get(key) || 0,
        load: inFlight,
        exhausted: exhausted ? 1 : 0,
        unaffordable,
        rotation: i,
      })
    }
    candidates.sort(
      (a, b) =>
        // 1) 同模型热 session > 冷账号 > 别的模型占着（避免模型交替时反复
        //    release/admit 同一个账号）
        a.tier - b.tier ||
        // 2) 同一梯队里：已用过的账号 > 从未用过的账号（不轻易碰新账号）
        a.used - b.used ||
        // 3) 优先有空闲槽位的账号
        a.busy - b.busy ||
        // 粘性：优先继续用最近用过的那个账号
        b.lastUsedAt - a.lastUsedAt ||
        a.load - b.load ||
        a.exhausted - b.exhausted ||
        // 余额买不起的账号排最后（复用它的热 session 仍然优先——不计费）
        a.unaffordable - b.unaffordable ||
        a.rotation - b.rotation,
    )
    if (process.env.FB_DEBUG_SCHED) {
      console.error(
        `[sched] model=${model} order: ${candidates.map((c) => `${c.key}#${c.tier}`).join(',')}`,
      )
    }
    return candidates.map((item) => item.key)
  }

  /**
   * 该账号是否"被使用过"：有过 admit / 有活跃 session / 发过请求。
   * 从未用过的账号在选号里排最后——只在已用账号都不可用（冷却/额度耗尽/
   * 满员排队超时）时才启用，避免把每个账号都摸一遍（账号农场特征）。
   * @param {string} key
   * @param {import('./session-manager.js').SessionManager} [sessions]
   */
  everUsed(key, sessions) {
    const s = sessions || this.byKey.get(key)?.sessions
    if (s?.admitCount > 0) return true
    if (s?.hasLiveSlot?.() === true) return true
    if ((this.stats.byKey.get(key) || 0) > 0) return true
    return this._lastUsedAt.has(key)
  }

  /**
   * 选号并确保会话（粘性优先，见 candidateKeys）：
   * 同模型热 session > 已用过的账号（最近用过的优先）> 从未用过的账号；
   * 冷却 / 余额不足 / 新会话预算耗尽的账号跳过。
   * @param {string} model
   * @param {{ sessionBudget?: { remaining: number }, skipKeys?: Set<string> }} [opts]
   *   sessionBudget: 本次下游请求还能新建几个上游会话（Freebucks 计费单位）。
   *   复用已有热 session 不消耗预算；预算耗尽后只允许复用，不再 admit。
   *   skipKeys: 本次请求已排队超时过的账号，不再重复选中。
   */
  async acquireForModel(model, opts = {}) {
    return this._withAcquireLock(() =>
      this._acquireForModelUnlocked(model, opts),
    )
  }

  async _acquireForModelUnlocked(model, opts = {}) {
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

    const order = this.candidateKeys(model, { skipKeys: opts.skipKeys })
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

      const reusable = rt.sessions.isUsableForModel(model)
      if (!reusable) {
        // 上游对"余额不够"的判定就两条——额度跑完 / 本次请求所需 Freebucks
        // 高于剩余额度——命中任一条就可能直接封号，所以**只在真的要新买一条
        // 计费会话时**才拦。注意不能提到 reusable 判断之外：活跃的同模型热
        // session 在 admit 时就已经预扣了整小时，复用它不再产生费用，拦下来
        // 反而等于把已经付过的钱丢掉、再去别的号上买一条新的。
        const fb = rt.sessions.freebucksFor?.(model)
        if (fb?.known && fb.affordable === false) {
          failures.push({
            key,
            email: emailByKey.get(key),
            code: 'freebucks_exhausted',
            reason: fb.reason || null,
            message:
              (fb.reason === 'daily_exhausted'
                ? `freebucks daily pool exhausted (${fb.dailyRemaining}/${fb.dailyLimit}) for ${model}`
                : fb.reason === 'monthly_exhausted'
                  ? `freebucks monthly allowance exhausted for ${model}`
                  : `freebucks balance ${fb.balance} < price ${fb.price} for ${model}`) +
              (fb.resetAt ? ` (refills ${fb.resetAt})` : ''),
          })
          logger.info('skip account: freebucks cannot afford model', {
            key,
            email: emailByKey.get(key),
            model,
            reason: fb.reason || 'balance_shortfall',
            balance: fb.balance,
            price: fb.price,
            dailyRemaining: fb.dailyRemaining,
            dailyLimit: fb.dailyLimit,
          })
          continue
        }
        // 新会话预算：上游按会话占用时长计费，一个失败的下游请求不该把
        // 多个账号各买一条计费会话（issue #7）。被上游拒绝的 admit
        // （rate_limited 等）不占额度，所以只在这里做「还有没有预算」的预检，
        // 真正扣减在 admit 成功之后。
        if (opts.sessionBudget && opts.sessionBudget.remaining <= 0) {
          failures.push({
            key,
            email: emailByKey.get(key),
            code: 'session_budget_exhausted',
            message:
              'new-session budget for this request is used up (Freebucks meter)',
          })
          continue
        }
      }

      const admitsBefore = rt.sessions.admitCount || 0
      try {
        const reusedSession = reusable
        await rt.sessions.ensureSession(model)
        // 只有真的新建了计费会话才扣预算（复用热 session / 被拒绝的 admit 不扣）。
        if (
          !reusedSession &&
          opts.sessionBudget &&
          (rt.sessions.admitCount || 0) > admitsBefore
        ) {
          opts.sessionBudget.remaining -= 1
        }
        this.clearCooldown(key, model)
        this._setLastSuccessKey(key)
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

    // 全部账号都是"余额买不起"时给出**独立错误码**：这跟"账号都在冷却/没号"
    // 是完全不同的处境（前者等每日池刷新就好，后者要加号/等冷却），调用方与
    // 控制台不该看到同一个笼统的 no_available_account。
    const allExhausted =
      failures.length > 0 &&
      failures.every((f) => f.code === 'freebucks_exhausted')
    if (allExhausted) {
      const cheapest = failures.map((f) => f.message).join('; ')
      throw new UpstreamError(
        `No Freebuff account can afford model ${model} (Freebucks exhausted). ${cheapest}`,
        {
          status: 429,
          code: 'freebucks_exhausted',
          body: { model, failures },
          retryAfterMs: this.earliestCooldownMs(),
        },
      )
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
              this._setLastSuccessKey(opts.preferredKey)
              return rt
            }
          } catch {
            // 账号已不可用（凭据变更等）→ 走全新选号
          }
        }
      } else {
        try {
          const rt = this.get(opts.preferredKey)
          // 非 session-gate 的失败（5xx / 网络抖动 / 上游瞬时故障）在同一账号上
          // 重试：会话还能用就直接复用——绝不为了重试再买一条计费 session。
          if (
            (!opts.gateCode || !isSessionRecoverableGate(opts.gateCode)) &&
            rt.sessions.isUsableForModel(model)
          ) {
            this.clearCooldown(opts.preferredKey, model)
            this._setLastSuccessKey(opts.preferredKey)
            return rt
          }
          // 同账号 gate 重试时，调用方（chat 流程）已持有该账号的串行化锁，
          // 不会与另一个在途 chat 冲突，可直接 forceReadmit。
          //
          // 但 forceReadmit 会**新买一条计费会话**（先 DELETE 再 admit），所以
          // 必须先过额度闸门：余额买不起还去 admit，正好命中上游"请求所需
          // Freebucks 高于余额 → 直接封号"的判定。买不起就冷却该号并交给下面的
          // 全新选号去挑一个买得起的账号。
          const fbGate = rt.sessions.freebucksFor?.(model)
          if (fbGate?.known && fbGate.affordable === false) {
            logger.info('skip re-admit: freebucks cannot afford model', {
              key: opts.preferredKey,
              model,
              reason: fbGate.reason || 'balance_shortfall',
              balance: fbGate.balance,
              price: fbGate.price,
              dailyRemaining: fbGate.dailyRemaining,
              dailyLimit: fbGate.dailyLimit,
            })
            throw new UpstreamError(
              fbGate.reason === 'daily_exhausted'
                ? `freebucks daily pool exhausted for ${model}`
                : `freebucks balance ${fbGate.balance} < price ${fbGate.price} for ${model}`,
              { status: 429, code: 'freebucks_exhausted' },
            )
          }
          await rt.sessions.forceReadmit(model)
          this.clearCooldown(opts.preferredKey, model)
          this._setLastSuccessKey(opts.preferredKey)
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
    return this._acquireForModelUnlocked(model, opts)
  }

  /**
   * 释放某账号的上游会话（早退 DELETE → Freebucks 退款）。
   * 换号/冷却时调用：失败账号的会话没人再用，留着只会白扣占用时长；
   * 有在途流时等它结束再释放（releaseWhenIdle），绝不掐断正在传输的 SSE。
   * @param {string} key
   */
  releaseSession(key) {
    const rt = this.byKey.get(key)
    if (!rt) return
    rt.sessions.releaseWhenIdle().catch((err) => {
      logger.warn('release failed session on account switch failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      })
    })
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
          // 严格释放：等到上游确认结束或退避重试耗尽，失败带上原因——绝不
          // "报成功但其实没删掉"（删不掉 = 白白多扣一小时，见 issue #7）。
          const rel = rt
            ? await rt.sessions.releaseStrict()
            : { ok: true, attempts: 0 }
          // 信号量重置：清空在途计数并放行排队等待者（等待者会在 chat
          // 流程重新检查 session 并 re-admit，不会卡死）
          this.chatLocks.get(key)?.reset()
          return {
            key,
            email: rt?.email,
            ok: rel.ok !== false,
            instanceId: rel.instanceId,
            attempts: rel.attempts,
            error: rel.error,
          }
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

  /**
   * 启动扫尾：把上次进程遗留 / 本次释放失败的会话句柄逐个 DELETE 拿退款。
   * 失败的保留在 sessions.json 里等下次启动继续——绝不静默丢弃。
   * @returns {Promise<{cleaned: number, failed: number, skipped: number}>}
   */
  async cleanupOrphanSessions() {
    const resolve = (key) => {
      try {
        return this.get(key)?.upstream || null
      } catch {
        return null
      }
    }
    return this.handleStore.cleanupOrphans(resolve)
  }

  /**
   * 严格释放全部账号（「断开全部连接」/「重启服务」/进程退出用）：
   * 与 fire-and-forget 的 releaseSession 不同，这里**等到每条会话都确认结束
   * 或重试耗尽**才返回，并给出逐账号明细——绝不"报成功其实没删掉"。
   * 失败的句柄仍留在 sessions.json，由下次启动扫尾继续清理。
   * @param {{waitInFlightMs?: number}} [opts]
   * @returns {Promise<{ok: boolean, released: number, failed: Array<{key: string, instanceId?: string, error?: string}>}>}
   */
  async releaseAllStrict(opts = {}) {
    const waitMs = Number.isFinite(opts.waitInFlightMs)
      ? opts.waitInFlightMs
      : 0
    const runtimes = [...this.byKey.values()]
    const results = await Promise.all(
      runtimes.map(async (rt) => {
        if (waitMs > 0) {
          // 等在途 SSE 结束（有界）：不掐断正在传输的流，超时就继续释放。
          await rt.sessions._waitForIdle(waitMs)
        }
        try {
          const r = await rt.sessions.releaseStrict()
          return { key: rt.key, email: rt.email, ...r }
        } catch (err) {
          return {
            key: rt.key,
            email: rt.email,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )
    const failed = results
      .filter((r) => !r.ok)
      .map((r) => ({
        key: r.key,
        email: r.email,
        instanceId: r.instanceId,
        error: r.error || 'release failed',
      }))
    const released = results.filter((r) => r.ok).length
    if (failed.length) {
      logger.warn('strict release finished with failures (handles kept for retry)', {
        failed: failed.length,
        released,
      })
    }
    return { ok: failed.length === 0, released, failed }
  }

  /**
   * 把内存里的账号状态写进账本：
   *   - _persistCooldowns(key)：某账号整组冷却（账号级 + 各模型级）
   *   - _persistAccountState(key, snap)：freebucks / quota / lastProbe
   * 都在热路径上调用，落盘本身由 AccountStateStore 去抖合并，不阻塞转发。
   * @param {string} key
   */
  _persistCooldowns(key) {
    if (!key) return
    const prefix = `${key}\0`
    const cooldowns = {}
    for (const [k, cd] of this.cooldowns) {
      if (k !== key && !k.startsWith(prefix)) continue
      cooldowns[k] = { until: cd.until, code: cd.code ?? null }
      if (cd.model) cooldowns[k].model = cd.model
    }
    this.accountState.patch(key, { cooldowns })
  }

  /**
   * @param {string} key
   * @param {{ freebucks?: any, quota?: any, lastProbe?: any }} snap
   */
  _persistAccountState(key, snap) {
    if (!key || !snap) return
    // 退款流水单独走账本（追加重试/金额对账用），不混进字段快照。
    if (snap.refund) {
      this.accountState.recordRefund(key, snap.refund)
      return
    }
    const fields = {}
    if (snap.freebucks !== undefined) fields.freebucks = snap.freebucks
    if (snap.quota !== undefined) fields.quota = snap.quota
    if (snap.lastProbe !== undefined) fields.lastProbe = snap.lastProbe
    const user = this.byKey.get(key)?.user
    if (user?.email) fields.email = user.email
    // 封禁是账号生命周期的终点，值得额外记一笔（"什么时候开始被 ban 的"）。
    if (fields.lastProbe?.ok === false && fields.lastProbe.code === 'banned') {
      if (!this.accountState.account(key)?.bannedAt) {
        fields.bannedAt = fields.lastProbe.at || new Date().toISOString()
      }
    }
    this.accountState.patch(key, fields)
  }

  /**
   * 启动时回灌账本：冷却、请求计数、最近使用、freebucks/quota/探测结果。
   * 只回灌**尚未过期**的冷却（过期的直接丢弃，否则重启会把账号永久锁死）。
   * 回灌 freebucks 尤其关键：它让"余额买不起就别 admit"这道闸门在重启后
   * 依然生效，而不是失忆放行去撞已知余额不足的账号。
   */
  _restoreAccountState() {
    const valid = new Set(this.allKeys())
    const removed = this.accountState.prune(valid)
    if (removed) {
      logger.info('account-state: 清理已删除账号的记录', { removed })
    }
    for (const key of valid) {
      const rec = this.accountState.account(key, this._importedAtHint(key))
      if (!rec) continue
      const requests = Number(rec.requests) || 0
      if (requests > 0) {
        this.stats.byKey.set(key, requests)
        this.stats.total += requests
      }
      const usedAt = rec.lastUsedAt ? Date.parse(rec.lastUsedAt) : NaN
      if (Number.isFinite(usedAt)) this._lastUsedAt.set(key, usedAt)
      const cds = rec.cooldowns
      if (cds && typeof cds === 'object') {
        const now = Date.now()
        const prefix = `${key}\0`
        for (const [k, cd] of Object.entries(cds)) {
          if (k !== key && !k.startsWith(prefix)) continue
          const until = Number(cd?.until)
          if (!Number.isFinite(until) || until <= now) continue
          this.cooldowns.set(k, {
            until,
            code: cd.code ?? null,
            model: cd.model,
          })
        }
      }
      // freebucks / quota / lastProbe 不在这里灌：runtime 是懒创建的，构造
      // 函数执行时 byKey 还是空的。那部分见 _hydrateRuntime（get() 时调用）。
    }
    if (typeof this.accountState.state.lastSuccessKey === 'string') {
      this._lastSuccessKey = this.accountState.state.lastSuccessKey
    }
  }

  /**
   * 忘记某账号（被删除时调用）：把它的账本记录一并清掉。
   * 不清的话 account-state.json 会随着删号无限增长，而且下次 prune 之前
   * 控制台仍会从账本里读出这些幽灵账号的"历史"。
   * @param {string} key
   */
  forgetAccount(key) {
    if (!key) return
    const accounts = this.accountState.state.accounts
    if (accounts[key]) {
      delete accounts[key]
    }
    // 历史邮箱 key 同属一个账号时一并清掉（旧布局凭据）。
    this.stats.byKey.delete(key)
    this._lastUsedAt.delete(key)
    if (this._lastSuccessKey === key) this._lastSuccessKey = null
    for (const k of [...this.cooldowns.keys()]) {
      if (k === key || k.startsWith(`${key}\0`)) this.cooldowns.delete(k)
    }
    this.accountState.prune(new Set(this.allKeys()))
    this.accountState.flush()
  }

  /** 账本 + 句柄索引一起冲刷落盘（进程退出/重启前调用）。 */
  flushState() {
    try {
      this.accountState.flush()
    } catch {
      // 落盘失败不影响退出流程
    }
  }

  async shutdown({ strict = false } = {}) {
    /** @type {{ok: boolean, released: number, failed: any[]}} */
    let rel = { ok: true, released: 0, failed: [] }
    if (strict) {
      // 进程退出：等到真的删掉或重试耗尽（句柄已落盘，失败也能下次扫尾）。
      try {
        rel = await this.releaseAllStrict()
      } catch (err) {
        logger.warn('strict session release on shutdown failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        // 退回逐账号 shutdown（各自尽力 DELETE 一次）
        const tasks = [...this.byKey.values()].map((rt) => rt.sessions.shutdown())
        await Promise.allSettled(tasks)
        this.byKey.clear()
        return rel
      }
    }
    const tasks = [...this.byKey.values()].map((rt) => rt.sessions.shutdown())
    await Promise.allSettled(tasks)
    this.flushState()
    this.byKey.clear()
    return rel
  }
}

/**
 * 会话句柄索引（sessions.json）落盘位置。
 *
 * 必须和**凭据目录**放一起：同一个 dataDir 可能被两个服务共用（本仓库的
 * `data/` 与上层 rotator 的 `../data/`），句柄索引跟着凭据走才不会各自
 * 持有一份互相看不见的孤儿；也保证"删容器不丢数据"的 /data 约定成立。
 * @param {import('./config.js').ProxyConfig} config
 */
function resolveSessionIndexPath(config) {
  return path.join(accountStateDir(config), 'sessions.json')
}

/**
 * 账号状态账本（account-state.json）落盘位置——与 sessions.json / 凭据同目录，
 * 同样是"删容器不丢数据"的 /data 约定。
 * @param {import('./config.js').ProxyConfig} config
 */
function resolveAccountStatePath(config) {
  return path.join(accountStateDir(config), 'account-state.json')
}

/** 凭据目录的父目录（= /data）；凭据目录本身不叫 credentials 时就用它自己。 */
function accountStateDir(config) {
  const credDir = resolveCredentialsDir(config)
  const parent = path.dirname(credDir)
  return path.basename(credDir) === 'credentials' ? parent : credDir
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
