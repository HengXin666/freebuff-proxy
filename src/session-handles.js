import fs from 'node:fs'
import path from 'node:path'
import { logger } from './util/log.js'

/**
 * 上游会话句柄的**持久化索引**（/data/sessions.json）。
 *
 * 为什么必须有它：Freebuff 的 session 是「admit 即开始按小时计价、提前 DELETE
 * 才按未用时长退款」的计费行。句柄（instanceId）只存在内存里时，一次进程重启
 * / 换容器 / /data 重挂，活着的会话就变成**无法寻址的孤儿**——既删不掉也退不了
 * 款，只能让上游白扣满一小时。所以每次 admit/释放都把句柄落盘，启动时按这份
 * 索引做一次扫尾 DELETE（拿回退款），平时释放失败的句柄也留在里面等下次机会。
 *
 * 文件形如：
 *   { version:1, updatedAt, sessions:[{key,instanceId,model,admittedAt,expiresAt}],
 *     orphans:[{key,instanceId,model,admittedAt,expiresAt,note}] }
 * sessions = 本进程当前持有的活会话；orphans = DELETE 一直失败、暂时失联但仍
 * 需要继续尝试清理的句柄（绝不静默丢弃）。
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
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      // 上次进程遗留的 sessions 一律视为孤儿：本进程还没 admit 过任何会话，
      // 这些句柄要么还有效（需要 DELETE 退款）要么已过期（DELETE 无害）。
      for (const s of Array.isArray(raw?.sessions) ? raw.sessions : []) {
        if (s?.key && s?.instanceId) {
          this.orphans.push({ ...normalize(s), note: 'carried over from previous run' })
        }
      }
      for (const s of Array.isArray(raw?.orphans) ? raw.orphans : []) {
        if (s?.key && s?.instanceId) this.orphans.push({ ...normalize(s), note: s.note })
      }
      this.sessions.clear()
    } catch (err) {
      logger.warn('session handle store load failed', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      })
    }
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
   * @param {(key: string) => any} resolveUpstream key → upstream client（可为空）
   * @returns {Promise<{cleaned: number, failed: number, skipped: number}>}
   */
  async cleanupOrphans(resolveUpstream) {
    const pending = this.listOrphans()
    let cleaned = 0
    let failed = 0
    let skipped = 0
    for (const o of pending) {
      const upstream = resolveUpstream?.(o.key)
      if (!upstream) {
        // 账号已删除/凭据变更：没有对应 token 就删不掉，保留记录
        skipped += 1
        continue
      }
      try {
        let body = await upstream.freebuffSession('DELETE', {
          instanceId: o.instanceId,
        })
        // 2026-09 实测：上游对提前结束的会话会持续回 freebucksRefundPending
        // （1.5s/7s/17s/37s/67s 五次重放全是 pending）。有界重放后仍挂起
        // **不能丢弃句柄**——结算还没跑完，丢了这笔预扣就永远要不回来。
        let pending = body?.freebucksRefundPending === true
        for (let i = 0; pending && i < 2; i += 1) {
          await sleep(i === 0 ? 1_200 : 4_000)
          body = await upstream.freebuffSession('DELETE', {
            instanceId: o.instanceId,
          })
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
    if (cleaned || failed || skipped) {
      logger.info('session handle startup sweep done', { cleaned, failed, skipped })
    }
    return { cleaned, failed, skipped }
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
