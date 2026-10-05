/**
 * 流管道的守卫与失败判决 ---- 从 stream-pipe.ts 抽出,纯粹因为体量红线(文件 <=300 行).
 *
 * 这里放两类与"数据搬运"无关的东西:
 *   1. 守卫集合:一个反复武装的 idle 计时器 + 一个一次性的 client-gone 通道;
 *   2. 失败判决:把管道异常归一成"值得上报的那一个".
 *
 * 拆出去的判据是"主循环在做什么"能否一眼读出来 ---- 五个互相耦合的可变状态混在
 * 主循环里时,读代码的人会先被状态机淹没,看不到那五行核心动作.
 */
import type { ServerResponse } from 'node:http'

import { ClientGoneError, StreamStallError } from '../errors/respond.ts'

/**
 * 建一个流管道的守卫集合:一个反复武装的 idle 计时器 + 一个一次性的 client-gone 通道.
 *
 * 抽成独立函数的原因:这段状态机有 5 个互相耦合的可变状态(计时器,两个 reject 通道,
 * 两个守卫 Promise),混在 pipe 主循环里会让"主循环在做什么"读不出来.抽走后主循环只剩
 * 5 行核心动作.
 * @param reader 上游响应体的 reader(cancel 用于中断卡死的读取)
 * @param idleTimeoutMs idle 超时(毫秒;<=0 表示不设)
 * @returns 守卫集合
 */
export function createStreamGuards(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
) {
  let stalled = false
  let clientGone = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let rejectStall: ((err: unknown) => void) | null = null
  let rejectGone: ((err: unknown) => void) | null = null
  let stallPromise: Promise<never> | null = null
  let gonePromise: Promise<never> | null = null

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
    rejectStall = null
    stallPromise = null
  }
  /** 重新武装 idle 计时器:超时即标记 stall 并中断上游读取. */
  const rearmTimer = () => {
    clearTimer()
    if (!(idleTimeoutMs > 0)) return
    stallPromise = new Promise<never>((_, reject) => {
      rejectStall = reject
    })
    stallPromise.catch(() => {}) // 防迟到拒绝变 unhandledRejection
    timer = setTimeout(() => {
      stalled = true
      reader.cancel().catch(() => {})
      if (rejectStall) rejectStall(new StreamStallError(idleTimeoutMs))
    }, idleTimeoutMs)
    if (timer.unref) timer.unref()
  }
  /** 武装一次性的 client-gone 拒绝通道(幂等). */
  const armGone = () => {
    if (gonePromise) return
    gonePromise = new Promise<never>((_, reject) => {
      rejectGone = reject
    })
    gonePromise.catch(() => {}) // 防迟到拒绝变 unhandledRejection
  }
  /** 客户端断开:置标记,中断读取,触发拒绝(由 socket close 调用). */
  const markGone = () => {
    clientGone = true
    reader.cancel().catch(() => {})
    if (rejectGone) rejectGone(new ClientGoneError())
  }
  /** 与两个守卫竞速.守卫只会 reject,所以 race 的结果类型仍是 T. */
  const race = <T>(promise: Promise<T>): Promise<T> => {
    const guards: Array<Promise<never>> = []
    if (stallPromise) guards.push(stallPromise)
    if (gonePromise) guards.push(gonePromise)
    return guards.length === 0 ? promise : Promise.race([promise, ...guards])
  }
  return {
    clearTimer,
    rearmTimer,
    armGone,
    markGone,
    race,
    isStalled: () => stalled,
    isClientGone: () => clientGone,
  }
}

/**
 * 把管道异常归一成"值得上报的那一个",补上已下发字节数,并销毁下游连接.
 *
 * 为什么单独抽:三个归一分支(卡死优先于断开,断开优先于其他,附加 wroteBytes)
 * 是纯判决逻辑,和主循环的数据搬运没有关系.
 * @param nodeRes 下游响应
 * @param caught catch 到的原始抛出物(TS 里是 unknown)
 * @param stats 判决所需的本轮统计
 * @returns 恒不返回(以 throw 结束)
 */
export function failPipe(
  nodeRes: ServerResponse,
  caught: unknown,
  stats: {
    wroteBytes: number
    stalled: boolean
    clientGone: boolean
    idleTimeoutMs: number
  },
): never {
  let out: unknown = caught
  if (stats.stalled && !(out instanceof StreamStallError)) {
    out = new StreamStallError(stats.idleTimeoutMs)
  }
  if (stats.clientGone && !(out instanceof ClientGoneError)) {
    out = new ClientGoneError()
  }
  if (out && typeof out === 'object' && !('wroteBytes' in out)) {
    // wroteBytes 是给调用方做诊断用的附加字段,不属于任一错误类的契约.
    ;(out as { wroteBytes?: number }).wroteBytes = stats.wroteBytes
  }
  try {
    nodeRes.destroy(out instanceof Error ? out : undefined)
  } catch {
    // ignore
  }
  throw out
}
