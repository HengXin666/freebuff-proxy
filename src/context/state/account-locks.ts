/**
 * 账号级 chat 并发闸门与预留计数.
 *
 * 预留的必要性: 选号(candidateKeys)发生在拿 chat 锁之前, 此刻 chatLock.inFlight
 * 还是 0 ---- N 个并发请求会同时看到"这个账号很空"而全部选中同一个账号.
 */
import { ChatMutex } from './chat-mutex.ts'

/** 预留的兜底存活时长: 足够走完"选号 -> 拿 chat 锁", 又不会让泄漏永久化. */
export const RESERVE_TTL_MS = 90_000

/**
 * 取(必要时创建)该账号的 chat 互斥量, 并按当前配置刷新其容量.
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key
 * @returns {ChatMutex} chat 互斥量
 */
export function chatLockFor(this: any, key: any) {
  let lock = this.chatLocks.get(key)
  if (!lock) {
    lock = new ChatMutex(this._accountConcurrency())
    this.chatLocks.set(key, lock)
  } else {
    lock.setCapacity(this._accountConcurrency())
  }
  return lock
}

/**
 * 账号当前是否已达到并发上限(无可用 chat 槽位).
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key
 * @returns {boolean} 是否已满
 */
export function isChatBusy(this: any, key: any) {
  return this.chatLocks.get(key)?.busy || false
}

/**
 * 账号当前在途 chat 数(监控用).
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key
 * @returns {number} 在途数
 */
export function chatInFlight(this: any, key: any) {
  return this.chatLocks.get(key)?.inFlight || 0
}

/**
 * 被选中但还没拿到 chat 锁的请求数(spread 排序用).
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key
 * @returns {number} 预留数
 */
export function reservedCount(this: any, key: any) {
  return this._reserved.get(key) || 0
}

/**
 * 该账号当前"实际占用 + 已预留"的槽位估计(spread 排序的 load).
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key
 * @returns {number} 负载估计
 */
export function effectiveLoad(this: any, key: any) {
  return this.chatInFlight(key) + this.reservedCount(key)
}

/**
 * 预留一个 chat 槽位意向(选号成功后由 chat 流程调用).
 * 返回幂等的释放函数:拿到 chat 锁后调用它把预留交还给真实在途计数.
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @returns {() => void}
 */
export function reserveSlot(this: any, key: any) {
  if (!key) return () => {}
  this._reserved.set(key, (this._reserved.get(key) || 0) + 1)
  // 兜底 TTL:请求异常退出/进程卡住也不会把账号永久标成满员.
  if (!this._reserveTimers.has(key)) {
    const t = setTimeout(() => {
      this._reserveTimers.delete(key)
      this._reserved.delete(key)
    }, RESERVE_TTL_MS)
    if (t.unref) t.unref()
    this._reserveTimers.set(key, t)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (this._reserved.get(key) || 0) - 1
    if (left > 0) this._reserved.set(key, left)
    else {
      this._reserved.delete(key)
      const t = this._reserveTimers.get(key)
      if (t) {
        clearTimeout(t)
        this._reserveTimers.delete(key)
      }
    }
  }
}

/**
 * 获取账号的 chat 并发槽位.
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @param {number} timeoutMs 0 = 无限等待
 * @returns {Promise<() => void>}
 */
export function acquireChat(this: any, key: any, timeoutMs: any) {
  return this.chatLockFor(key).acquire(timeoutMs)
}
