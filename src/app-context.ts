import {
  resolveCredentialsDir,
} from './auth-store.ts'
import { SessionHandleStore } from './session-handles.ts'
import { AccountStateStore } from './account-state-store.ts'
import { freebuffAuthHeaders } from './auth-store.ts'
import {
  resolveAccountStatePath,
  resolveSessionIndexPath,
} from './context/ops/paths.ts'
import { RESERVE_TTL_MS } from './context/state/account-locks.ts'
import { CONTEXT_METHODS } from './context/methods.ts'

/**
 * Multi-account pool. 账号以[account key]标识:
 * key = Freebuff 用户 id(优先),无 id 的数据回落邮箱.
 * GitHub / Google 登录同一邮箱但 id 不同 -> 两个独立账号,互不覆盖.
 *
 * 本文件保留原路径与全部原有导出名(AccountRuntimes / buildAppContext /
 * maskEmail / freebuffAuthHeaders); 方法实现按域放在 src/context/** 下,
 * 由 ./context/methods.ts 的 CONTEXT_METHODS 装配回原型(名字即契约):
 * 选号 / 冷却 / 锁 / 生命周期四域的方法各自访问同一批字段
 * (byKey / cooldowns / chatLocks / _reserved ...), 装配表是唯一清单,
 * 与调用点同名; 漏挂一个会在运行时表现为 "x is not a function".
 */

/**
 * 邮箱脱敏(日志与错误里绝不出现完整账号邮箱).
 * @param {any} email 原始邮箱
 * @returns {string} 脱敏结果; 非法输入返回空串
 */
export function maskEmail(email: any) {
  const str = typeof email === 'string' ? email : ''
  const at = str.lastIndexOf('@')
  if (at <= 0 || at === str.length - 1) return ''
  const local = str.slice(0, at)
  const domain = str.slice(at + 1).toLowerCase()
  const runes = [...local]
  if (runes.length === 0) return '*@' + domain
  if (runes.length === 1) return '*@' + domain
  if (runes.length === 2) return runes[0] + '*@' + domain
  return runes[0] + '***' + runes[runes.length - 1] + '@' + domain
}

export class AccountRuntimes {
  declare config: any
  declare dir: any
  declare handleStore: any
  declare accountState: any
  declare _getAccountConcurrency: any
  declare _getSchedulingMode: any
  declare _getCustomModels: any
  declare _getSessionSettings: any
  declare byKey: any
  declare cooldowns: any
  declare _rr: any
  declare _acquireMutex: any
  declare chatLocks: any
  declare _lastSuccessKey: any
  declare stats: any
  declare _lastUsedAt: any
  declare _reserved: any
  declare _reserveTimers: any
  declare _restoreAccountState: any
  declare allKeys: any
  declare isCoolingDown: any
  declare schedulingMode: any
  declare markCooldown: any
  declare get: any
  declare isChatBusy: any
  declare clearCooldown: any
  declare _setLastSuccessKey: any
  declare getAny: any
  /**
   * @param {import('./config.ts').ProxyConfig} config
   * @param {{ getAccountConcurrency?: () => number, getSchedulingMode?: () => 'sticky' | 'spread', getSessionSettings?: () => { idleReleaseSec?: number, maxNewSessionsPerRequest?: number } | null, getCustomModels?: () => { id: string, pool?: string, agentId?: string, fallbackAgentId?: string, displayName?: string, multimodal?: boolean, note?: string }[] }} [opts]
   *   getAccountConcurrency: 每个账号的并发上限来源(控制台设置/配置),
   *   默认取 config.limits.accountMaxConcurrency.
   *   getSchedulingMode: 账号调度模式来源(控制台设置),默认 'sticky'.
   *   sticky = 并发上限是溢出阈值(满员先排队);spread = 并发优先(满员即换号).
   *   getCustomModels: 前端[模型管理]的自定义模型列表(覆盖内置目录),
   *   影响 agent id 解析.
   */
  constructor(config: any, opts: any = {}) {
    this.config = config
    this.dir = resolveCredentialsDir(config)
    // 上游会话句柄的持久化索引(/data/sessions.json):admit/释放都落盘, 进程退出/换容器后仍能凭 instanceId 去 DELETE 释放槽位;释放失败的句柄也 留
    this.handleStore = new SessionHandleStore(resolveSessionIndexPath(config))
    // 账号运行状态的持久化账本(/data/account-state.json):加入/封禁时间, 请求数,最近使用,冷却,Freebucks 余额与单价,每日额度,最近探测结果. 这些原本只在
    this.accountState = new AccountStateStore(resolveAccountStatePath(config))
    this._getAccountConcurrency =
      typeof opts.getAccountConcurrency === 'function'
        ? opts.getAccountConcurrency
        : () => this.config.limits.accountMaxConcurrency || 1
    // 账号调度模式来源(控制台[账号调度]实时生效):'sticky'(默认)| 'spread'. sticky = 并发上限是溢出阈值:满员先在原账号有界排队,超时才换号; spread =
    this._getSchedulingMode =
      typeof opts.getSchedulingMode === 'function'
        ? opts.getSchedulingMode
        : () => 'sticky'
    this._getCustomModels =
      typeof opts.getCustomModels === 'function'
        ? opts.getCustomModels
        : () => []
    // 前端[额度保护]设置来源(settings.json,实时生效): idleReleaseSec / maxNewSessionsPerRequest.缺省回落 config.yaml.
    this._getSessionSettings =
      typeof opts.getSessionSettings === 'function'
        ? opts.getSessionSettings
        : () => null
    /** @type {Map<string, { key: string, email: string, id: string | null, authToken: string, user: any, upstream: any, sessions: SessionManager, source: string }>} */
    this.byKey = new Map()
    // Cooldown key: account key  (whole account) or key\0model (per-model). @type {Map<string, { unti
    this.cooldowns = new Map()
    this._rr = 0
    /** Serialize account selection + session admission on cold start. */
    this._acquireMutex = Promise.resolve()
    /** 账号级 chat 串行化锁(key → ChatMutex),跨 runtime 重建保持同一账号互斥. */
    this.chatLocks = new Map()
    this._lastSuccessKey = null
    /** Per-account success counters (in-memory, for load-balance visibility). */
    this.stats = { total: 0, byKey: new Map() }
    // 每个账号最近一次被选中/成功的时间戳(粘性调度的核心输入): 优先继续用刚用过的账号. @type {Map<string, number>}
    this._lastUsedAt = new Map()
    // 已选中但还没拿到 chat 锁的预留数(key -> 计数): 选号发生在拿 chat 锁之前, 并发上限判定要把这部分一起算. @type {Map<string, number>}
    this._reserved = new Map()
    // 预留的兜底释放定时器: 请求中途异常退出时超时自动归还预留, 不把账号永久标记为满员. @type {Map<string, NodeJS.Timeout>}
    this._reserveTimers = new Map()
    // 在所有上述容器(cooldowns/stats/_lastUsedAt)初始化之后回灌:
    // 账本里的计数/冷却要落在这些容器上.
    this._restoreAccountState()
  }

  /**
   * 扫尾:把上次进程遗留 / 本次释放失败的会话句柄逐个 DELETE 取回执.
   * 失败的保留在 sessions.json 里等下次机会----绝不静默丢弃.
   *
   *  必须周期性调用,不能只在启动时调一次. 上游对"提前结束"的会话会回
   * freebucksRefundPending: true----它的语义是"最终用量还没算完,用同一个 instance
   * 再问一次回执",不是"不退"(这层误解曾让我们得出错误结论并发版,见
   * docs/design/account-scheduling-and-refund.md §3 的纠错).官方客户端在 pending 期间
   * 每 3 秒重放直到拿到终态;只在启动时扫一次 = 进程不重启就再也没人问过,
   * 那笔已经预扣的 Freebucks 会一直挂在 pending 里.
   * @param {{budgetMs?: number}} [opts] 本次扫尾的总预算(启动路径必须传,
   *   用于给上游连不通的情况兜底).
   * @returns {Promise<{cleaned: number, failed: number, skipped: number, deferred: number}>} 逐类计数
   */
  async cleanupOrphanSessions(opts = {}) {
    const resolve = (key: any) => {
      try {
        return this.get(key)?.upstream || null
      } catch {
        return null
      }
    }
    return this.handleStore.cleanupOrphans(resolve, opts)
  }
}

// 方法实现分散在 src/context/**, 这里挂回原型(装配表见 src/context/methods.ts).
Object.assign(AccountRuntimes.prototype, CONTEXT_METHODS)

/** 预留的兜底存活时长: 足够走完"选号 -> 拿 chat 锁", 又不会让泄漏永久化. */
Object.defineProperty(AccountRuntimes, 'RESERVE_TTL_MS', {
  get: () => RESERVE_TTL_MS,
})

/**
 * 装配应用上下文(构建账号池并镜像当前账号的便利字段).
 * @param {import('./config.ts').ProxyConfig} config
 * @param {{ getAccountConcurrency?: () => number, getSchedulingMode?: () => 'sticky' | 'spread', getSessionSettings?: () => any, getCustomModels?: () => { id: string, pool?: string, agentId?: string, fallbackAgentId?: string, displayName?: string, multimodal?: boolean, note?: string }[] }} [opts] 透传给 AccountRuntimes
 * @returns {any} 应用上下文(含 runtimes 与 authToken/upstream/sessions 等镜像)
 */
export function buildAppContext(config: any, opts = {}) {
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
