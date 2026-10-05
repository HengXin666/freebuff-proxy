import fs from 'node:fs'
import path from 'node:path'
import { logger } from './util/log.ts'
import { readJsonFileState, noteDataFile } from './util/json-store.ts'
import { normalizeAccountState, recordRefund, refundsOf } from './account-state/records.ts'

/**
 - 账号运行状态的持久化账本(/data/account-state.json).
 *
 - 落盘的字段: 加入时间(firstSeenAt), 封禁时间(bannedAt), 请求数(requests),
 - 最近使用时间(lastUsedAt), 冷却(cooldowns), Freebucks 余额与单价, 每日额度,
 - 最近一次探测结果; 启动时回灌进内存.
 - 文件形如:
 - { version:1, updatedAt, total, lastSuccessKey,
 - accounts: { <accountKey>: {
 - email, firstSeenAt, bannedAt, requests, lastUsedAt,
 - cooldowns: { <cooldownKey>: { until, code, model? } },
 - freebucks, quota, lastProbe } } }
 *
 - 行为要点:
 - - 写盘是去抖 + 原子(tmp+rename, 0o600): 热路径上的多次改动合并成一次延迟写,
 - 进程退出前 flush.
 - - 读盘永不抛: 账本坏了也只当没有(控制台少显示点, 但不影响转发).
 - - 账号被删除时同步清掉记录, 避免文件无限增长与幽灵账号.
 *
 - 读盘的逐字段归一在 ./account-state/records.ts, 本类只保留状态机与落盘.
 */
export class AccountStateStore {
  declare file: any
  declare _timer: any
  declare state: any
  declare loadStatus: any
  declare loadReason: any
  /**
   - @param {string} file e.g. /data/account-state.json
   */
  constructor(file: any) {
    this.file = file
    /** 去抖写盘定时器. */
    this._timer = null
    /** @type {{ version: number, updatedAt: string | null, total: number, lastSuccessKey: string | null, accounts: Record<string, any> }} */
    this.state = normalizeAccountState(null)
    /** 装载结果('ok' | 'missing' | 'invalid'):损坏即视为空账本. */
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
        logger.warn('account-state: 读取失败，按空账本继续', {
          file: this.file,
          reason: st.reason,
        })
      }
      return st
    }
    try {
      this.state = normalizeAccountState(st.data)
    } catch (err) {
      logger.warn('account-state: 读取失败，按空账本继续', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return st
  }

  /**
   - 取(必要时创建)某账号的记录;新账号在此盖上"加入时间".
   - @param {string} key
   - @param {string} [importedAtHint] 已知的加入时间(通常取凭据文件的创建时间)
   - ----比"账本第一次见到它"更准:老账号升级到本账本时不该被记成今天刚加入.
   */
  account(key: any, importedAtHint = null) {
    if (!key) return null
    let rec = this.state.accounts[key]
    if (!rec) {
      const hint = importedAtHint ? Date.parse(importedAtHint) : NaN
      const firstSeenAt = Number.isFinite(hint)
        ? new Date(hint).toISOString()
        : new Date().toISOString()
      rec = {
        firstSeenAt,
        // importedAt = 明确的"导入时间".老账号没有这个字段,回落 firstSeenAt
        // (同一时刻的近似值),保证前端永远有一个可展示的值.
        importedAt: firstSeenAt,
        bannedAt: null,
        requests: 0,
        lastUsedAt: null,
        // 累计调度时长(毫秒):会话在途归零时累加.0 = 从未被调度过.
        scheduledMs: 0,
        schedulingSince: null,
        lastScheduledAt: null,
      }
      this.state.accounts[key] = rec
      this._schedule()
    } else if (!rec.firstSeenAt && importedAtHint) {
      const hint = Date.parse(importedAtHint)
      if (Number.isFinite(hint)) {
        rec.firstSeenAt = new Date(hint).toISOString()
        this._schedule()
      }
    }
    // 老账号升级:补齐 importedAt(用 firstSeenAt 近似),只补一次.
    if (rec && !rec.importedAt && rec.firstSeenAt) {
      rec.importedAt = rec.firstSeenAt
      this._schedule()
    }
    return rec
  }

  /**
   - 累加一次"调度时长"(毫秒).会话在途归零时调用.
   - 与 requests 的区别:requests 是"被选中几次",scheduledMs 是"真正占用了
   - 多久"----长对话 1 次可能顶短批量几百次,两个指标都要看.
   - @param {string} key
   - @param {number} ms
   */
  recordScheduling(key: any, ms: any) {
    if (!key || !Number.isFinite(ms) || ms <= 0) return
    const rec = this.account(key)
    if (!rec) return
    rec.scheduledMs = Math.round(Number(rec.scheduledMs || 0) + ms)
    rec.lastScheduledAt = new Date().toISOString()
    rec.schedulingSince = null
    this._schedule()
  }

  /** 合并写入一个账号记录(值为 undefined 的字段不动). */
  patch(key: any, fields: any) {
    const rec = this.account(key)
    if (!rec || !fields) return
    let dirty = false
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue
      if (JSON.stringify(rec[k]) === JSON.stringify(v)) continue
      if (v === null) delete rec[k]
      else rec[k] = v
      dirty = true
    }
    if (dirty) this._schedule()
  }

  /** 删除已不存在的账号记录;顺带保留"最后一个账号"的兜底(见 prune). */
  prune(validKeys: any) {
    const keep = validKeys instanceof Set ? validKeys : new Set(validKeys || [])
    const accounts = this.state.accounts
    let removed = 0
    for (const key of Object.keys(accounts)) {
      if (keep.has(key)) continue
      // 邮箱 key 的旧布局记录:把"加入时间/封禁时间"迁移给同邮箱的新 key 记录后删除.
      const rec = accounts[key]
      const email = String(rec?.email || '').toLowerCase()
      const successor = email
        ? Object.keys(accounts).find(
            (k) => k !== key && keep.has(k) && k.toLowerCase() === email,
          )
        : null
      if (successor && accounts[successor]) {
        if (!accounts[successor].firstSeenAt && rec?.firstSeenAt) {
          accounts[successor].firstSeenAt = rec.firstSeenAt
        }
        if (!accounts[successor].bannedAt && rec?.bannedAt) {
          accounts[successor].bannedAt = rec.bannedAt
        }
      }
      delete accounts[key]
      removed += 1
    }
    if (removed > 0) this._schedule()
    return removed
  }

  /**
   - 追加一条退款记录(最近 100 条,新的在前).
   - 实现见 ./account-state/records.ts 的 recordRefund.
   */
  recordRefund(key: any, entry: any) {
    recordRefund(this, key, entry)
  }

  /**
   - 记一笔"凭证被写入"(网页导入 / 浏览器登录回调 / 开放 API 导入).
   *
   - 与导入时间的区别:importedAt 是"这个号什么时候进来的"(第一次),
   - credentialUpdatedAt 是"token 最后一次被换掉是什么时候"----同一个号可能被
   - 反复重新登录/更新凭证,前者不该被覆盖.
   - @param {string} key
   - @param {string} [at] ISO 时间(缺省 = 现在)
   */
  recordCredentialUpdate(key: any, at = null) {
    if (!key) return
    const rec = this.account(key)
    if (!rec) return
    const iso = at || new Date().toISOString()
    rec.credentialUpdatedAt = iso
    // 首次写入凭证时,导入时间就是现在(老账号已由 firstSeenAt 兜底,不覆盖).
    if (!rec.importedAt) rec.importedAt = iso
    this._schedule()
  }

  /** @param {string} key */
  refunds(key: any) {
    return refundsOf(this, key)
  }

  /** 标记"有改动待落盘"(外部调用入口,避免从类外碰私有 _schedule). */
  touch() {
    this._schedule()
  }

  /** 延迟合并写盘:热路径上不阻塞转发. */
  _schedule() {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.save()
    }, 800)
    if (this._timer.unref) this._timer.unref()
  }

  /** 立即落盘(进程退出前调用,保证去抖中的改动不丢). */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this.save()
  }

  save() {
    try {
      this.state.updatedAt = new Date().toISOString()
      const payload = JSON.stringify(this.state, null, 2)
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, payload, { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      return true
    } catch (err) {
      // 落盘失败绝不能影响转发:账本只是可观测性,不是计费依据.
      logger.warn('account-state: 写入失败', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }
}
