/**
 * 账号级 chat 并发信号量(公平 FIFO + 有界等待).
 *
 * 从 app-context.js 按职责切出. 它是纯并发原语, 不碰账号池状态, 因此单独
 * 成文件后可以独立测(见 test 里对 account_busy 的用例).
 *
 * 默认容量 1(一个账号同一时间只处理一个 chat, 避免上游会话不稳定时
 * 并发互相干扰/顶号); 可在控制台[负载均衡]调大(一个账号可同时转发多个
 * SSE 响应流, 实测同一 instanceId 支持并发 chat). timeoutMs=0 表示无限等待;
 * 持锁者受 streamIdleTimeoutSec / 各 HTTP 阶段超时约束, 无限等待在实际运行中
 * 是有上界的.
 */
import { UpstreamError } from '../../upstream/client.js'

/**
 * 账号级 chat 并发信号量(公平 FIFO + 有界等待).
 *
 * 默认容量 1(一个账号同一时间只处理一个 chat, 避免上游会话不稳定时并发互相
 * 干扰/顶号); 可在控制台[负载均衡]调大. timeoutMs=0 表示无限等待; 持锁者受
 * streamIdleTimeoutSec 约束, 无限等待在实际运行中是有上界的.
 */
export class ChatMutex {
  /** 同一账号最大并发 chat 数(>=1). */
  _capacity: number
  /** 当前在途 chat 数(含已授予的等待者). */
  _held: number
  /** 排队中的等待者(FIFO). */
  _queue: Array<{
    resolve: (release: () => void) => void
    reject: (err: unknown) => void
    timer: any
  }>

  /**
   * @param {number} [capacity] 同一账号最大并发 chat 数(>=1)
   */
  constructor(capacity: any = 1) {
    this._capacity = Math.max(1, Math.floor(capacity) || 1)
    /** 当前在途 chat 数(含已授予的等待者). */
    this._held = 0
    /** @type {Array<{resolve: Function, reject: Function, timer: NodeJS.Timeout | null}>} */
    this._queue = []
  }

  /**
   * 是否已达到并发上限(不再有可用槽位).
   * @returns {boolean} 已达上限则为真
   */
  get busy(): boolean {
    return this._held >= this._capacity
  }

  /**
   * 当前在途 chat 数(监控用).
   * @returns {number} 在途数
   */
  get inFlight(): number {
    return this._held
  }

  /**
   * 排队等待槽位的请求数(监控/空闲释放判断用).
   * @returns {number} 排队数
   */
  get queued(): number {
    return this._queue.length
  }

  /**
   * 当前并发上限(监控用).
   * @returns {number} 并发上限
   */
  get capacity(): number {
    return this._capacity
  }

  /**
   * 动态调整并发上限(控制台保存后立即生效).已授予的在途不受影响;
   * 调大时立即把空出的槽位授予排队的等待者.
   * @param {number} n
   */
  setCapacity(n: number): void {
    const next = Math.max(1, Math.floor(n) || 1)
    if (next === this._capacity) return
    this._capacity = next
    while (this._queue.length && this._held < this._capacity) {
      const entry = this._queue.shift()
      if (!entry) continue
      if (entry.timer) clearTimeout(entry.timer)
      this._held += 1
      entry.resolve(this._makeRelease())
    }
  }

  /**
   * @param {number} timeoutMs 0 = 无限等待
   * @returns {Promise<() => void>} 释放函数
   */
  acquire(timeoutMs: number): Promise<() => void> {
    return new Promise<() => void>((resolve: any, reject: any) => {
      const entry = { resolve, reject, timer: null as any }
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
   * 全部断开重连时调用:清空在途计数并立即放行所有排队等待者
   * (等待者会在 chat 流程里重新检查 session 并 re-admit,不会卡死).
   */
  reset(): void {
    this._held = 0
    while (this._queue.length) {
      const entry = this._queue.shift()
      if (!entry) continue
      if (entry.timer) clearTimeout(entry.timer)
      this._held += 1
      entry.resolve(this._makeRelease())
    }
  }

  /**
 * 幂等释放句柄(重复调用只归还一次槽位).
 * @returns {() => void} 释放函数
 */
  _makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this._held = Math.max(0, this._held - 1)
      while (this._queue.length && this._held < this._capacity) {
        const next = this._queue.shift()
        if (!next) continue
        if (next.timer) clearTimeout(next.timer)
        this._held += 1
        next.resolve(this._makeRelease())
      }
    }
  }
}
