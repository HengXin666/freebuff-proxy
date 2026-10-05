/**
 * 账号运行时的运维动作: 重建, 顶替, 全量释放, 进程收尾.
 *
 * 从 app-context.js 按职责切出. 这些动作的共同点是"会动到别的请求正在用的
 * 出网资源", 因此每个都以"先优雅释放会话, 再关 agent"为顺序.
 */
import { UpstreamError } from '../../upstream/client.ts'
import { logger } from '../../util/log.ts'

/**
 * 丢弃一个 runtime 时的统一收尾:先优雅释放它的上游会话(要用它的
 * upstream 出网),会话收尾后再关闭出网 agent,否则 keep-alive
 * socket 会随"更新凭证/导入账号/改代理池"的次数一直累积(运行越久越慢).
 * 全程不阻塞调用方(fire-and-forget),失败只记日志.
 * @param {any} this 账号池(runtimes)
 * @param {any} rt
 * @param {string} why
 */
export function _disposeRuntime(this: any, rt: any, why: any) {
  if (!rt) return
  /** 会话已尽量释放(或本来就没会话)→ 释放出网资源. */
  const closeUpstream = () => {
    try {
      const p = rt.upstream?.close?.()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      // ignore
    }
  }
  let pending
  try {
    pending = rt.sessions?.releaseWhenIdle?.()
  } catch (err) {
    logger.warn(`${why}; session release threw`, {
      key: rt.key,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (pending && typeof pending.then === 'function') {
    // 必须等会话释放(它要用 upstream 出网)再关 agent,否则 DELETE 会失败.
    pending.then(closeUpstream, (err: any) => {
      logger.warn(`${why}; deferred session release failed`, {
        key: rt.key,
        error: err instanceof Error ? err.message : String(err),
      })
      closeUpstream()
    })
  } else {
    closeUpstream()
  }
}

/**
 * 释放某账号的上游会话(早退 DELETE → session_units 当场按实际占用退还;
 * Freebucks 侧回 freebucksRefundPending,由待结算队列持续重放追问).
 * 两本账并行扣费,一手实测见 docs/evidence/ledger-session-units-vs-freebucks.json.
 * 换号/冷却时调用:失败账号的会话没人再用,留着只会白占一个上游会话槽位;
 * 有在途流时等它结束再释放(releaseWhenIdle),绝不掐断正在传输的 SSE.
 * @param {any} this 账号池(runtimes)
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 */
export function releaseSession(this: any, key: any) {
  const rt = this.byKey.get(key)
  if (!rt) return
  rt.sessions.releaseWhenIdle().catch((err: any) => {
    logger.warn('release failed session on account switch failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}


/**
 * 该 runtime 是否仍是该账号当前缓存的 runtime.
 * 代理/账号信息切换后旧 runtime 会被顶替(byKey 指向新 runtime),
 * chat 流程借此识别"排队等锁期间已被切换"的请求并重新选号,
 * 而不是拿着旧出口的 runtime 去撞已被释放的旧 session.
 * @param {any} this 账号池(runtimes)
 * @param {{ key: string }} rt
 * @returns {any} 见实现
 */
export function isCurrentRuntime(this: any, rt: any) {
  return this.byKey.get(rt.key) === rt
}

/**
 * 丢弃单个账号的缓存 runtime(删除/改代理后调用,让新状态立即生效).
 * 立即让位(新请求走新 runtime),旧 session 等在途 SSE 结束后优雅释放,
 * 避免把正在传输的连接掐断.
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 */
export async function invalidate(this: any, key: any) {
  const rt = this.byKey.get(key)
  if (!rt) return
  this.byKey.delete(key)
  this._disposeRuntime(rt, 'account invalidated')
}

/**
 * 全部断开重连(比重启更轻量):释放所有账号的 session(清理死任务),
 * 并重置账号并发信号量(放行等待者,等待者会在 chat 流程重新 re-admit).
 * 不重启进程;下一个请求自动 admit 全新 session.
 * @param {any} this 账号池(runtimes)
 * @returns {Promise<Array<{key: string, email?: string, ok: boolean, error?: string}>>}
 */
export async function reconnectAll(this: any) {
  // 并发信号量与 runtime 的并集:无账号凭据的锁(如单元测试)也要重置
  const keys = [...new Set([...this.chatLocks.keys(), ...this.byKey.keys()])]
  const results = await Promise.all(
    keys.map(async (key: any) => {
      const rt = this.byKey.get(key)
      try {
        // 严格释放:等到上游确认结束或退避重试耗尽,失败带上原因----绝不
        // "报成功但其实没删掉"(删不掉 = 白白多扣一小时,见 issue #7).
        const rel = rt
          ? await rt.sessions.releaseStrict()
          : { ok: true, attempts: 0 }
        // 信号量重置:清空在途计数并放行排队等待者(等待者会在 chat
        // 流程重新检查 session 并 re-admit,不会卡死)
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
    ok: results.filter((r: any) => r.ok).length,
  })
  return results
}

/**
 * 代理池变更后调用: 立即重建所有缓存 runtime(新出口对新请求生效).
 *
 * 旧 runtime 的 session 等在途 SSE 结束后在后台优雅释放, 不直接 DELETE --
 * 避免把正在传输的流掐断导致客户端永久卡住.
 * @param {any} this 账号池(runtimes)
 * @returns {Promise<void>} 重建与释放排期完成即 resolve
 */
export async function invalidateProxies(this: any) {
  const oldRuntimes = [...this.byKey.values()]
  this.byKey.clear()
  for (const rt of oldRuntimes) {
    this._disposeRuntime(rt, 'proxy pool changed')
  }
  logger.info('proxy pool changed; cached runtimes invalidated', {
    count: oldRuntimes.length,
  })
}

/**
 * 追问待结算退款(钱,不是槽位):对每个挂起的 instance 重放一次 DELETE
 * 取终态回执,拿到才出队.由 serve.js 的低频定时器周期调用,进程不重启也会
 * 持续追问----这是"退款到底回没回来"能否成立的关键工程条件.
 * @param {any} this 账号池(runtimes)
 * @param {{budgetMs?: number}} [opts]
 * @returns {Promise<{settled:number, pending:number, failed:number, skipped:number, deferred:number}>}
 */
export async function sweepPendingRefunds(this: any, opts: any = {}) {
  const resolve = (key: any) => {
    try {
      return this.get(key)?.upstream || null
    } catch {
      return null
    }
  }
  return this.handleStore.sweepPendingRefunds(resolve, opts)
}

/**
 * 严格释放全部账号([断开全部连接]/[重启服务]/进程退出用):
 * 与 fire-and-forget 的 releaseSession 不同,这里等到每条会话都确认结束
 * 或重试耗尽才返回,并给出逐账号明细----绝不"报成功其实没删掉".
 * 失败的句柄仍留在 sessions.json,由下次启动扫尾继续清理.
 * @param {any} this 账号池(runtimes)
 * @param {any} this 账号池(runtimes)
 * @param {{waitInFlightMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, released: number,
 *   failed: Array<{key: string, instanceId?: string, error?: string}>}>} 释放结果明细
 */
export async function releaseAllStrict(this: any, opts: any = {}) {
  const waitMs = Number.isFinite(opts.waitInFlightMs)
    ? opts.waitInFlightMs
    : 0
  const runtimes = [...this.byKey.values()]
  const results = await Promise.all(
    runtimes.map(async (rt: any) => {
      if (waitMs > 0) {
        // 等在途 SSE 结束(有界):不掐断正在传输的流,超时就继续释放.
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
    .filter((r: any) => !r.ok)
    .map((r: any) => ({
      key: r.key,
      email: r.email,
      instanceId: r.instanceId,
      error: r.error || 'release failed',
    }))
  const released = results.filter((r: any) => r.ok).length
  if (failed.length) {
    logger.warn('strict release finished with failures (handles kept for retry)', {
      failed: failed.length,
      released,
    })
  }
  return { ok: failed.length === 0, released, failed }
}

/**
 * 进程退出前的收尾: 停计时器, 按 strict 决定释放强度.
 *
 * strict=true 走"逐次 DELETE 直到确认结束"(换容器/重启前的严格释放), 否则走
 * 普通 release. 绝不谎报成功: 失败的句柄留在 sessions.json 里.
 * @param {any} this 账号池(runtimes)
 * @param {any} [opts] strict=true 走严格释放
 * @returns {Promise<any>} 释放结果明细
 */
export async function shutdown(this: any, opts: any = {}) {
  const strict = opts.strict === true
  /** @type {{ok: boolean, released: number, failed: any[]}} */
  let rel = { ok: true, released: 0, failed: [] }
  if (strict) {
    // 进程退出:等到真的删掉或重试耗尽(句柄已落盘,失败也能下次扫尾).
    try {
      rel = await this.releaseAllStrict()
    } catch (err) {
      logger.warn('strict session release on shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      // 退回逐账号 shutdown(各自尽力 DELETE 一次)
      const tasks = [...this.byKey.values()].map((rt: any) => rt.sessions.shutdown())
      await Promise.allSettled(tasks)
      this.byKey.clear()
      return rel
    }
  }
  const tasks = [...this.byKey.values()].map((rt: any) => rt.sessions.shutdown())
  await Promise.allSettled(tasks)
  this.flushState()
  // 关闭所有出网 agent(keep-alive socket),别把句柄留给进程退出流程.
  await Promise.allSettled(
    [...this.byKey.values()].map((rt: any) => rt.upstream?.close?.()),
  )
  this.byKey.clear()
  return rel
}
