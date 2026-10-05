/**
 * 句柄与退款的扫尾流程.
 *
 * 两段扫尾(删句柄腾槽位 / 追待结算退款)是这一段里唯一"真的会打上游"的部分,
 * 其余全是本地账本操作. 它们的硬约束是[有界]: 每次尝试用 admitTimeoutMs(30s)
 * 且最多重放 3 次时, 一个连不上的上游(DNS 黑洞 / 代理挂起 / 账号已删)就能把启动
 * 卡住十几分钟 ---- 所以启动路径必须给总预算.
 *
 * 与 cleanupOrphans 的分工: 那个删句柄腾槽位, sweepRefunds 只追钱.
 */
import { logger } from '../../util/log.ts'
import { sleep } from './records.ts'
import { inPaidWindowFor } from '../core/lease.ts'

/**
 * 启动路径不允许长时间阻塞: 用户看到的是"容器起不来", 实际只是清孤儿慢
 * (连不通的上游 / 已被删的账号).超出预算的句柄留在索引里, 下次启动继续清理.
 */
const STARTUP_SWEEP_BUDGET_MS = 15_000

/** 单次 DELETE 的上限(毫秒):上游正常时毫秒级返回,连不上时由预算兜底. */
const DELETE_ATTEMPT_TIMEOUT_MS = 8_000

/**
 * 构造一次"有预算上限的单次 DELETE 尝试".
 *
 * 单次尝试同样受预算约束, 并且预算内也必须有上限: 上游客户端会 abort 挂起的
 * fetch, 但假死连接可能永远不 settle ---- 这里再加一道本地硬超时, 让
 * [启动不长时间卡住]成为可证明的性质, 不依赖上游客户端行为.
 * @param {any} upstream 该账号的上游客户端
 * @param {string} instanceId 会话实例 id
 * @param {number} deadline 本次扫尾的截止时间戳
 * @param {string} label 超时文案里的主语(句柄 / 记录)
 * @returns {() => Promise<any>} 单次尝试函数
 */
function attemptOf(upstream: any, instanceId: any, deadline: number, label: string) {
  return () => {
    const left = deadline - Date.now()
    const ms = Math.max(250, Math.min(DELETE_ATTEMPT_TIMEOUT_MS, left))
    return Promise.race([
      upstream.freebuffSession('DELETE', { instanceId, timeoutMs: ms }),
      sleep(ms).then(() => {
        throw new Error(`DELETE 无响应（${ms}ms 超时，${label}保留）`)
      }),
    ])
  }
}

/**
 * 启动扫尾:对已过付费时段的遗留句柄发 DELETE 拿退款.
 *
 * ## 为什么必须先判付费时段(2026-10-06)
 *
 * 遗留句柄有三种来源, 其中两种仍是实付的一小时:
 *   1. 上次进程被杀, 会话还在计费窗口内(本次要保护的);
 *   2. 上次释放失败(网络/上游 5xx), 句柄留在 orphan 里, 会话可能还活着;
 *   3. 上次释放成功但退款仍 pending(这时 expiresAt 多已过期, 或上游已回 ended).
 * 前两种若直接 DELETE, 就是[重启一次 = 扔掉一小时已买的额度]. 上游早退不退
 * Freebucks, 重开要再买一小时 ---- 与调度层[付费时段内不释放]是同一条判据,
 * 这里只是把它补到不持有 SessionManager 的那条路径上(见
 * src/session/core/lease.ts 的 inPaidWindowFor: 与 inPaidWindow 同源).
 *
 * 判不出来的(缺 expiresAt)按不删除处理: 宁可留一条待扫句柄, 不可赌着删.
 * @param {any} self 句柄库实例(SessionHandleStore)
 * @param {(key: string) => any} resolveUpstream key → upstream client(可为空)
 * @param {{budgetMs?: number, includePaid?: boolean}} [opts] 预算; includePaid=true
 *   时连付费时段内的句柄一起删(仅用于测试与显式强制清理, 启动路径一律用默认)
 * @returns {Promise<{cleaned: number, failed: number, skipped: number, deferred: number}>} 逐类计数
 */
export async function cleanupOrphans(self: any, resolveUpstream: any, opts: any = {}) {
  const budgetMs = Number.isFinite(opts.budgetMs) ? Number(opts.budgetMs) : STARTUP_SWEEP_BUDGET_MS
  const deadline = Date.now() + budgetMs
  const pending = self.listOrphans()
  const counts = { cleaned: 0, failed: 0, skipped: 0, deferred: 0 }
  for (const o of pending) {
    await sweepOne(self, o, resolveUpstream, deadline, counts, opts.includePaid === true)
  }
  if (counts.cleaned || counts.failed || counts.skipped || counts.deferred) {
    logger.info('session handle startup sweep done', counts)
  }
  return counts
}

/**
 * 扫尾一条遗留句柄, 就地累加计数.
 *
 * 三种"不动手"的原因必须分开记, 否则排障时看不出是钱没算完,账号没了,
 * 还是这一小时还没过:
 *   - deferred: 仍在已付费时段内(会话可能还活着, 留给调度层复用), 或预算用完;
 *   - skipped:  解析不到账号/凭据(没有 token 就删不掉);
 *   - failed:   尝试了但没拿到终态(仍 pending / 上游报错).
 * @param {any} self 句柄库实例
 * @param {any} o 一条遗留句柄
 * @param {(key: string) => any} resolveUpstream key → upstream
 * @param {number} deadline 本次扫尾的截止时间戳
 * @param {{cleaned: number, failed: number, skipped: number, deferred: number}} counts 就地累加
 * @param {boolean} includePaid 是否连付费时段内的也删
 * @returns {Promise<void>}
 */
async function sweepOne(
  self: any,
  o: any,
  resolveUpstream: any,
  deadline: number,
  counts: any,
  includePaid: boolean,
): Promise<void> {
  // 待结算退款队列里的 instanceId 已被上游确认结束, 剩下的只是[钱还没算完],
  // 不受付费时段保护 ---- 会话都不在了, 保留它没有[复用]可言.
  const refundOnly = new Set((self.listPendingRefunds?.() || []).map((r: any) => r.instanceId))
  if (!includePaid && !refundOnly.has(o.instanceId) && inPaidWindowFor(o)) {
    counts.deferred += 1
    logger.info('leftover session still inside its paid hour; keeping it for reuse', {
      key: o.key,
      instanceId: o.instanceId,
      expiresAt: o.expiresAt ?? null,
      note: o.note,
    })
    return
  }
  if (Date.now() >= deadline) {
    counts.deferred += 1
    return
  }
  const upstream = resolveUpstream?.(o.key)
  if (!upstream) {
    // 账号已删除/凭据变更:没有对应 token 就删不掉,保留记录
    counts.skipped += 1
    return
  }
  const attempt = attemptOf(upstream, o.instanceId, deadline, '句柄')
  try {
    const body = await replayForSettled(attempt, deadline)
    if (body.pendingRefund) {
      counts.failed += 1
      logger.warn('leftover session refund still pending; keeping handle', {
        key: o.key,
        instanceId: o.instanceId,
        note: o.note,
      })
      return
    }
    self.dropOrphan(o.instanceId)
    counts.cleaned += 1
    logger.info('cleaned up leftover freebuff session (refund settled)', {
      key: o.key,
      instanceId: o.instanceId,
      refund: body.refund,
      note: o.note,
    })
  } catch (err) {
    counts.failed += 1
    logger.warn('leftover session cleanup failed; keeping handle', {
      key: o.key,
      instanceId: o.instanceId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 重放 DELETE 直到结算落地(启动路径上最多重放 1 次).
 *
 * 上游对提前结束的会话会持续回 freebucksRefundPending
 * (1.5s/7s/17s/37s/67s 五次重放全是 pending). 有界重放后仍挂起不能丢弃句柄
 * ---- 结算还没跑完, 丢了这笔预扣就永远要不回来.
 * @param {() => Promise<any>} attempt 单次 DELETE 尝试
 * @param {number} deadline 本次扫尾的截止时间戳
 * @returns {Promise<{pendingRefund: boolean, refund: number | null}>} 终态判据与退款额
 */
async function replayForSettled(attempt: any, deadline: number) {
  let body = await attempt()
  let pendingRefund = body?.freebucksRefundPending === true
  for (let i = 0; pendingRefund && i < 1; i += 1) {
    if (Date.now() >= deadline - 300) break
    await sleep(1_200)
    body = await attempt()
    pendingRefund = body?.freebucksRefundPending === true
  }
  return {
    pendingRefund,
    refund: typeof body?.freebucksRefund === 'number' ? body.freebucksRefund : null,
  }
}

/**
 * 周期扫尾:追问所有待结算退款,拿到终态回执才出队.
 *
 * 必须有它: 上游对提前结束的会话回 freebucksRefundPending, 要求用同一个
 * instanceId 重放 DELETE 取回执. 只在启动时扫一次 = 进程不重启就再也没人问过,
 * 那笔预扣会永远挂在 pending 里.
 * @param {any} self 句柄库实例(SessionHandleStore)
 * @param {(key: string) => any} resolveUpstream key → upstream client(可为空)
 * @param {{budgetMs?: number, onSettled?: (info: {key: string, instanceId: string,
 *   refund: number | null}) => void}} [opts] 预算与结算回调
 * @returns {Promise<{settled: number, pending: number, failed: number, skipped: number, deferred: number}>} 逐类计数
 */
export async function sweepRefunds(self: any, resolveUpstream: any, opts: any = {}) {
  const budgetMs = Number.isFinite(opts.budgetMs)
    ? Number(opts.budgetMs)
    : STARTUP_SWEEP_BUDGET_MS
  const deadline = Date.now() + budgetMs
  const list = self.listPendingRefunds()
  let settled = 0
  let pending = 0
  let failed = 0
  let skipped = 0
  let deferred = 0
  for (const r of list) {
    if (Date.now() >= deadline) {
      deferred += 1
      continue
    }
    const upstream = resolveUpstream?.(r.key)
    if (!upstream) {
      // 账号已删/凭据已换:没有 token 就问不了,记录留着(绝不静默丢弃).
      skipped += 1
      continue
    }
    const attempt = attemptOf(upstream, r.instanceId, deadline, '记录')
    try {
      const body = await attempt()
      if (body?.freebucksRefundPending === true) {
        // 还没算完:留在队列里等下一次(记一次尝试次数).
        self.notePendingRefund(r.key, r.instanceId, r.model)
        pending += 1
        continue
      }
      if (body?.status !== 'ended') {
        // 既非终态也非 pending:保留记录(绝不当作退 0).
        pending += 1
        continue
      }
      // 终态:没有金额字段就是退 0(vendor af898dc 口径),0 也是终态,可以收工.
      const refund =
        typeof body?.freebucksRefund === 'number' ? body.freebucksRefund : 0
      self.dropPendingRefund(r.key, r.instanceId)
      settled += 1
      logger.info('pending refund settled', {
        key: r.key,
        instanceId: r.instanceId,
        refund,
        attempts: r.attempts,
      })
      opts.onSettled?.({ key: r.key, instanceId: r.instanceId, refund })
    } catch (err) {
      failed += 1
      logger.warn('pending refund replay failed; record kept', {
        key: r.key,
        instanceId: r.instanceId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (settled || pending || failed || skipped || deferred) {
    logger.info('pending refund sweep done', { settled, pending, failed, skipped, deferred })
  }
  return { settled, pending, failed, skipped, deferred }
}
