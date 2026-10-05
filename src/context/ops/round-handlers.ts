/**
 * 对外错误响应里的失败明细与额度聚合.
 *
 * 脱敏约束: 429 响应会被下游 Agent 客户端整段转发并落进别人的日志, 所以这里只允许
 * 出现 code 与聚合数值, 不带 key / email / 账号标识.
 */
/**
 * 对外响应里的失败明细: 只保留 code, 去掉 key / email / message.
 *
 * 带上 email 等于把整个账号池的邮箱清单发给调用方; 带上 key 等于泄露凭据目录结构.
 * 完整明细只在控制台(登录后)与服务端日志里.
 *
 * 保留 code: 错误码分类依赖它(全 banned / 全 freebucks_exhausted /
 * 全 session_budget_exhausted 会得出不同的顶层 code 与建议动作).
 * @param {Array<{ code?: string }>} failures 失败明细
 * @returns {Array<{ code: string }>} 只含 code 的明细
 */
export function sanitizeFailuresForClient(failures: any): any {
  return (failures || []).map((f: any) => ({ code: f?.code || 'cooldown' }))
}

/**
 * 失败明细聚合(code -> 数量), 给调用方一个"全挂了"的可读概览.
 * @param {Array<{ code?: string }>} failures 失败明细
 * @returns {Record<string, number>} code 到数量的映射
 */
export function countReasons(failures: any): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of failures || []) {
    const code = f?.code || 'cooldown'
    out[code] = (out[code] || 0) + 1
  }
  return out
}

/**
 * 把[Freebucks 这笔账]聚合成纯数值, 带进 429 错误体.
 *
 * 语义要点: 一次 admit = 买断一整小时, 当场扣掉整小时单价, 不是按用量扣.
 * 所以"25"是每日池的上限而非余额, 一个请求就能打光 ---- 回执里必须带上这笔账,
 * 让调用方判断"是账号坏了还是额度没了".
 *
 * 脱敏纪律(与 sanitizeFailuresForClient / maskEmail 同源): 只带聚合
 * 数值, 不带 key / email / 账号标识.
 *
 * @param {Array<{ key?: string, freebucks?: object }>} failures 失败明细
 * @param {any} [ctx] 账号池(runtime 上挂 sessions.freebucksFor, 用于现取)
 * @param {string | null} [model] 请求模型(可读名或目录 key)
 * @returns {object | null} 没有任何额度信息时返回 null(不塞空壳字段)
 */
export function summarizeFreebucks(
  failures: any,
  ctx: any = null,
  model: string | null = null,
): any {
  const rows: any[] = (failures || []).filter(
    (f: any) => f?.freebucks && typeof f.freebucks === 'object',
  )
  if (!rows.length && ctx && typeof ctx.get === 'function' && model) {
    collectMissingRows(rows, failures, ctx, model)
  }
  if (!rows.length) return null
  return buildQuotaSummary(rows)
}

/**
 * 失败项上没挂账时, 回查 runtime 现取.
 *
 * 额度拦截会走多条路径(选号闸门 / admit 失败后的通用 err 分支 / 冷却分支), 只在
 * 其中一条挂账会让用户换个触发路径就拿不到数字. 这里以 failures 为准, 缺失时按
 * key 现取一份, 保证任何触发路径下 429 都带着这笔账.
 *
 * 必须用目录 key 查价: freebucksFor() 按目录 key(m-096e75164d)在 prices 表里取值,
 * 传可读名取不到 -> price=null 被当成"不计费模型", 于是回执里出现 price 0 /
 * dailyLimit 0 这种假数字. 所以这里走同一个 resolveModelAlias() 口径.
 * @param {any[]} rows 收集目标(原地 push)
 * @param {any} failures 失败明细
 * @param {any} ctx 账号池
 * @param {string} model 请求模型
 * @returns {void}
 */
function collectMissingRows(
  rows: any[],
  failures: any,
  ctx: any,
  model: string,
): void {
  const modelKey =
    typeof ctx.resolveModelAlias === 'function'
      ? ctx.resolveModelAlias(model)
      : model
  for (const f of failures || []) {
    if (!f?.key) continue
    try {
      const rt = ctx.get(f.key)
      const fb = rt?.sessions?.freebucksFor?.(modelKey)
      if (fb?.known) {
        rows.push({
          freebucks: {
            price: fb.price ?? null,
            balance: fb.balance ?? null,
            dailyRemaining: fb.dailyRemaining ?? null,
            dailyLimit: fb.dailyLimit ?? null,
            resetAt: fb.resetAt || null,
            reason: fb.reason || null,
          },
        })
      }
    } catch {
      // 该号拿不到 runtime(已删除等): 跳过, 不影响其它账号
    }
  }
}

/**
 * 逐账号列出各自的账.
 *
 * 每个账号的额度是独立的, 用一份代表值会错配: 用户看到 A 号有 10 FB 而错误体报
 * balance 0 / dailyLimit 25(那是 B 号的账), 会往错方向查.
 *
 * 所以给出 accounts: [{price, balance, dailyRemaining, dailyLimit, resetAt,
 * reason}], 一一对应 failures(同一个顺序). 同时保留顶层平铺字段(取最差
 * 那份)仅为兼容既有消费方, 它是汇总值而非某个具体账号.
 * @param {any[]} rows 每账号的 freebucks 块
 * @returns {object} 429 错误体里的额度聚合块
 */
function buildQuotaSummary(rows: any[]): any {
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : null)
  const accounts = rows.map((r: any) => ({
    price: num(r.freebucks?.price),
    balance: num(r.freebucks?.balance),
    dailyRemaining: num(r.freebucks?.dailyRemaining),
    dailyLimit: num(r.freebucks?.dailyLimit),
    resetAt: r.freebucks?.resetAt || null,
    reason: r.freebucks?.reason || null,
  }))
  // 汇总(兼容字段): 取余额/日池最小的那份 -- 它最先卡住请求
  let worst: any = null
  for (const a of accounts) {
    if (!worst) {
      worst = a
      continue
    }
    const x = Number(a.dailyRemaining ?? a.balance ?? Infinity)
    const y = Number(worst.dailyRemaining ?? worst.balance ?? Infinity)
    if (x < y) worst = a
  }
  return {
    accounts,
    price: worst?.price ?? null,
    balance: worst?.balance ?? null,
    dailyRemaining: worst?.dailyRemaining ?? null,
    dailyLimit: worst?.dailyLimit ?? null,
    resetAt: worst?.resetAt || null,
    reason: worst?.reason || null,
    /**
     * 一句话把机制说清: 买断制, 一次请求扣整小时单价.
     */
    note:
      'One admit buys a whole hour: the model\'s hourly price is charged upfront, ' +
      'not per token. Early release does not refund Freebucks.',
  }
}
