/**
 * 账号的生命周期与账本持久化: 懒创建时回灌, 删除时清理, 账目落盘.
 *
 * 持久化的字段: 封禁时间, 请求数, 最近使用, 冷却, Freebucks 余额与单价.
 */
import fs from 'node:fs'
import { accountCredentialsPath, listAccounts } from '../../auth-store.ts'
import { UpstreamError } from '../../upstream/client.ts'
import { logger } from '../../util/log.ts'

/**
 * 把账本里某账号的状态灌回它的 runtime(懒创建时调用)+ 内存冷却表.
 * @param {any} this 账号池(runtimes)
 * @param {{ key: string, sessions: import('../../session-manager.ts').SessionManager, email?: string }} runtime
 */
export function _hydrateRuntime(this: any, runtime: any) {
  const key = runtime?.key
  const rec: any = key
    ? this.accountState.account(key, this._importedAtHint(key))
    : null
  if (!rec || !runtime?.sessions) return
  const s = runtime.sessions
  if (rec.freebucks && typeof rec.freebucks === 'object') {
    s.freebucks = rec.freebucks
  }
  if (rec.quota && typeof rec.quota === 'object') s.quota = rec.quota
  if (rec.lastProbe && typeof rec.lastProbe === 'object') {
    s.lastProbe = rec.lastProbe
  }
  const cds: any = rec.cooldowns
  if (cds && typeof cds === 'object') {
    const now = Date.now()
    const prefix = `${key}\0`
    for (const [k, cd] of Object.entries(cds as Record<string, any>)) {
      // 必须精确匹配账号 key 或 key\0model:用 startsWith(key) 会让账号
      // "ab" 的冷却灌进账号 "a"(前缀撞车,单字符 key 的测试测不出来).
      if (k !== key && !k.startsWith(prefix)) continue
      const until = Number(cd?.until)
      // 过期的冷却直接丢:重启不该把号永久锁死.
      if (!Number.isFinite(until) || until <= now) continue
      this.cooldowns.set(k, { until, code: cd.code ?? null, model: cd.model })
    }
  }
}

/**
 * "这个号什么时候进来的"----取凭据文件的创建时间(birthtime,回退 mtime).
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @returns {string | null} ISO 时间串; 取不到时为 null
 */
export function _importedAtHint(this: any, key: any) {
  try {
    const p = accountCredentialsPath(this.dir, key)
    const st = fs.statSync(p)
    const t = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
    return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null
  } catch {
    return null
  }
}

/**
 * 账号 key 列表(id 优先, 旧布局的账号 key 为邮箱).
 * @param {any} this 账号池(runtimes)
 * @returns {string[]} 账号 key 列表
 */
export function allKeys(this: any) {
  return listAccounts(this.dir).map((a: any) => a.key)
}

/**
 * 忘记某账号(被删除时调用): 把它的账本记录, 统计, 最近使用与冷却一并清掉,
 * 然后 prune 并落盘.
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 */
export function forgetAccount(this: any, key: any) {
  if (!key) return
  const accounts = this.accountState.state.accounts
  if (accounts[key]) {
    delete accounts[key]
  }
  // 同属一个账号的邮箱 key 一并清掉(旧布局凭据).
  this.stats.byKey.delete(key)
  this._lastUsedAt.delete(key)
  if (this._lastSuccessKey === key) this._lastSuccessKey = null
  for (const k of [...this.cooldowns.keys()]) {
    if (k === key || k.startsWith(`${key}\0`)) this.cooldowns.delete(k)
  }
  this.accountState.prune(new Set(this.allKeys()))
  this.accountState.flush()
}

/**
 * 记一笔"凭证更新时间"(导入 / 重新登录 / 更新 token 后调用).
 * 所有写凭据的入口(网页导入, 浏览器登录回调, 开放 API 导入)都要调.
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 */
export function markCredentialUpdated(this: any, key: any) {
  if (!key) return
  this.accountState.recordCredentialUpdate(key)
}

/**
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @param {{ freebucks?: any, quota?: any, lastProbe?: any }} snap
 */
export function _persistAccountState(this: any, key: any, snap: any) {
  if (!key || !snap) return
  // 退款流水单独走账本(追加重试/金额对账用),不混进字段快照.
  if (snap.refund) {
    this.accountState.recordRefund(key, snap.refund)
    return
  }
  // 调度时长单独累加(不能走 patch:patch 是覆盖语义,会把累计值抹掉).
  if (typeof snap.schedulingMs === 'number') {
    this.accountState.recordScheduling(key, snap.schedulingMs)
    return
  }
  const fields: Record<string, any> = {}
  // 本轮调度的起算点(可空 = 本轮已结束), 供控制台区分"正在干活"与"没被调度过".
  if (snap.schedulingSince !== undefined) {
    fields.schedulingSince = snap.schedulingSince
  }
  if (snap.freebucks !== undefined) fields.freebucks = snap.freebucks
  if (snap.quota !== undefined) fields.quota = snap.quota
  if (snap.lastProbe !== undefined) fields.lastProbe = snap.lastProbe
  const user = this.byKey.get(key)?.user
  if (user?.email) fields.email = user.email
  // 封禁是账号生命周期的终点,值得额外记一笔("什么时候开始被 ban 的").
  if (fields.lastProbe?.ok === false && fields.lastProbe.code === 'banned') {
    if (!this.accountState.account(key)?.bannedAt) {
      fields.bannedAt = fields.lastProbe.at || new Date().toISOString()
    }
  }
  this.accountState.patch(key, fields)
}

/**
 * 启动时回灌账本: 冷却, 请求计数, 最近使用, freebucks/quota/探测结果,
 * 以及上次成功的账号指针.
 *
 * 只回灌尚未过期的冷却; freebucks 一并回灌, 使"余额不足就别 admit"的闸门在重启后
 * 仍然生效.
 * @param {any} this 账号池(runtimes)
 * @returns {void} 无返回
 */
export function _restoreAccountState(this: any) {
  const valid = new Set(this.allKeys())
  const removed = this.accountState.prune(valid)
  if (removed) {
    logger.info('account-state: 清理已删除账号的记录', { removed })
  }
  for (const key of valid) {
    const rec = this.accountState.account(key, this._importedAtHint(key))
    if (!rec) continue
    const requests = Number(rec.requests) || 0
    if (requests > 0) {
      this.stats.byKey.set(key, requests)
      this.stats.total += requests
    }
    const usedAt = rec.lastUsedAt ? Date.parse(rec.lastUsedAt) : NaN
    if (Number.isFinite(usedAt)) this._lastUsedAt.set(key, usedAt)
    // 清掉上一进程留下的本轮调度起算点(在途流已随进程结束), 累计时长 scheduledMs 保留.
    if (rec.schedulingSince) {
      rec.schedulingSince = null
      this.accountState.touch()
    }
    const cds: any = rec.cooldowns
    if (cds && typeof cds === 'object') {
      const now = Date.now()
      const prefix = `${key}\0`
      for (const [k, cd] of Object.entries(cds as Record<string, any>)) {
        if (k !== key && !k.startsWith(prefix)) continue
        const until = Number(cd?.until)
        if (!Number.isFinite(until) || until <= now) continue
        this.cooldowns.set(k, {
          until,
          code: cd.code ?? null,
          model: cd.model,
        })
      }
    }
    // freebucks / quota / lastProbe 不在这里灌：runtime 是懒创建的，构造
    // 函数执行时 byKey 还是空的。那部分见 _hydrateRuntime（get() 时调用）。
  }
  if (typeof this.accountState.state.lastSuccessKey === 'string') {
    this._lastSuccessKey = this.accountState.state.lastSuccessKey
  }
  // 账本里的 lastSuccessKey 是可能悬空的指针: 指向的 key 不在当前凭据列表里就丢弃,
  // 让 getAny() 回落到 keys[0].
  if (this._lastSuccessKey && !this.allKeys().includes(this._lastSuccessKey)) {
    this._lastSuccessKey = null
  }
}

/**
 * 账本 + 句柄索引一起冲刷落盘(进程退出/重启前调用), 落盘失败不影响退出流程.
 * @param {any} this 账号池(runtimes)
 * @returns {void} 无返回
 */
export function flushState(this: any) {
  try {
    this.accountState.flush()
  } catch {
    // 落盘失败不影响退出流程
  }
}

/**
 * 取任一个可用账号(仅供 status / doctor 展示, 不参与 chat 选号).
 * @param {any} this 账号池(runtimes)
 * @returns {any} 账号 runtime
 */
export function getAny(this: any) {
  const keys = this.allKeys()
  if (!keys.length) {
    throw new UpstreamError(
      'No Freebuff accounts. Run `npm run login` (saves credentials/<key>.json).',
      { status: 401, code: 'upstream_auth_missing' },
    )
  }
  // 首选 key 取不到时回落到 keys[0], 不把"首选失效"升级成致命错误.
  const preferred = this._lastSuccessKey && keys.includes(this._lastSuccessKey)
    ? this._lastSuccessKey
    : keys[0]
  try {
    return this.get(preferred)
  } catch (err) {
    // 首选账号的凭据此刻不可用(文件被移除/写坏)→ 依次尝试其余账号.
    for (const key of keys) {
      if (key === preferred) continue
      try {
        return this.get(key)
      } catch {
        // 继续换下一个
      }
    }
    throw err
  }
}
