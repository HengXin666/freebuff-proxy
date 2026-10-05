/**
 * 句柄库的本地账本操作.
 *
 * 事件归类 / 列表 / 落盘 / 删除接口都是"改内存里的三张表再落盘";
 * "启动时怎么从磁盘装回来"在 load.ts, "怎么打上游追退款"在 sweeps.ts.
 *
 * 本模块不持有状态: 全部读写都发生在 self 上.
 */
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../../util/log.ts'
import { noteOpenHandles } from '../../util/json-store.ts'
import { normalize, refundKey } from './records.ts'

/**
 * 处理 SessionManager 上报的事件.
 *
 * {type:'track', key, instanceId, ...} 当前活会话(覆盖)
 * {type:'clear', key}                 该账号已无活会话
 * {type:'orphan', key, instanceId, ...} 删不掉的句柄,继续排队清理
 * {type:'refund_pending', ...}        上游回 freebucksRefundPending,入队追问
 * {type:'drop', ...}                  结算落地,摘掉排队中的 orphan 与退款记录
 * @param {any} self 句柄库实例(SessionHandleStore)
 * @param {any} ev 事件
 * @returns {void} 无返回
 */
export function handleEvent(self: any, ev: any) {
  if (!ev || typeof ev !== 'object') return
  const key = ev.key
  if (!key) return
  if (ev.type === 'track' && ev.instanceId) {
    self.sessions.set(key, normalize(ev))
    self.orphans = self.orphans.filter(
      (o: any) => !(o.key === key && o.instanceId === ev.instanceId),
    )
    self.save()
    return
  }
  if (ev.type === 'clear') {
    self.sessions.delete(key)
    self.save()
    return
  }
  if (ev.type === 'orphan' && ev.instanceId) {
    self.sessions.delete(key)
    if (!self.orphans.some((o: any) => o.instanceId === ev.instanceId)) {
      self.orphans.push({ ...normalize(ev), note: 'release failed; queued for cleanup' })
    }
    self.save()
    return
  }
  // 上游回 freebucksRefundPending:这笔钱还没结算完,入队持续追问.
  // 不能只在内存里挂个定时器----进程重启就没了,那笔预扣再也追不回来.
  if (ev.type === 'refund_pending' && ev.instanceId) {
    self.notePendingRefund(key, ev.instanceId, ev.model ?? null)
    return
  }
  // 结算终于落地(或上游确认该 instance 已终结):把排队中的 orphan 摘掉.
  // 少了这一步,orphan 会永远留在 sessions.json 里,每次进程启动都对着同一条
  // 早已结算的 instance 重放 DELETE(我的 (7.5) 回归用例就是这么抓到的).
  if (ev.type === 'drop' && ev.instanceId) {
    self.dropOrphan(ev.instanceId)
    self.dropPendingRefund(key, ev.instanceId)
  }
}

/**
 * 记下一条待结算退款(上游回 freebucksRefundPending).
 *
 * 幂等: 同一条 instance 反复入队只累加 attempts, 不产生重复项.
 * @param {any} self 句柄库实例(SessionHandleStore)
 * @param {any} key 账号 key
 * @param {any} instanceId 会话实例 id
 * @param {any} [model] 该会话绑定的模型
 * @returns {void} 无返回
 */
export function notePendingRefund(self: any, key: any, instanceId: any, model = null) {
  if (!key || !instanceId) return
  const k = refundKey(key, instanceId)
  const prev = self.pendingRefunds.get(k)
  self.pendingRefunds.set(k, {
    key,
    instanceId,
    model: model ?? prev?.model ?? null,
    attempts: (prev?.attempts ?? 0) + 1,
    firstSeenAt: prev?.firstSeenAt ?? new Date().toISOString(),
    lastTriedAt: new Date().toISOString(),
  })
  self.save()
}

/**
 * 出队(只在拿到终态回执后调用----含退款 0).
 *
 * 只在拿到终态回执后出队: pending 的语义是"最终用量还没算完", 提前出队等于主动
 * 放弃这笔已经预扣的 Freebucks.
 * @param {any} self 句柄库实例(SessionHandleStore)
 * @param {any} key 账号 key
 * @param {any} instanceId 会话实例 id
 * @returns {boolean} 是否真的移除了记录
 */
export function dropPendingRefund(self: any, key: any, instanceId: any) {
  if (!key || !instanceId) return false
  const removed = self.pendingRefunds.delete(refundKey(key, instanceId))
  if (removed) self.save()
  return removed
}

/**
 * 移除一条孤儿记录(清理成功后调用).
 * @param {any} self 句柄库实例(SessionHandleStore)
 * @param {any} instanceId 会话实例 id
 * @returns {void} 无返回
 */
export function dropOrphan(self: any, instanceId: any) {
  const before = self.orphans.length
  self.orphans = self.orphans.filter((o: any) => o.instanceId !== instanceId)
  if (self.orphans.length !== before) self.save()
}

/**
 * 把三张表落盘(原子写: tmp + rename, 0o600).
 * @param {any} self 句柄库实例(SessionHandleStore)
 * @returns {void} 无返回
 */
export function saveHandles(self: any) {
  try {
    fs.mkdirSync(path.dirname(self.file), { recursive: true })
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: self.list(),
      orphans: self.listOrphans(),
      pendingRefunds: self.listPendingRefunds(),
    }
    const tmp = `${self.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, self.file)
    // 控制台[系统]页的"待结算句柄数"跟着落盘一起刷新(claim/释放都会改它).
    noteOpenHandles(self.file, self.sessions.size + self.orphans.length)
  } catch (err) {
    logger.warn('session handle store save failed', {
      file: self.file,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
