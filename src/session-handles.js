import fs from 'node:fs'
import path from 'node:path'
import { logger } from './util/log.js'
import {
  readJsonFileState,
  noteDataFile,
  noteDroppedEntries,
  noteOpenHandles,
  dumpDroppedEntries,
} from './util/json-store.js'

/**
 * 启动扫尾的总预算（毫秒）。启动路径**绝不允许**长时间阻塞——用户看到的是
 * "容器起不来"，而实际上只是清孤儿慢（连不通的上游 / 已被删的账号）。
 * 超出预算的句柄留在索引里，下次启动或后续释放流程继续清理。
 */
const STARTUP_SWEEP_BUDGET_MS = 15_000

/** 单次 DELETE 的上限（毫秒）：上游正常时毫秒级返回，连不上时由预算兜底。 */
const DELETE_ATTEMPT_TIMEOUT_MS = 8_000

/**
 * 上游会话句柄的**持久化索引**（/data/sessions.json）。
 *
 * 为什么必须有它：Freebuff 的 session 是「admit 一次就按整小时买断」的计费行——
 * 早退 DELETE 不退 Freebucks（2026-09-13 实测，见 docs/account-scheduling-and-refund.md §3）。
 * 句柄（instanceId）只存在内存里时，一次进程重启 / 换容器 / /data 重挂，活着的会话
 * 就变成**无法寻址的孤儿**：既删不掉，也会一直占着上游会话槽位（该账号再也 admit
 * 不了新模型）。所以每次 admit/释放都把句柄落盘，启动时按这份索引做一次扫尾 DELETE
 * 释放槽位，平时释放失败的句柄也留在里面等下次机会。
 *
 * 文件形如：
 *   { version:1, updatedAt, sessions:[{key,instanceId,model,admittedAt,expiresAt}],
 *     orphans:[{key,instanceId,model,admittedAt,expiresAt,note}] }
 * sessions = 本进程当前持有的活会话；orphans = DELETE 一直失败、暂时失联但仍
 * 需要继续尝试清理的句柄（绝不静默丢弃）。
 *
 * **启动扫尾是有界的**：总预算 STARTUP_SWEEP_BUDGET_MS、单次 DELETE
 * DELETE_ATTEMPT_TIMEOUT_MS，超预算的句柄原样留下（信息不丢、只是不挡启动）。
 * 别把预算删掉"图省事"——启动被清孤儿卡住是"服务起不来、删 sessions.json 就好"
 * 的真实成因（见 .agents/notes/implemented/bug-fix/2026-09-13-startup-path-bounded.md）。
 */
export class SessionHandleStore {
  /**
   * @param {string} file e.g. /data/sessions.json
   */
  constructor(file) {
    this.file = file
    /** @type {Map<string, {key:string,instanceId:string,model:string,admittedAt?:string|null,expiresAt?:string|null}>} */
    this.sessions = new Map()
    /** @type {Array<{key:string,instanceId:string,model?:string|null,admittedAt?:string|null,expiresAt?:string|null,note?:string}>} */
    this.orphans = []
    /** 装载结果（'ok' | 'missing' | 'invalid'）。损坏 = 句柄索引丢失 = 上游会话
     * 变成无法寻址的计费孤儿（删不掉、也释放不了槽位），必须在启动横幅里点名。 */
    this.loadStatus = 'missing'
    this.loadReason = null
    this.load()
  }

  load() {
    const st = readJsonFileState(this.file)
    noteDataFile(this.file, st)
    this.loadStatus = st.status
    this.loadReason = st.status === 'invalid' ? st.reason : null
    if (st.status !== 'ok') {
      if (st.status === 'invalid') {
        logger.warn('数据文件损坏: 会话句柄索引，无法扫尾退款', {
          file: this.file,
          reason: st.reason,
        })
      }
      return st
    }
    try {
      const raw = st.data
      // 上次进程遗留的 sessions 一律视为孤儿：本进程还没 admit 过任何会话，
      // 这些句柄要么还有效（需要 DELETE 退款）要么已过期（DELETE 无害）。
      // 逐条口径：**只取用得上的记录，绝不为一条脏数据拒绝启动**。
      // sessions.json 是"重启后还能寻址 DELETE"的索引，丢了只是槽位回收变慢，
      // 不值得让整个服务停摆——它与 users.json（凭据真源，坏了必须拒绝启动）不同。
      // 但"丢了几条"必须记账：否则文件里明明有东西、控制台却说一切正常。
      /** @type {any[]} */
      const droppedItems = []
      for (const s of Array.isArray(raw?.sessions) ? raw.sessions : []) {
        if (s && typeof s === 'object' && s.key && s.instanceId) {
          this.orphans.push({ ...normalize(s), note: 'carried over from previous run' })
        } else {
          droppedItems.push(s)
        }
      }
      for (const s of Array.isArray(raw?.orphans) ? raw.orphans : []) {
        if (s && typeof s === 'object' && s.key && s.instanceId) {
          this.orphans.push({ ...normalize(s), note: s.note })
        } else {
          droppedItems.push(s)
        }
      }
      this.sessions.clear()
      if (droppedItems.length) {
        // 结构与 web-sessions/login-flows 的脏条目同源（null / {} / 字符串），
        // 统一按"条目级丢弃"记账：控制台能看到条数与留证，不必人工删文件。
        const backup = dumpDroppedEntries(this.file, droppedItems)
        noteDroppedEntries(
          this.file,
          droppedItems.length,
          `${droppedItems.length} 条会话句柄记录缺少 key/instanceId，已跳过（无法寻址 DELETE）`,
          backup,
        )
        logger.warn('会话句柄索引含非法条目，已跳过', {
          file: this.file,
          dropped: droppedItems.length,
          backup,
        })
      }
      // 合法句柄一律进 orphans 队列（本次进程还没 admit 过任何会话，
      // 上次遗留的句柄要么还有效要 DELETE、要么已过期 DELETE 无害）。
      noteOpenHandles(this.file, this.orphans.length)
    } catch (err) {
      // 已经解析成 JSON 了：这里只可能是字段结构问题（Array.isArray 之后基本
      // 不会抛）。保留原来的兜底，不让启动流程被一个索引文件拖死。
      logger.warn('session handle store load failed', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return st
  }

  /**
   * 处理 SessionManager 上报的事件：
   *   {type:'track', key, instanceId, ...} 当前活会话（覆盖）
   *   {type:'clear', key}                 该账号已无活会话
   *   {type:'orphan', key, instanceId, ...} 删不掉的句柄，继续排队清理
   */
  handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    const key = ev.key
    if (!key) return
    if (ev.type === 'track' && ev.instanceId) {
      this.sessions.set(key, normalize(ev))
      this.orphans = this.orphans.filter(
        (o) => !(o.key === key && o.instanceId === ev.instanceId),
      )
      this.save()
      return
    }
    if (ev.type === 'clear') {
      this.sessions.delete(key)
      this.save()
      return
    }
    if (ev.type === 'orphan' && ev.instanceId) {
      this.sessions.delete(key)
      if (!this.orphans.some((o) => o.instanceId === ev.instanceId)) {
        this.orphans.push({ ...normalize(ev), note: 'release failed; queued for cleanup' })
      }
      this.save()
      return
    }
    // 结算终于落地（或上游确认该 instance 已终结）：把排队中的 orphan 摘掉。
    // 少了这一步，orphan 会永远留在 sessions.json 里，每次进程启动都对着同一条
    // 早已结算的 instance 重放 DELETE（我的 (7.5) 回归用例就是这么抓到的）。
    if (ev.type === 'drop' && ev.instanceId) {
      this.dropOrphan(ev.instanceId)
    }
  }

  /** 当前活会话（本进程持有）。 */
  list() {
    return [...this.sessions.values()]
  }

  /** 待清理句柄（含本次与上次进程遗留）。 */
  listOrphans() {
    return [...this.orphans]
  }

  /** 移除一条孤儿记录（清理成功后调用）。 */
  dropOrphan(instanceId) {
    const before = this.orphans.length
    this.orphans = this.orphans.filter((o) => o.instanceId !== instanceId)
    if (this.orphans.length !== before) this.save()
  }

  /**
   * 启动扫尾：对所有遗留句柄发 DELETE 拿退款。**只清理本进程已确认结束的**，
   * 失败的保留在 index 里等下次启动继续（绝不谎报、绝不丢弃）。
   *
   * ⚠️ **必须有总预算与单次超时**：早期版本对每个句柄用 admitTimeoutMs(30s)
   * 且最多重放 3 次，一个连不上的上游（DNS 黑洞 / 代理挂起 / 账号已删）就能把
   * 启动**整整卡住**十几分钟，用户看到的是"起不来"，而删掉 sessions.json 立刻
   * 就好——这正是"删这个文件就正常"最典型的形态。启动路径只允许有界等待：
   * 超预算的句柄留在索引里，下次启动或后续释放流程继续（信息不丢，只是不挡路）。
   * @param {(key: string) => any} resolveUpstream key → upstream client（可为空）
   * @param {{budgetMs?: number}} [opts] 本次扫尾的总预算（默认 15s）
   * @returns {Promise<{cleaned: number, failed: number, skipped: number, deferred: number}>}
   */
  async cleanupOrphans(resolveUpstream, opts = {}) {
    const budgetMs = Number.isFinite(opts.budgetMs) ? Number(opts.budgetMs) : STARTUP_SWEEP_BUDGET_MS
    const deadline = Date.now() + budgetMs
    const pending = this.listOrphans()
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
        // 账号已删除/凭据变更：没有对应 token 就删不掉，保留记录
        skipped += 1
        continue
      }
      // 单次尝试同样受预算约束，并且**预算内也必须有上限**：上游客户端会 abort
      // 挂起的 fetch，但假死连接可能永远不 settle——所以这里再加一道本地硬超时，
      // 让「启动绝不长时间卡住」成为可证明的性质（而不是依赖上游客户端行为）。
      const attempt = () => {
        const left = deadline - Date.now()
        const ms = Math.max(250, Math.min(DELETE_ATTEMPT_TIMEOUT_MS, left))
        return Promise.race([
          upstream.freebuffSession('DELETE', { instanceId: o.instanceId, timeoutMs: ms }),
          sleep(ms).then(() => {
            throw new Error(`DELETE 无响应（${ms}ms 超时，句柄保留）`)
          }),
        ])
      }
      try {
        let body = await attempt()
        // 2026-09 实测：上游对提前结束的会话会持续回 freebucksRefundPending
        // （1.5s/7s/17s/37s/67s 五次重放全是 pending）。有界重放后仍挂起
        // **不能丢弃句柄**——结算还没跑完，丢了这笔预扣就永远要不回来。
        // 重放同样吃预算：启动路径上只允许 1 次，其余留给下次启动。
        let pending = body?.freebucksRefundPending === true
        for (let i = 0; pending && i < 1; i += 1) {
          if (Date.now() >= deadline - 300) break
          await sleep(1_200)
          body = await attempt()
          pending = body?.freebucksRefundPending === true
        }
        if (pending) {
          failed += 1
          logger.warn('leftover session refund still pending; keeping handle', {
            key: o.key,
            instanceId: o.instanceId,
            note: o.note,
          })
          continue
        }
        this.dropOrphan(o.instanceId)
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

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        sessions: this.list(),
        orphans: this.listOrphans(),
      }
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      // 控制台「系统」页的"待结算句柄数"跟着落盘一起刷新（claim/释放都会改它）。
      noteOpenHandles(this.file, this.sessions.size + this.orphans.length)
    } catch (err) {
      logger.warn('session handle store save failed', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

function normalize(s) {
  return {
    key: s.key,
    instanceId: s.instanceId,
    model: s.model ?? null,
    admittedAt: s.admittedAt ?? null,
    expiresAt: s.expiresAt ?? null,
  }
}

/** 有界等待（毫秒）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}
