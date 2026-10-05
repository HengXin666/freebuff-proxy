/**
 * 流管道 ---- 把上游响应体透传给下游:idle 兜底,客户端断开感知,背压等待.
 *
 * 从原 stream-pipe.ts 按职责切分后保留原文件名,作为本组模块的入口.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { UpstreamError } from '../../../upstream/client.ts'
import { ClientGoneError, StreamStallError } from '../errors/respond.ts'
import { createStreamGuards, failPipe } from './stream-guards.ts'

/** 客户端断开信号的句柄:同步查状态,与等待竞速,用后清理监听器. */
export interface ClientGoneHandle {
  /** 客户端是否已断开(同步判断). */
  isGone: () => boolean
  /** 与等待 Promise 竞速;客户端断开时以 client_gone 提前结束等待. */
  race: (waitPromise: Promise<() => void>) => Promise<() => void>
  /** 移除 socket 监听器. */
  cleanup: () => void
}

/**
 * 有界等待(毫秒).
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 计时结束即 resolve(timer 已 unref,不阻止进程退出)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}

/**
 * 上游/前端 HTTP 方法是否允许携带请求体(透传与预读判定共用).
 * @param {string} [method] HTTP 方法(大小写不敏感)
 * @returns {boolean} 该方法是否允许携带请求体
 */
export function methodHasBody(method: string | undefined): boolean {
  const m = (method || 'GET').toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}

/**
 * Constant-time-ish compare against configured proxy keys.
 * @param {unknown} token 下游提交的 bearer token
 * @param {string[]} keys 配置里的代理 API key 列表
 * @returns {boolean} 是否命中其中之一(定长比较,不提前返回)
 */
export function apiKeyMatches(token: unknown, keys: string[]): boolean {
  const a = Buffer.from(String(token))
  for (const key of keys) {
    const b = Buffer.from(String(key))
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

/**
 * 客户端断开信号(调度阶段用,区别于下方的 pipe 阶段).
 *
 * 本代理在调度上有多个[首字节之前的静默等待]: 全局槽位, 账号 chat 锁, 上游首字节;
 * 这些等待都感知客户端是否还在.
 *
 * 语义: socket close -> 视为客户端已走, 等待立即放弃, 并保证稍后授予的锁被释放.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{isGone: () => boolean, race: (waitPromise: Promise<any>) => Promise<any>, cleanup: () => void}} 断开信号对象
 */
export function clientGoneSignal(req: IncomingMessage): ClientGoneHandle {
  const socket = req.socket
  let onClose: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    if (!socket || socket.destroyed) {
      resolve()
      return
    }
    // 与 reqToAbortSignal 同因:只有底层 socket close 才代表真断开
    // (req 'close' 在 body 读完时就触发,早于这里注册的时机).
    onClose = () => resolve()
    socket.once('close', onClose)
  })
  return {
    /** 客户端是否已断开(同步判断). */
    isGone: () => Boolean(socket && socket.destroyed),
    /** 与等待 Promise 竞速;客户端断开时以 client_gone 提前结束等待. */
    async race(waitPromise: Promise<() => void>): Promise<() => void> {
      const outcome = await Promise.race<
        { hold: () => void } | { err: unknown } | { gone: true }
      >([
        waitPromise.then((hold) => ({ hold }), (err: unknown) => ({ err })),
        promise.then(() => ({ gone: true as const })),
      ])
      if ('gone' in outcome) {
        // 竞速输了不等于锁没授予:授予后立刻归还,绝不泄漏槽位.
        waitPromise.then((hold) => hold()).catch(() => {})
        throw new UpstreamError(
          'client disconnected while waiting for a scheduling slot',
          { status: 499, code: 'client_gone' },
        )
      }
      if ('err' in outcome) throw outcome.err
      return outcome.hold
    },
    cleanup() {
      if (onClose && socket) socket.removeListener('close', onClose)
    },
  }
}

/**
 * 客户端断开的 abort 信号.监听底层 socket 关闭: node 的
 * IncomingMessage 'close' 是[请求体读完]事件, 早于本函数注册监听器的时机.
 * 客户端断开(含 keep-alive 下断开)只体现在 socket close 上.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{signal: AbortSignal, cleanup: () => void}} abort 信号与清理函数
 */
export function reqToAbortSignal(req: IncomingMessage): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const onClose = () => controller.abort()
  // once + 用后 removeListener:keep-alive 连接被多个请求共享,不清理会累积监听器
  req.socket?.once('close', onClose)
  return {
    signal: controller.signal,
    cleanup() {
      req.socket?.removeListener('close', onClose)
    },
  }
}

/**
 * 把上游响应体透传给下游,带 idle 超时兜底:
 * 超过 idleTimeoutMs 没有新数据块 -> 取消上游读取,销毁下游连接,并抛出带
 * stalled 标记的错误(err.wroteBytes 记录已下发的字节数).
 *
 * 客户端断开也立即中断:把 [客户端连接关闭] 显式加进 race,断开瞬间 reject 并释放锁.
 * @param {ReadableStream<Uint8Array>} webBody 上游响应体(WebStream)
 * @param {import('node:http').ServerResponse} nodeRes
 * @param {import('node:http').IncomingMessage} nodeReq
 * @param {{idleTimeoutMs?: number}} [opts] idle 超时(毫秒;0 或缺省 = 不设)
 * @returns {Promise<{wroteBytes: number}>} 已下发的字节数
 */
export async function pipeWebStreamToNode(
  webBody: ReadableStream<Uint8Array>,
  nodeRes: ServerResponse,
  nodeReq: IncomingMessage,
  opts: { idleTimeoutMs?: number } = {},
): Promise<{ wroteBytes: number }> {
  const { idleTimeoutMs = 0 } = opts
  const reader = webBody.getReader()
  const guard = createStreamGuards(reader, idleTimeoutMs)
  let wroteBytes = 0
  // 客户端断开只能靠底层 socket close 感知(req 'close' 是 body 读完事件,
  // 在管道注册前就已触发).
  const socket = nodeReq.socket
  const onSocketClose = () => guard.markGone()
  if (socket) socket.once('close', onSocketClose)

  guard.rearmTimer()
  guard.armGone()
  try {
    while (true) {
      const { done, value } = await guard.race(reader.read())
      if (guard.isStalled()) throw new StreamStallError(idleTimeoutMs)
      if (guard.isClientGone()) throw new ClientGoneError()
      if (done) break
      if (!value) continue
      guard.clearTimer()
      const buf = Buffer.from(value)
      wroteBytes += buf.length
      if (!nodeRes.write(buf)) {
        // 下游背压:客户端 TCP 窗口满,等待 drain.若客户端"活着但不再读"
        // (不关连接也不消费),onceDrain 永不触发 -> 账号 chat 锁被永久占死.
        // 因此等待 drain 前必须重新武装 idle 定时器.
        guard.rearmTimer()
        await guard.race(onceDrain(nodeRes))
        if (guard.isStalled()) throw new StreamStallError(idleTimeoutMs)
        if (guard.isClientGone()) throw new ClientGoneError()
      }
      guard.rearmTimer()
    }
    guard.clearTimer()
    nodeRes.end()
    return { wroteBytes }
  } catch (caught) {
    guard.clearTimer()
    // failPipe 恒以 throw 结束;显式 return 只是让 TS 看到这里不会正常落地
    // (Node 原生 type stripping 会把返回标注擦掉,不影响运行时语义).
    return failPipe(nodeRes, caught, {
      wroteBytes,
      stalled: guard.isStalled(),
      clientGone: guard.isClientGone(),
      idleTimeoutMs,
    })
  } finally {
    if (socket) socket.removeListener('close', onSocketClose)
  }
}

function onceDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => res.once('drain', () => resolve()))
}
