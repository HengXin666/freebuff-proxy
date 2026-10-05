/**
 * 账号账本(account-state.json)的读盘归一.
 *
 * 职责: 把"磁盘上任意 JSON"转成一份合法账本状态 ---- 字段逐个校验, 坏字段一律
 * 回落默认值, 绝不抛. 读盘永不抛: 账本坏了只当没有, 不影响转发.
 */

/**
 * 把磁盘上的原始 JSON 归一成一份账本状态.
 *
 * 逐字段校验: 类型不对一律回落默认值, 结构不对的账号直接丢弃(不保留半残记录).
 * 绝不抛异常: 账本只是可观测性, 不是计费依据.
 * @param {any} raw 解析后的原始对象(可能为 null / 数组 / 任意脏数据)
 * @returns {{version: number, updatedAt: string | null, total: number,
 *   lastSuccessKey: string | null, accounts: Record<string, any>}} 归一后的状态
 */
export function normalizeAccountState(raw: any) {
  const accounts: any = {}
  const src = raw?.accounts
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [key, rec] of Object.entries(src)) {
      if (!key || !rec || typeof rec !== 'object') continue
      accounts[key] = rec
    }
  }
  return {
    version: 1,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    total: Number.isFinite(Number(raw?.total)) ? Number(raw.total) : 0,
    lastSuccessKey:
      typeof raw?.lastSuccessKey === 'string' ? raw.lastSuccessKey : null,
    accounts,
  }
}

/** 两位小数(Freebucks 金额对账用). */
function round2(n: any) {
  return Math.round(n * 100) / 100
}

/**
 * 追加一条退款记录(最近 100 条, 新的在前), 并累计三个对账口径.
 *
 * entry 记下 holdMs(实际占用时长)与 expected(按未用时长应付的金额), 供控制台
 * 对账用: 判断退款是否成功 / 金额是否被四舍五入.
 * self 首参承载 account / _schedule 两个依赖.
 * @param {any} self 账本实例(AccountStateStore)
 * @param {string} key 账号 key
 * @param {any} entry 退款流水条目
 * @returns {void} 无返回
 */
export function recordRefund(self: any, key: any, entry: any) {
  if (!key || !entry) return
  const rec = self.account(key)
  if (!rec) return
  const list = Array.isArray(rec.refunds) ? rec.refunds : []
  list.unshift(entry)
  rec.refunds = list.slice(0, 100)
  // 累计退款/累计预期: 控制台一眼看出"总共该退多少, 实际退了多少".
  if (typeof entry.refund === 'number') {
    rec.refundTotal = round2(Number(rec.refundTotal || 0) + entry.refund)
  }
  if (typeof entry.expected === 'number') {
    rec.refundExpectedTotal = round2(
      Number(rec.refundExpectedTotal || 0) + entry.expected,
    )
  }
  // session_units 口径的应退(上游会立即兑现的那本账; Freebucks 侧长期 pending).
  if (typeof entry.expectedUnits === 'number') {
    rec.refundUnitsExpectedTotal = round2(
      Number(rec.refundUnitsExpectedTotal || 0) + entry.expectedUnits,
    )
  }
  if (entry.pending === true) {
    rec.refundPendingCount = Number(rec.refundPendingCount || 0) + 1
  }
  self._schedule()
}

/**
 * 读某账号的退款流水(无记录时返回空数组, 绝不返回 null).
 * @param {any} self 账本实例(AccountStateStore)
 * @param {string} key 账号 key
 * @returns {any[]} 退款流水(新的在前)
 */
export function refundsOf(self: any, key: any) {
  const rec = key ? self.state.accounts[key] : null
  return Array.isArray(rec?.refunds) ? rec.refunds : []
}
