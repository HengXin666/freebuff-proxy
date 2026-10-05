/**
 * 全局 chat 并发闸门(进程内信号量)---- 从 stream-pipe.ts 按职责切出.
 *
 * _inFlight / _waitQueue 是模块私有状态,必须与操作它们的函数同处一个模块.
 */
import { UpstreamError } from '../../../upstream/client.ts'

/** 在途 chat 请求数(占用中的槽位). */
let _inFlight = 0

/** 最近一次生效的槽位上限(仅用于可观测性展示). */
let _slotLimit = 32

/**
 * 等待队列的元素:resolve 是"授予槽位"的回调,timer 是排队超时定时器.
 * 类型必须显式给出 ---- const x = [] 在 strict 下推成 any[],会让整条链失去检查.
 */
type SlotWaiter = {
  resolve: (release: () => void) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** 排队中的请求(FIFO,超时即出队). */
const _waitQueue: SlotWaiter[] = []

/**
 * 全局 chat 请求并发闸门(进程内信号量).
 *
 * 语义:
 *   - 有空位 -> 立即占用;
 *   - 排满 -> 有界等待(slotWaitMs),超时抛 429 server_busy 让客户端稍后重试;
 *   - 释放函数幂等:finally 与兜底路径重复调用都只归还一次.
 * 排队有界:槽位不会被永久挂起的请求吃掉.
 * @param {number} max
 * @param {number} [waitMs] 排队上限;<=0 表示不等待,直接拒绝
 * @returns {Promise<() => void>}
 */
export function acquireRequestSlot(
  max: number,
  waitMs = 0,
): Promise<() => void> {
  const limit = Number.isFinite(max) && max > 0 ? max : 32
  _slotLimit = limit
  if (_inFlight < limit) {
    _inFlight++
    return Promise.resolve(makeSlotRelease())
  }
  if (!(waitMs > 0)) {
    throw new UpstreamError(
      "server is at max concurrent requests (" + limit + "); try again later",
      { status: 429, code: "server_busy" },
    )
  }
  return new Promise((resolve, reject) => {
    const entry: SlotWaiter = { resolve, timer: null }
    const timer = setTimeout(() => {
      const i = _waitQueue.indexOf(entry)
      if (i >= 0) _waitQueue.splice(i, 1)
      reject(
        new UpstreamError(
          "server is at max concurrent requests (" + limit +
            "); timed out waiting for a slot",
          { status: 429, code: "server_busy" },
        ),
      )
    }, waitMs)
    entry.timer = timer
    if (timer.unref) timer.unref()
    _waitQueue.push(entry)
  })
}

/** 幂等释放句柄:重复调用只归还一次槽位(与 ChatMutex._makeRelease 同构). */
function makeSlotRelease() {
  let released = false
  return () => {
    if (released) return
    released = true
    releaseRequestSlot()
  }
}

function releaseRequestSlot() {
  _inFlight = Math.max(0, _inFlight - 1)
  const next = _waitQueue.shift()
  if (next) {
    if (next.timer) clearTimeout(next.timer)
    _inFlight++
    next.resolve(makeSlotRelease())
  }
}

/**
 * 当前在途/排队的 chat 请求数:暴露到控制台,用于观察槽位占用.
 * @returns {{inFlight: number, queued: number, limit: number}} 槽位快照
 */
export function requestSlotStats() {
  return { inFlight: _inFlight, queued: _waitQueue.length, limit: _slotLimit }
}
