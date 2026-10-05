/**
 * 对外错误响应里的失败明细与额度聚合.
 *
 * 从 app-context.js 按职责切出. 这一层的共同约束是"脱敏":429 响应会被下游
 * Agent 客户端整段转发并落进别人的日志, 所以这里只允许出现 code 与聚合数值,
 * 绝不带 key / email / 账号标识.
 */
/**
 * 对外响应里的失败明细: 只保留 code, 去掉 key / email / message.
 *
 * 为什么: 429 响应会被下游 Agent 客户端原样转发, 落进别人的日志与报错堆栈.
 * 带上 email 等于把整个账号池的邮箱清单发给调用方(PII 泄露);
 * 带上 key(凭据文件名/账号 id)等于泄露凭据目录结构.
 * 管理员要看明细请用控制台(登录后)或服务端日志 -- 那里是完整且脱敏的.
 *
 * 保留 code 是因为错误码分类依赖它: 全 banned, 全 freebucks_exhausted,
 * 全 session_budget_exhausted 会得出不同的顶层 code 与建议动作.
 * @param {Array<{ code?: string }>} failures 失败明细
 * @returns {Array<{ code: string }>} 只含 code 的明细
 */
export function sanitizeFailuresForClient(failures: any): any {
  return (failures || []).map((f: any) => ({ code: f?.code || 'cooldown' }))
}

/**
 * 失败原因聚合(code -> 数量), 给调用方一个"为什么全挂了"的可读概览.
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
 * 为什么要它(2026-10-04 真实部署): 用户刷新看到余额 25, 发一个请求失败后
 * 再发就一直 429 -- 错误只说 no_available_account / freebucks_exhausted,
 * 既不告诉这次花了多少, 也不说什么时候恢复. 用户因此判断不了"是账号
 * 坏了还是额度没了", 只能反复重试(每试一次都在烧钱).
 *
 * 根子在语义: 一次 admit = 买断一整小时, 当场扣掉整小时单价, 不是按用量
 * 扣. 所以"25"是每日池的上限而非余额, 一个请求就能打光 -- 这个机制不写进
 * 回执, 用户永远只能靠猜.
 *
 * 脱敏纪律(与 sanitizeFailuresForClient / maskEmail 同源): 只带聚合
 * 数值, 绝不带 key / email / 账号标识.
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
 * 只在 failures 里挂是不够的(实测漏了): 额度拦截会走多条路径 -- 选号闸门
 * (freebucksFor 判定 affordable=false), admit 失败后的通用 err 分支, 冷却
 * 分支... 只在其中一条挂上, 用户换个触发路径就又拿不到数字. 这里以
 * failures 为准, 缺失时按 key 现取一份, 保证任何触发路径下 429 都带着这笔账.
 *
 * 必须用目录 key 查价, 不能拿可读名: freebucksFor() 按目录 key(m-096e75164d)
 * 在 prices 表里取值, 传可读名("DeepSeek V4.1 Flash")取不到 -> price=null
 * 被当成"不计费模型", 于是回执里出现 price 0 / dailyLimit 0 这种假数字.
 * 所以这里也必须走同一个 resolveModelAlias() 口径.
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
 * 逐账号列出各自的账, 不再只报"最差那个".
 *
 * 旧实现取"余额最小"的一份当代表 -- 多账号池下这会直接误导用户: 实测用户
 * 看到页面显示 A 号有 10 FB, 而 429 的错误体里报 balance 0 / dailyLimit 25
 * (那是 B 号的账), 于是"明明有钱却说额度不足". 每个账号的额度是独立的,
 * 错配任何一个都会让人往错方向查.
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
     * 用户看到"刚才还有 25"却失败, 缺的正是这句话.
     */
    note:
      'One admit buys a whole hour: the model\'s hourly price is charged upfront, ' +
      'not per token. Early release does not refund Freebucks.',
  }
}
