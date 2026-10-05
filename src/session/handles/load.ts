/**
 * 句柄索引文件的装载 ---- 从 src/session-handles.ts 按职责切出.
 *
 * 为什么单独成文件: 这一段是"磁盘上那个 sessions.json 到底能不能用"的完整
 * 判据(三态 + 逐条丢弃记账), 与 store 的常规操作(记事件 / 保存)是两种时机.
 * 放在类里会让 491 行的类同时承担启动期的容错策略与稳态的账本操作.
 *
 * 口径: 纯搬移, 行为零改动.
 *
 * 上次进程遗留的 sessions 一律视为孤儿: 本进程还没 admit 过任何会话, 这些句柄
 * 要么还有效(需要 DELETE 退款)要么已过期(DELETE 无害). 逐条口径: 只取用得上
 * 的记录, 绝不为一条脏数据拒绝启动.
 */
import { logger } from '../../util/log.ts'
import {
  readJsonFileState,
  noteDataFile,
  noteDroppedEntries,
  noteOpenHandles,
  dumpDroppedEntries,
} from '../../util/json-store.ts'
import { normalize, refundKey } from './records.ts'

/**
 * 把索引文件装载进 store(就地写 store.orphans / store.pendingRefunds).
 *
 * sessions.json 是"重启后还能寻址 DELETE"的索引, 丢了只是槽位回收变慢,
 * 不值得让整个服务停摆 ---- 它与 users.json(凭据真源, 坏了必须拒绝启动)不同.
 * 但"丢了几条"必须记账: 否则文件里明明有东西, 控制台却说一切正常.
 * @param {any} self 句柄库实例(SessionHandleStore)
 * @returns {any} 读盘三态(含 status 与 data)
 */
export function loadHandles(self: any) {
  const st = readJsonFileState(self.file)
  noteDataFile(self.file, st)
  self.loadStatus = st.status
  self.loadReason = st.status === 'invalid' ? st.reason : null
  if (st.status !== 'ok') {
    if (st.status === 'invalid') {
      logger.warn('数据文件损坏: 会话句柄索引，无法扫尾退款', {
        file: self.file,
        reason: st.reason,
      })
    }
    return st
  }
  try {
    const raw = st.data
    /** @type {any[]} */
    const droppedItems = []
    for (const s of Array.isArray(raw?.sessions) ? raw.sessions : []) {
      if (s && typeof s === 'object' && s.key && s.instanceId) {
        self.orphans.push({ ...normalize(s), note: 'carried over from previous run' })
      } else {
        droppedItems.push(s)
      }
    }
    for (const s of Array.isArray(raw?.orphans) ? raw.orphans : []) {
      if (s && typeof s === 'object' && s.key && s.instanceId) {
        self.orphans.push({ ...normalize(s), note: s.note })
      } else {
        droppedItems.push(s)
      }
    }
    for (const r of Array.isArray(raw?.pendingRefunds) ? raw.pendingRefunds : []) {
      if (r && typeof r === 'object' && r.key && r.instanceId) {
        self.pendingRefunds.set(refundKey(r.key, r.instanceId), {
          key: r.key,
          instanceId: r.instanceId,
          model: r.model ?? null,
          attempts: Number(r.attempts) || 0,
          firstSeenAt: r.firstSeenAt ?? null,
          lastTriedAt: r.lastTriedAt ?? null,
        })
      } else {
        droppedItems.push(r)
      }
    }
    self.sessions.clear()
    if (droppedItems.length) {
      // 结构与 web-sessions/login-flows 的脏条目同源(null / {} / 字符串),
      // 统一按"条目级丢弃"记账:控制台能看到条数与留证,不必人工删文件.
      const backup = dumpDroppedEntries(self.file, droppedItems)
      noteDroppedEntries(
        self.file,
        droppedItems.length,
        `${droppedItems.length} 条会话句柄记录缺少 key/instanceId，已跳过（无法寻址 DELETE）`,
        backup,
      )
      logger.warn('会话句柄索引含非法条目，已跳过', {
        file: self.file,
        dropped: droppedItems.length,
        backup,
      })
    }
    // 合法句柄一律进 orphans 队列(本次进程还没 admit 过任何会话,
    // 上次遗留的句柄要么还有效要 DELETE,要么已过期 DELETE 无害).
    noteOpenHandles(self.file, self.orphans.length)
  } catch (err) {
    // 已经解析成 JSON 了:这里只可能是字段结构问题(Array.isArray 之后基本
    // 不会抛).保留原来的兜底,不让启动流程被一个索引文件拖死.
    logger.warn('session handle store load failed', {
      file: self.file,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return st
}
