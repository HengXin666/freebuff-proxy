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
 * 绝不允许无界排队:旧实现把超限请求 push 进一个没有任何超时的
 * _waitQueue,此后永不 reject.只要有几个请求在"占着槽位却永久挂起"
 * (最典型:客户端/SDK 声明了 Content-Length 却不再发完请求体,readRequestBody
 * 的 for await (const chunk of req) 就永远不返回),槽位就被永久吃掉,
 * 后续所有请求都排进那个队列再也出不来----进程 CPU/日志/控制台一切正常,
 * 但完全不接单,只有重启才恢复(已用真实 server 复现,见 test/smoke.mjs).
 *
 * 现在的语义:
 *   - 有空位 → 立即占用;
 *   - 排满 → 有界等待(slotWaitMs),超时抛 429 server_busy 让客户端稍后
 *     重试(客户端可重试远好于整个服务静默停摆);
 *   - 释放函数幂等(与 ChatMutex._makeRelease 一致):finally 与任何
 *     兜底路径重复调用都只归还一次,绝不让计数被多减.
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
 * 当前在途/排队的 chat 请求数:暴露到控制台,槽位泄漏时能立刻看出来
 * (旧实现完全不可观测,泄漏后只能靠"不接单"这个体感发现).
 * @returns {{inFlight: number, queued: number, limit: number}} 槽位快照
 */
export function requestSlotStats() {
  return { inFlight: _inFlight, queued: _waitQueue.length, limit: _slotLimit }
}
