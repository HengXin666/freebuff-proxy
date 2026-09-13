import fs from 'node:fs'
import path from 'node:path'
import { logger } from './util/log.js'
import { readJsonFileState, noteDataFile } from './util/json-store.js'

/** 两位小数（Freebucks 金额对账用）。 */
function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * 账号运行状态的**持久化账本**（/data/account-state.json）。
 *
 * 为什么必须有它：账号的"人生履历"原本全在内存里，一次重启就全丢——
 *   - 什么时候进来的（firstSeenAt）、什么时候被封的（bannedAt）
 *   - 发过多少请求（requests）、最近一次使用（lastUsedAt）
 *   - 冷却（cooldowns）、Freebucks 余额/单价、每日额度、最近一次探测结果
 * 丢了以后控制台分不出"从未用过的干净号"和"已经被打废的号"，重启后还会
 * 立刻去重试已封禁的号；更糟的是 `freebucks` 归零让"余额买不起就别
 * admit"这道闸门直接失效（freebucksFor 只能 fail-open），等于重启后第一个
 * 请求就去撞已知余额不足的账号。
 *
 * 所以这里把上述状态落盘，启动时回灌。文件形如：
 *   { version:1, updatedAt, total, lastSuccessKey,
 *     accounts: { <accountKey>: {
 *       email, firstSeenAt, bannedAt, requests, lastUsedAt,
 *       cooldowns: { <cooldownKey>: { until, code, model? } },
 *       freebucks, quota, lastProbe } } }
 *
 * 设计取舍：
 *   - 写盘是**去抖 + 原子**（tmp+rename, 0o600）：调度热路径上每发一个请求
 *     都同步写文件会拖慢吞吐，所以合并成一次延迟写；进程退出前 flush。
 *   - 读盘**永不抛**：账本坏了也只当没有（控制台少显示点历史，但不影响转发）。
 *   - 账号被删除时同步清掉记录，避免文件无限增长与幽灵账号。
 */
export class AccountStateStore {
  /**
   * @param {string} file e.g. /data/account-state.json
   */
  constructor(file) {
    this.file = file
    /** 去抖写盘定时器。 */
    this._timer = null
    /** @type {{ version: number, updatedAt: string | null, total: number, lastSuccessKey: string | null, accounts: Record<string, any> }} */
    this.state = {
      version: 1,
      updatedAt: null,
      total: 0,
      lastSuccessKey: null,
      accounts: {},
    }
    /** 装载结果（'ok' | 'missing' | 'invalid'）：损坏 = 账号履历与
     * "余额买不起就别 admit"闸门失效（重启后可能去撞已知余额不足的号）。 */
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
      const raw = st.data
      const accounts = {}
      const src = raw?.accounts
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        for (const [key, rec] of Object.entries(src)) {
          if (!key || !rec || typeof rec !== 'object') continue
          accounts[key] = rec
        }
      }
      this.state = {
        version: 1,
        updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
        total: Number.isFinite(Number(raw?.total)) ? Number(raw.total) : 0,
        lastSuccessKey:
          typeof raw?.lastSuccessKey === 'string' ? raw.lastSuccessKey : null,
        accounts,
      }
    } catch (err) {
      logger.warn('account-state: 读取失败，按空账本继续', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return st
  }

  /**
   * 取（必要时创建）某账号的记录；新账号在此盖上"加入时间"。
   * @param {string} key
   * @param {string} [importedAtHint] 已知的加入时间（通常取凭据文件的创建时间）
   *   ——比"账本第一次见到它"更准：老账号升级到本账本时不该被记成今天刚加入。
   */
  account(key, importedAtHint = null) {
    if (!key) return null
    let rec = this.state.accounts[key]
    if (!rec) {
      const hint = importedAtHint ? Date.parse(importedAtHint) : NaN
      const firstSeenAt = Number.isFinite(hint)
        ? new Date(hint).toISOString()
        : new Date().toISOString()
      rec = {
        firstSeenAt,
        // importedAt = 明确的"导入时间"。老账号没有这个字段，回落 firstSeenAt
        // （同一时刻的近似值），保证前端永远有一个可展示的值。
        importedAt: firstSeenAt,
        bannedAt: null,
        requests: 0,
        lastUsedAt: null,
        // 累计调度时长（毫秒）：会话在途归零时累加。0 = 从未被调度过。
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
    // 老账号升级：补齐 importedAt（用 firstSeenAt 近似），只补一次。
    if (rec && !rec.importedAt && rec.firstSeenAt) {
      rec.importedAt = rec.firstSeenAt
      this._schedule()
    }
    return rec
  }

  /**
   * 累加一次"调度时长"（毫秒）。会话在途归零时调用。
   * 与 `requests` 的区别：requests 是"被选中几次"，scheduledMs 是"真正占用了
   * 多久"——长对话 1 次可能顶短批量几百次，两个指标都要看。
   * @param {string} key
   * @param {number} ms
   */
  recordScheduling(key, ms) {
    if (!key || !Number.isFinite(ms) || ms <= 0) return
    const rec = this.account(key)
    if (!rec) return
    rec.scheduledMs = Math.round(Number(rec.scheduledMs || 0) + ms)
    rec.lastScheduledAt = new Date().toISOString()
    rec.schedulingSince = null
    this._schedule()
  }

  /** 合并写入一个账号记录（值为 undefined 的字段不动）。 */
  patch(key, fields) {
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

  /** 删除已不存在的账号记录；顺带保留"最后一个账号"的兜底（见 prune）。 */
  prune(validKeys) {
    const keep = validKeys instanceof Set ? validKeys : new Set(validKeys || [])
    const accounts = this.state.accounts
    let removed = 0
    for (const key of Object.keys(accounts)) {
      if (keep.has(key)) continue
      // 旧布局的邮箱 key 迁移：同一账号换 key 时把"加入时间/封禁时间"带过去，
      // 否则控制台会把老号重新显示成"从未使用"。
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
   * 追加一条退款记录（最近 100 条，新的在前）。
   *
   * 为什么值得单独记：控制台原本只有 lastRefund 一个**内存里的最新值**，
   * 既看不到历史、重启就丢，于是"退款到底成没成功 / 金额对不对"根本没法审。
   * 记下 holdMs（实际占用）与 expected（按未用时长应付的金额）之后，
   * "退款是不是被上游吞了 / 是不是被四舍五入成 5 的倍数"就能直接对账。
   */
  recordRefund(key, entry) {
    if (!key || !entry) return
    const rec = this.account(key)
    if (!rec) return
    const list = Array.isArray(rec.refunds) ? rec.refunds : []
    list.unshift(entry)
    rec.refunds = list.slice(0, 100)
    // 累计退款/累计预期：控制台一眼看出"总共该退多少、实际退了多少"。
    if (typeof entry.refund === 'number') {
      rec.refundTotal = round2(Number(rec.refundTotal || 0) + entry.refund)
    }
    if (typeof entry.expected === 'number') {
      rec.refundExpectedTotal = round2(
        Number(rec.refundExpectedTotal || 0) + entry.expected,
      )
    }
    if (entry.pending === true) {
      rec.refundPendingCount = Number(rec.refundPendingCount || 0) + 1
    }
    this._schedule()
  }

  /**
   * 记一笔"凭证被写入"（网页导入 / 浏览器登录回调 / 开放 API 导入）。
   *
   * 与导入时间的区别：`importedAt` 是"这个号什么时候进来的"（第一次），
   * `credentialUpdatedAt` 是"token 最后一次被换掉是什么时候"——同一个号可能被
   * 反复重新登录/更新凭证，前者不该被覆盖。
   * @param {string} key
   * @param {string} [at] ISO 时间（缺省 = 现在）
   */
  recordCredentialUpdate(key, at = null) {
    if (!key) return
    const rec = this.account(key)
    if (!rec) return
    const iso = at || new Date().toISOString()
    rec.credentialUpdatedAt = iso
    // 首次写入凭证时，导入时间就是现在（老账号已由 firstSeenAt 兜底，不覆盖）。
    if (!rec.importedAt) rec.importedAt = iso
    this._schedule()
  }

  /** @param {string} key */
  refunds(key) {
    const rec = key ? this.state.accounts[key] : null
    return Array.isArray(rec?.refunds) ? rec.refunds : []
  }

  /** 标记"有改动待落盘"（外部调用入口，避免从类外碰私有 _schedule）。 */
  touch() {
    this._schedule()
  }

  /** 延迟合并写盘：热路径上不阻塞转发。 */
  _schedule() {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.save()
    }, 800)
    if (this._timer.unref) this._timer.unref()
  }

  /** 立即落盘（进程退出前调用，保证去抖中的改动不丢）。 */
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
      // 落盘失败绝不能影响转发：账本只是可观测性，不是计费依据。
      logger.warn('account-state: 写入失败', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }
}
