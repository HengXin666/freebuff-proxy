/**
 * 句柄与退款的扫尾流程 ---- 从 src/session-handles.ts 按职责切出.
 *
 * 为什么单独成文件: 两段扫尾(删句柄腾槽位 / 追待结算退款)是本文件里唯一
 * "真的会打上游"的部分, 而其余全是本地账本操作. 它们的共同硬约束是[有界]:
 * 启动路径绝不允许长时间阻塞 ---- 早期版本对每个句柄用 admitTimeoutMs(30s)
 * 且最多重放 3 次, 一个连不上的上游(DNS 黑洞 / 代理挂起 / 账号已删)就能把启动
 * 整整卡住十几分钟, 用户看到的是"起不来", 而删掉 sessions.json 立刻就好.
 *
 * 口径: 纯搬移, 行为零改动.
 *
 * 与 cleanupOrphans 的分工: 那个删句柄腾槽位, sweepRefunds 只追钱. 两者共用
 * 一份预算, 且都绝不因为"还是 pending"就丢弃记录.
 */
import { logger } from '../../util/log.ts'
import { sleep } from './records.ts'

/**
 * 启动扫尾的总预算(毫秒).启动路径绝不允许长时间阻塞----用户看到的是
 * "容器起不来",而实际上只是清孤儿慢(连不通的上游 / 已被删的账号).
 * 超出预算的句柄留在索引里,下次启动或后续释放流程继续清理.
 */
const STARTUP_SWEEP_BUDGET_MS = 15_000

/** 单次 DELETE 的上限(毫秒):上游正常时毫秒级返回,连不上时由预算兜底. */
const DELETE_ATTEMPT_TIMEOUT_MS = 8_000

/**
 * 构造一次"有预算上限的单次 DELETE 尝试".
 *
 * 单次尝试同样受预算约束, 并且预算内也必须有上限: 上游客户端会 abort 挂起的
 * fetch, 但假死连接可能永远不 settle ---- 所以这里再加一道本地硬超时, 让
 * [启动绝不长时间卡住]成为可证明的性质(而不是依赖上游客户端行为).
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
 * 启动扫尾:对所有遗留句柄发 DELETE 拿退款.只清理本进程已确认结束的,
 * 失败的保留在 index 里等下次启动继续(绝不谎报,绝不丢弃).
 * @param {any} self 句柄库实例(SessionHandleStore)
 * @param {(key: string) => any} resolveUpstream key → upstream client(可为空)
 * @param {{budgetMs?: number}} [opts] 本次扫尾的总预算(默认 15s)
 * @returns {Promise<{cleaned: number, failed: number, skipped: number, deferred: number}>} 逐类计数
 */
export async function cleanupOrphans(self: any, resolveUpstream: any, opts: any = {}) {
  const budgetMs = Number.isFinite(opts.budgetMs) ? Number(opts.budgetMs) : STARTUP_SWEEP_BUDGET_MS
  const deadline = Date.now() + budgetMs
  const pending = self.listOrphans()
  let cleaned = 0
  let failed = 0
  let skipped = 0
  let deferred = 0
  for (const o of pending) {
    if (Date.now() >= deadline) {
      deferred += 1
      continue
    }
    const upstream = resolveUpstream?.(o.key)
    if (!upstream) {
      // 账号已删除/凭据变更:没有对应 token 就删不掉,保留记录
      skipped += 1
      continue
    }
    const attempt = attemptOf(upstream, o.instanceId, deadline, '句柄')
    try {
      let body = await attempt()
      // 2026-09 实测:上游对提前结束的会话会持续回 freebucksRefundPending
      // (1.5s/7s/17s/37s/67s 五次重放全是 pending).有界重放后仍挂起
      // 不能丢弃句柄----结算还没跑完,丢了这笔预扣就永远要不回来.
      // 重放同样吃预算:启动路径上只允许 1 次,其余留给下次启动.
      let pendingRefund = body?.freebucksRefundPending === true
      for (let i = 0; pendingRefund && i < 1; i += 1) {
        if (Date.now() >= deadline - 300) break
        await sleep(1_200)
        body = await attempt()
        pendingRefund = body?.freebucksRefundPending === true
      }
      if (pendingRefund) {
        failed += 1
        logger.warn('leftover session refund still pending; keeping handle', {
          key: o.key,
          instanceId: o.instanceId,
          note: o.note,
        })
        continue
      }
      self.dropOrphan(o.instanceId)
      cleaned += 1
      logger.info('cleaned up leftover freebuff session (refund settled)', {
        key: o.key,
        instanceId: o.instanceId,
        refund: body?.freebucksRefund ?? null,
        note: o.note,
      })
    } catch (err) {
      failed += 1
      logger.warn('leftover session cleanup failed; keeping handle', {
        key: o.key,
        instanceId: o.instanceId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (cleaned || failed || skipped || deferred) {
    logger.info('session handle startup sweep done', { cleaned, failed, skipped, deferred })
  }
  return { cleaned, failed, skipped, deferred }
}

/**
 * 周期扫尾:追问所有待结算退款,拿到终态回执才出队.
 *
 * 为什么必须有它(而不是只在启动时扫一次):上游对提前结束的会话回
 * freebucksRefundPending,要求用同一个 instanceId 重放 DELETE 取回执.
 * 只在启动扫一次 = 进程不重启就再也没人问过,那笔预扣会永远挂在 pending 里.
 * 参考实现(trefeon/freebuff-proxy)同样把这件事做成常驻的:单飞重放 + 手动
 * Refresh 入口 + 夜间补跑.
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
