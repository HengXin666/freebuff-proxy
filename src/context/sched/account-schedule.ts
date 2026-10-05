/**
 * 账号调度: 并发上限, 调度模式, 计数, 互斥, 选号入口.
 *
 * 从 app-context.js 按职责切出. 选号排序的完整依据见 account-try / account-gates;
 * 这里放它周边的状态读写与两个加锁入口.
 */
import { logger } from '../../util/log.ts'

/**
 * 每个账号的当前并发上限(控制台设置, 实时生效).
 * @param {any} this 账号池(runtimes)
 * @returns {number} 并发上限(1..16, 缺省 1)
 */
export function _accountConcurrency(this: any) {
  const n = this._getAccountConcurrency()
  return Number.isFinite(n) && n >= 1 ? Math.min(16, Math.floor(n)) : 1
}

/**
 * 当前调度模式: sticky(默认, 并发上限是溢出阈值) 或 spread(并发优先).
 * 非法值一律回落 sticky, 保证升级不改变既有行为.
 * @param {any} this 账号池(runtimes)
 * @returns {string} 'sticky' 或 'spread'
 */
export function schedulingMode(this: any) {
  try {
    return this._getSchedulingMode?.() === 'spread' ? 'spread' : 'sticky'
  } catch {
    return 'sticky'
  }
}

/**
 * 更新"最后成功账号"(粘性调度核心输入)并落盘.
 * 集中一处:原先有 4 个赋值点,只有 1 个写了账本,重启后粘性就跑了.
 * @param {any} this 账号池(runtimes)
 * @param {any} this 账号池(runtimes)
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @returns {any} 见实现
 */
export function _setLastSuccessKey(this: any, key: any) {
  if (!key) return
  this._lastSuccessKey = key
  this.accountState.state.lastSuccessKey = key
  this.accountState.touch()
}

/**
 * 记一次成功调度: 计数, 最近使用时间, 并落盘.
 *
 * 重启后[用过没有 / 最近什么时候用的]不该归零, 否则粘性调度会把已经打过废的
 * 账号当成全新账号重新启用一遍.
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key
 * @returns {void}
 */
export function _recordSuccess(this: any, key: any) {
  this.stats.total += 1
  this.stats.byKey.set(key, (this.stats.byKey.get(key) || 0) + 1)
  this._lastUsedAt.set(key, Date.now())
  // 请求计数/最近使用落盘:重启后[用过没有 / 最近什么时候用的]不该归零,
  // 否则粘性调度会把已经打过废的账号当成全新账号重新启用一遍.
  this.accountState.patch(key, {
    requests: this.stats.byKey.get(key) || 0,
    lastUsedAt: new Date(this._lastUsedAt.get(key)).toISOString(),
  })
}

/**
 * 选号/准入的进程内互斥: 串行化"选号 + admit"整段.
 *
 * 没有它时并发请求会各自看到同一个"空账号"并同时 admit(同一个账号被买两次).
 * @param {any} this 账号池(runtimes)
 * @param {() => Promise<any>} fn 临界区回调
 * @returns {Promise<any>} fn 的返回值
 */
export async function _withAcquireLock(this: any, fn: any) {
  let release
  const wait = new Promise((resolve: any) => {
    release = resolve
  })
  const prev = this._acquireMutex
  this._acquireMutex = prev.then(() => wait)
  await prev
  try {
    return await fn()
  } finally {
    ;(release as unknown as () => void)()
  }
}

/**
 * 该账号是否"被使用过":有过 admit / 有活跃 session / 发过请求.
 * 从未用过的账号在选号里排最后----只在已用账号都不可用(冷却/额度耗尽/
 * 满员排队超时)时才启用,避免把每个账号都摸一遍(账号农场特征).
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @param {import('../../session-manager.ts').SessionManager} [sessions]
 * @returns {any} 见实现
 */
export function everUsed(this: any, key: any, sessions: any) {
  const s = sessions || this.byKey.get(key)?.sessions
  if (s?.admitCount > 0) return true
  if (s?.hasLiveSlot?.() === true) return true
  if ((this.stats.byKey.get(key) || 0) > 0) return true
  return this._lastUsedAt.has(key)
}

/**
 * 选号并确保会话(粘性优先,见 candidateKeys):
 * 同模型热 session > 已用过的账号(最近用过的优先)> 从未用过的账号;
 * 冷却 / 余额不足 / 新会话预算耗尽的账号跳过.
 * @param {any} this 账号池(runtimes)
 * @param {string} model
 * @param {{ sessionBudget?: { remaining: number | null }, skipKeys?: Set<string> }} [opts]
 *   sessionBudget: 本次下游请求还能新建几个上游会话(Freebucks 计费单位).
 *   remaining 为 null 表示不限额(控制台预算设为 0 = 不限),恒放行且不递减.
 *   复用已有热 session 不消耗预算;预算耗尽后只允许复用,不再 admit.
 *   skipKeys: 本次请求已排队超时过的账号,不再重复选中.
 * @returns {any} 见实现
 */
export async function acquireForModel(this: any, model: any, opts: any = {}) {
  return this._withAcquireLock(() =>
    this._acquireForModelUnlocked(model, opts),
  )
}

/**
 * 换号/重试选号:
 * - switchAccount(429/5xx/403 账号级故障)→ 冷却当前账号,然后换下一个账号;
 *   noCooldown(如 free_mode_capacity_deferred 瞬时容量)→ 不冷却,优先复用热 session;
 * - 纯 gate 错误(session_expired/superseded 等)→ 同号强制 re-admit 一次(不冷却),
 *   失败则换号.
 * @param {any} this 账号池(runtimes)
 * @param {string} model
 * @param {any} [opts] 换号/重试选项
 *   preferredKey / gateCode / retryAfterMs / switchAccount / noCooldown
 * @returns {any} 见实现
 */
export async function reacquireAfterGate(this: any, model: any, opts: any = {}) {
  return this._withAcquireLock(() =>
    this._reacquireAfterGateUnlocked(model, opts),
  )
}
