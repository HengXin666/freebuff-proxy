/**
 * 账号账本(account-state.json)的读盘归一 ---- 从 src/account-state-store.ts 按职责切出.
 *
 * 为什么单独成文件: 这一段是"磁盘上任意 JSON -> 一份合法账本状态"的完整判据
 * (字段逐个校验, 坏字段一律回落默认, 绝不抛). 它与类的生命周期无关, 放在类里
 * 会让 load() 同时承担"读文件"与"逐字段定性"两件事.
 *
 * 口径: 纯搬移, 行为零改动. 读盘永不抛 -- 账本坏了只当没有, 不影响转发.
 */

/**
 * 把磁盘上的原始 JSON 归一成一份账本状态.
 *
 * 逐字段校验: 类型不对一律回落默认值, 结构不对的账号直接丢弃(不保留半残记录).
 * 之所以绝不抛: 账本只是可观测性, 不是计费依据, 一个损坏文件不该拖死转发.
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
 * 为什么值得单独记: 控制台原本只有 lastRefund 一个内存里的最新值, 既看不到历史,
 * 重启就丢, 于是"退款到底成没成功 / 金额对不对"根本没法审. 记下 holdMs(实际占用)
 * 与 expected(按未用时长应付的金额)之后, "退款是不是被上游吞了 / 是不是被四舍五入
 * 成 5 的倍数"就能直接对账.
 *
 * 搬法: 原为 AccountStateStore 的私有方法, 现按本仓既有模式改为模块级函数 +
 * self 首参(this 承载 account / _schedule 两个依赖).
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
