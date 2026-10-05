/**
 * session 域的准入闸门: 两本账(units 与 Freebucks)与续期提前量.
 *
 * 从 session-manager.js 的 freebucksFor / sessionUnitsFor / reAdmitLeadMs 切出.
 * 这些方法只读 this.quota / this.freebucks / this.config, 不写任何会话状态,
 * 因此可以整块搬成带 this 参数的普通函数.
 *
 * 两本账是并行的两道闸门, 见
 * .agents/notes/implemented/architecture/2026-09-14-two-ledgers-parallel-gates.md
 */
import { isFreeModel } from '../../model.js'

/**
 * session_units 闸门(与 Freebucks 并行的第二道).
 *
 * 上游一笔会话同时扣两本账: units(rateLimitsByModel[model].recentCount, 小数)
 * 与 Freebucks. 实测 deepseek-v4-flash 在 units 0.1/6 完全没超标时仍被
 * rate_limited(理由 freebucksShortfall), 所以 Freebucks 那道不能删;
 * 但 units 用尽同样会被上游拒, 不拦就等于白跑一次 admit 再换回冷却.
 *
 * 返回 {known, used, limit, remaining, exhausted, pool, poolLabel, resetAt}.
 * fail-open: 无该模型行 / limit<=0 / 非有限数 -> known:false(不拦截),
 * 这样老上游与没有 rateLimitsByModel 的账号行为不变.
 * @param {any} this 会话实例(读 quota)
 * @param {string} model 目录 key 或上游 id
 * @returns {any} units 账目快照
 */
export function sessionUnitsFor(this: any, model: string): any {
  const row = this.quota?.byModel?.[model]
  if (!row || typeof row !== 'object') {
    return { known: false, used: null, limit: null, remaining: null, exhausted: false }
  }
  const limit = Number(row.limit)
  const used = Number(row.recentCount)
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) {
    return { known: false, used: null, limit: null, remaining: null, exhausted: false }
  }
  const remaining = Math.max(0, limit - used)
  return {
    known: true,
    used,
    limit,
    remaining,
    exhausted: remaining <= 0,
    pool: row.period || row.pool || null,
    poolLabel: row.poolLabel || null,
    resetAt: row.resetAt || null,
  }
}

/**
 * 该模型在这个账号上的 Freebucks 账目:
 *   { known, price, balance, affordable, quotaExempt, resetAt, reason }
 * known=false 表示还没有拿到过 freebucks 块(老上游/尚未探测) -- 此时不拦截.
 * 无 price 的模型 = 不计费(unmetered), 永远可买.
 *
 * 上游的封号判定有两条(issue #11 实测):
 *   1. Freebucks 跑完了(今日池 daily.remaining <= 0);
 *   2. 本次请求所需 Freebucks 高于剩余余额(balance < prices[model]).
 * 命中任一条就可能直接封号, 所以 affordable === false 必须同时覆盖两者
 * -- 只判 2 会漏掉"池子跑完但 balance 还留着数字"的账号, 照样送上去撞封禁.
 * reason 标明是哪一条命中, 便于日志与前端解释(不再只报"余额不够").
 * @param {any} this 会话实例(读 freebucks)
 * @param {string} model 目录 key 或上游 id
 * @returns {any} Freebucks 账目快照
 */
export function freebucksFor(this: any, model: string): any {
  const fb = this.freebucks
  if (!fb) return { known: false, price: null, balance: null, affordable: true }
  // 每日池重置时刻已过 -> 本地数字自认过期(太平洋午夜刷新), 不再据此
  // 拦截选号: 让一次真实 admit 用上游的最新余额重新校准, 而不是拿冻结的
  // 旧数字把账号一直排除在外.
  const resetAt = fb.daily?.resetAt ? Date.parse(fb.daily.resetAt) : NaN
  if (Number.isFinite(resetAt) && resetAt <= Date.now()) {
    return {
      known: false,
      price: null,
      balance: fb.balance,
      affordable: true,
      stale: true,
    }
  }
  const price = lookupPrice(this, fb, model)
  if (price == null) {
    return {
      known: true,
      price: null,
      balance: fb.balance,
      affordable: true,
      unmetered: true,
      resetAt: fb.daily?.resetAt || null,
    }
  }
  return assembleFreebucksVerdict(fb, price)
}

/**
 * 价格表查找.
 *
 * 必须走模型标识归一(2026-10-04 实测缺陷): 上游价格表(freebucks.prices)的键
 * 是上游模型 id(deepseek/deepseek-v4-flash), 而调度传进来的 model 通常是
 * 目录 key(m-096e75164d) -- 直接用 fb.prices[model] 查不到, 于是 price 为
 * null -> 走进 unmetered 分支恒放行, 额度闸门形同虚设.
 *
 * 用注入的 resolveModelAlias(同一唯一真源)把两侧都归一到目录 key 再比.
 * @param {any} this 会话实例(读 resolveModelAlias)
 * @param {any} fb Freebucks 块
 * @param {string} model 待查模型
 * @returns {number | null} 单价; 未标价返回 null
 */
function lookupPrice(self: any, fb: any, model: string): number | null {
  const normModel = (v: any) =>
    typeof self.resolveModelAlias === 'function' ? self.resolveModelAlias(v) : v
  const wantModel = normModel(model)
  const prices = fb.prices || {}
  // 1 先按原样查(快路径: 键已是同形态时零开销)
  if (typeof prices[model] === 'number') return prices[model]
  // 2 逐键归一再比(价格表很小, 逐键成本可忽略)
  for (const [k, v] of Object.entries(prices)) {
    if (typeof v !== 'number') continue
    if (normModel(k) === wantModel) return v
  }
  return null
}

/**
 * 按单价组装最终判定(免费模型/每日池/余额/月度四路).
 *
 * 免费模型(price === 0)不受任何 Freebucks 闸门约束.
 *
 * 实测(2026-10-04 用户指出): 上游价格表里有 price: 0 的免费模型
 * (upstage/solar-mini4, stealth/space-bunny-alpha). 既然它不花钱,
 * 余额/每日池耗尽就与它无关 -- 用"没钱"去拒绝一个免费模型是纯粹的自伤.
 *
 * 注意判据是 price === 0(不是"price 缺失"): 缺失在上面已走 unmetered 分支
 * 放行并明确标注, 那是"上游没给价"的未知态; 这里是"上游明确标价 0"的已知免费态.
 * @param {any} fb Freebucks 块
 * @param {number} price 该模型单价
 * @returns {any} 判定结果
 */
function assembleFreebucksVerdict(fb: any, price: number): any {
  const freeOfCharge = price === 0
  const monthlySpent =
    !freeOfCharge && fb.monthly != null && Number(fb.monthly.remainingUsd) <= 0
  // 条件 1: 今日池跑完(limit > 0 才算真的有池子, 避免把 limit=0 的
  // "没有池子" 误判成"池子跑完"). resetAt 已过在上面就 return 了, 所以这里
  // 的 remaining 一定是未重置周期的数字. quotaExempt 账号不受任何池限制.
  const dailyLimit = Number(fb.daily?.limit)
  const dailyRemaining = Number(fb.daily?.remaining)
  const dailyExhausted =
    !freeOfCharge &&
    Number.isFinite(dailyLimit) &&
    dailyLimit > 0 &&
    Number.isFinite(dailyRemaining) &&
    dailyRemaining <= 0
  // 条件 2: 余额买不起本次请求(免费模型恒买得起 -- 它不花钱)
  const shortOnBalance = !freeOfCharge && Number(fb.balance) < price
  const exempt = fb.quotaExempt === true
  const affordable = exempt || (!dailyExhausted && !shortOnBalance && !monthlySpent)
  /** 命中哪一条(用于日志/前端解释; affordable=true 时为 null). */
  const reason = affordable
    ? null
    : dailyExhausted
      ? 'daily_exhausted'
      : monthlySpent
        ? 'monthly_exhausted'
        : 'balance_shortfall'
  return {
    known: true,
    price,
    balance: fb.balance,
    affordable,
    unmetered: false,
    quotaExempt: exempt,
    dailyExhausted,
    dailyRemaining: Number.isFinite(dailyRemaining) ? dailyRemaining : null,
    dailyLimit: Number.isFinite(dailyLimit) ? dailyLimit : null,
    reason,
    resetAt: fb.daily?.resetAt || null,
  }
}

/**
 * 会话剩余时间低于该阈值(秒)后不再承接新请求, 提前 re-admit 换新会话,
 * 避免请求发到马上过期的会话上, 中途卡住(切换流量更平滑).
 *
 * 按模型计费方式分层:
 * - 免费模型(daily/referral/limited_offer/helper): 剩余不足
 *   session.free_model_re_admit_lead_sec(默认 300s = 5 分钟)即不再调度 --
 *   会话按整小时计价, 过期中途被掐断会让响应截断, 提前换最平滑(未用时长会退还);
 * - 付费模型(premium): 每次 admit 都是计费会话, 尽量用到接近过期
 *   (沿用 session.re_admit_lead_sec, 默认 60s), 避免频繁新建付费会话.
 * @param {any} this 会话实例(读 config)
 * @param {string} model 目录 key 或上游 id
 * @returns {number} 提前续期阈值(毫秒)
 */
export function reAdmitLeadMs(this: any, model: string): number {
  const sec = this.config.session.reAdmitLeadSec
  const base = (Number.isFinite(sec) && sec > 0 ? sec : 60) * 1000
  if (isFreeModel(model)) {
    const freeSec = this.config.session.freeModelReAdmitLeadSec
    const freeBase =
      (Number.isFinite(freeSec) && freeSec > 0 ? freeSec : 300) * 1000
    return Math.max(base, freeBase)
  }
  return base
}

/**
 * 会话切换等待在途请求的上界(毫秒): 约等于"持锁者最坏存活时长" -- 响应头
 * 等待(与 body idle 同量级) + body idle 一个周期 + 余量. 超过该值视为账号
 * 卡死(网络波动叠加), 放弃本账号让上层冷却/换号, 绝不无限等待.
 * @returns {number} 等待上界(毫秒)
 * @param {any} this 会话实例(读 config)
 */
export function switchWaitMs(this: any): number {
  const idleSec = this.config.limits.streamIdleTimeoutSec
  const idleMs = (Number.isFinite(idleSec) && idleSec > 0 ? idleSec : 120) * 1000
  return 2 * idleMs + 60_000
}

/**
 * 该模型在该会话上是否可复用.
 * @param {any} this 会话实例
 * @param {string} model 请求模型
 * @param {any} [session] 待判定会话, 默认取 this.session
 * @returns {boolean} 可复用则为真
 */
export function isUsableForModel(
  this: any,
  model: string,
  session: any = this.session,
): boolean {
  // 正在早退释放(空闲/换号)的会话不再被选号复用, 避免 DELETE 与 chat 抢同一条会话.
  if (this._releasing) return false
  if (!hasLiveSlot.call(this, session)) return false
  if (!session?.model || !session.instanceId) return false
  if (session.status === 'ended') {
    // grace: can finish in-flight, but proxy policy: allow continue until
    // instance disappears if reAdmit not needed mid-request
    return session.model === model
  }
  if (this.config.session.reAdmitOnExpire) {
    // expiresAt 优先; 上游只回 remainingMs 时用它兜底(admit 时的快照).
    const left =
      session.expiresAt != null
        ? Date.parse(session.expiresAt) - Date.now()
        : typeof session.remainingMs === 'number'
          ? session.remainingMs
          : null
    // 已过期 / 剩余时间不足 lead -> 新请求需要 re-admit(提前平滑切换)
    if (left != null && left <= this.reAdmitLeadMs(model)) return false
  }
  return session.status === 'active' && session.model === model
}

/**
 * 本会话是否仍有一个可用的上游槽位.
 * @param {any} this 会话实例
 * @param {any} [session] 待判定会话, 默认取 this.session
 * @returns {boolean} 有活跃句柄则为真
 */
export function hasLiveSlot(this: any, session: any = this.session): boolean {
  if (!session) return false
  if (session.status === 'active' && session.instanceId) return true
  // grace window: ended but instance still present
  if (session.status === 'ended' && session.instanceId) return true
  return false
}
