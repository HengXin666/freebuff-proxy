/**
  * 单账号承接的两道判据: 惰性接管探测 + 两本额度闸门.
 *
 *   - "够不够新买一条"与"能不能接管一条已付过钱的会话"分开判(面板能显示它,
 *     调度就必须能用它);
 *   - 探测是惰性的: 官方建会话路径上那个 GET 会真的建出会话.
 */
import { logger, skipLogOnce } from '../../util/log.ts'
import { PAID_UPSTREAM_PROBE_RETRY_MS } from '../state/codes.ts'

/**
  * Freebucks 闸门与新会话预算闸门.
 *
 * Freebucks 是上游的拒付/封号判据之一: units 未超标时仍可能被 rate_limited
 * (理由 freebucksShortfall{price,balance}), 所以两本账都必须过.
 * @param {any} self 账号池(runtimes)
 * @param {any} rt 账号 runtime
 * @param {string} key 账号 key
 * @param {string} model 请求模型
 * @param {any} opts 透传选项(sessionBudget)
 * @param {boolean} paidTakeover 是否命中"上游有可接管会话"
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @param {Array<any>} failures 失败明细(原地追加)
 * @returns {boolean} 被拦下则为真
 */
function checkFreebucksAndBudget(
  self: any,
  rt: any,
  key: any,
  model: any,
  opts: any,
  paidTakeover: boolean,
  emailByKey: any,
  failures: any,
): boolean {
// ② Freebucks 闸门(货币预算): units 未超标时也可能被上游按
//    freebucksShortfall{price,balance} 拒掉, 所以两道闸门都必须过.
const fb = rt.sessions.freebucksFor?.(model)
if (!paidTakeover && fb?.known && fb.affordable === false) {
  failures.push({
    key,
    email: emailByKey.get(key),
    code: 'freebucks_exhausted',
    reason: fb.reason || null,
    /**
      * 把这笔账挂在 failure 上:顶层错误体据此聚合出"花了多少 /
     * 剩多少 / 何时恢复"(见 summarizeFreebucks).
     * 只带数值,不带标识 ---- 脱敏由聚合那一步负责.
     */
    freebucks: {
      price: fb.price ?? null,
      balance: fb.balance ?? null,
      dailyRemaining: fb.dailyRemaining ?? null,
      dailyLimit: fb.dailyLimit ?? null,
      resetAt: fb.resetAt || null,
      reason: fb.reason || null,
    },
    message:
      (fb.reason === 'daily_exhausted'
        ? `freebucks daily pool exhausted (${fb.dailyRemaining}/${fb.dailyLimit}) for ${model}`
        : fb.reason === 'monthly_exhausted'
          ? `freebucks monthly allowance exhausted for ${model}`
          : `freebucks balance ${fb.balance} < price ${fb.price} for ${model}`) +
      (fb.resetAt ? ` (refills ${fb.resetAt})` : ''),
  })
  skipLogOnce(self, key, 'freebucks_exhausted', 'skip account: freebucks cannot afford model', {
    key,
    email: emailByKey.get(key),
    model,
    reason: fb.reason || 'balance_shortfall',
    balance: fb.balance,
    price: fb.price,
    dailyRemaining: fb.dailyRemaining,
    dailyLimit: fb.dailyLimit,
  })
return true
}
// 新会话预算:上游按会话占用时长计费,一个失败的下游请求不该把
// 多个账号各买一条计费会话(issue #7).被上游拒绝的 admit
// (rate_limited 等)不占额度,所以只在这里做[还有没有预算]的预检,
// 真正扣减在 admit 成功之后.
// remaining === null = 不限额(控制台的 0 = 不限):恒放行,不判耗尽.
// 见 .agents/notes/implemented/bug-fix/2026-09-24-zero-session-budget-means-unlimited.md
if (
  opts.sessionBudget &&
  opts.sessionBudget.remaining !== null &&
  opts.sessionBudget.remaining <= 0
) {
  failures.push({
    key,
    email: emailByKey.get(key),
    code: 'session_budget_exhausted',
    message:
      'new-session budget for this request is used up (Freebucks meter)',
  })
return true
}
  
  return false
}

/**
  * 额度闸门: 两本账是否允许"新买一条", 以及能否改走接管.
 *
 * 上游对[余额不够]的判定两条(额度跑完 / 所需 Freebucks 高于余额), 命中任一就可能
 * 直接封号; 而"够不够新买一条"与"能不能接管一条已付过钱的会话"分开判.
 *
 * 控制流: 返回 true 表示被闸门拦下(失败已记入 failures); false 表示放行.
 *
 * 见 .agents/notes/implemented/feature/2026-10-08-quota-gate-probe-throttle.md
 * @param {any} self 账号池(runtimes)
 * @param {any} rt 账号 runtime
 * @param {string} key 账号 key
 * @param {string} model 请求模型
 * @param {any} opts 透传选项(sessionBudget)
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @param {Array<any>} failures 失败明细(原地追加)
 * @param {() => Promise<boolean>} checkPaidUpstream 惰性接管探测
 * @returns {Promise<boolean>} 被拦下则为真
 */
export async function checkQuotaGates(
  self: any,
  rt: any,
  key: any,
  model: any,
  opts: any,
  emailByKey: any,
  failures: any,
  checkPaidUpstream: () => Promise<boolean>,
): Promise<boolean> {
    // 上游对"余额不够"的判定两条(额度跑完 / 本次请求所需 Freebucks 高于剩余额度),
    // 命中任一条就可能直接封号, 所以只在真的要新买一条计费会话时才拦. 不能提到
    // reusable 判断之外: 活跃的同模型热 session 在 admit 时就已经预扣了整小时,
    // 复用它不再产生费用.
    // ① session_units 闸门(时长预算): 一个会话两本账都扣, 所以 units 不够时同样
    //    不该去买(上游会用 rate_limited 拒掉, 白一次 admit 往返).
    //    recentCount 是小数, 比较用 >=.
    const units = rt.sessions.sessionUnitsFor?.(model)
    const fbGate = rt.sessions.freebucksFor?.(model)
    /**
      * 两道额度闸门任一即将拒绝时, 先问上游"有没有可接管的已付费会话":
     * balance: 0 只说明"再买一条买不起", 不代表已付费的那一小时不能用.
     *
     * 位置在闸门之前而非函数开头: 只有真的要新买一条时才付这次只读探测的成本,
     * 额度充足的普通请求零开销.
     */
    const quotaLooksBlocked =
      (units?.known && units.exhausted) ||
      (fbGate?.known && fbGate.affordable === false)
    /**
      * 命中可接管会话时只跳过闸门, 不在此 return rt: acquireForModel 的契约是
     * "只选号, 不建会话", 真正建/接管会话在本函数更下方的
     * rt.sessions.ensureSession(model) ---- 那里会用 holderFor() 带 takeover 头接管,
     * 不新买. 在此 return 等于跳过 ensureSession, 会话从未接管.
     */
    const paidTakeover = quotaLooksBlocked && (await checkPaidUpstream())
    if (paidTakeover) {
      logger.info('quota gate bypassed: a reusable paid session holds upstream', {
        key,
        email: emailByKey.get(key),
        model,
        holderInstanceId: rt.sessions.holderFor(model),
      })
    }
    if (!paidTakeover && units?.known && units.exhausted) {
      failures.push({
        key,
        email: emailByKey.get(key),
        code: 'units_exhausted',
        message:
          `session units exhausted (${units.used}/${units.limit}, ` +
            `${units.poolLabel || units.pool || 'daily'}) for ${model}` +
          (units.resetAt ? ` (refills ${units.resetAt})` : ''),
      })
      skipLogOnce(self, key, 'units_exhausted', 'skip account: session units exhausted', {
        key,
        email: emailByKey.get(key),
        model,
        used: units.used,
        limit: units.limit,
        pool: units.pool,
      })
return true
    }
    if (checkFreebucksAndBudget(self, rt, key, model, opts, paidTakeover, emailByKey, failures)) return true
    return false
}

/**
  * 惰性探测"上游有没有一条我能接管的已付费会话".
 *
 * 一次 admit 买断一小时, 这一小时内继续发请求边际成本为 0; balance: 0 只说明
 * "再买一条买不起". 额度闸门只约束"新买一条".
 *
 * 惰性(只在额度闸门即将拒绝时才查): 那个 GET 在官方建会话路径上会建出会话,
 * 无条件执行会凭空造出一条 model=A 的会话, 紧接着请求模型 B 就撞
 * paid_window_model_mismatch.
 * @param {any} rt 账号 runtime
 * @param {string} key 账号 key
 * @param {string} model 请求模型
 * @param {Map<string, any>} emailByKey key 到邮箱
 * 本地快照先查(不受退避约束), 只有"再问上游一次"这一跳受 rt.paidProbeRetryAt 约束.
 *
 * 见 .agents/notes/implemented/feature/2026-10-08-quota-gate-probe-throttle.md
 * @returns {() => Promise<boolean>} 幂等探测函数(命中后记住结果)
 */
export function makePaidUpstreamChecker(
  rt: any,
  key: any,
  model: any,
  emailByKey: any,
): () => Promise<boolean> {
  const state = { paid: false }
  return async () => {

  if (state.paid) return true
  /**
   * 本地快照先查, 且不受退避窗口约束.
   *
   * 退避只该挡[再问上游一次], 不该挡[用已经知道的结果]: 上一次探测已经把
   * 可接管的持有者记进清单快照(holderFor), 窗口内把它当成没有, 等于把
   * 已经付过钱的一小时丢掉, 再去别的账号买新的.
   */
  if (rt.sessions.holderFor(model)) {
    state.paid = true
  } else if (Date.now() >= (rt.paidProbeRetryAt || 0)) {
    state.paid = await probeUpstream(rt, key, model, emailByKey)
  }
  if (state.paid) {
    logger.info(
      'reusing a paid session held upstream (skip quota gates, no re-buy)',
      {
        key,
        email: emailByKey.get(key),
        model,
        holderInstanceId: rt.sessions.holderFor(model),
        balance: rt.sessions.freebucksFor?.(model)?.balance ?? null,
      },
    )
  }
  return state.paid
  }
}

/**
 * 问一次上游"有没有可接管的已付费会话", 并据回执写退避窗口.
 *
 * 只读取形态(GET /session, 带 instanceId 的 include-unused-rate-limits)不建会话,
 * 也不扣费; 不依赖 hasInventorySnapshot() ---- 本地什么都没有的账号恰恰最需要问.
 * 见 .agents/notes/implemented/feature/2026-10-08-quota-gate-probe-throttle.md
 * @param {any} rt 账号 runtime
 * @param {string} key 账号 key
 * @param {string} model 请求模型
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @returns {Promise<boolean>} 上游此刻是否有可接管的持有者
 */
async function probeUpstream(
  rt: any,
  key: any,
  model: any,
  emailByKey: any,
): Promise<boolean> {
  let live = true
  try {
    await rt.sessions.refresh()
  } catch {
    live = false
  }
  /**
   * 只有确实问过上游才开窗: 窗口的语义是[别再重复问].
   *
   * 有在途请求时 refresh 会自跳过(不碰上游, 只置 lastProbeSkipped)----
   * 那不是[问过了], 不能开窗: 开了窗, 在途请求结束后真正想探测时会被挡住,
   * 拿不到上游刚出现的可接管会话.
   */
  if (!rt.sessions.lastProbeSkipped && typeof rt.markPaidProbeDone === 'function') {
    rt.markPaidProbeDone()
  }
  if (!live) {
    logger.warn(ACK_PAID_UNAVAILABLE, {
      key,
      email: emailByKey.get(key),
      model,
      retryInMs: PAID_UPSTREAM_PROBE_RETRY_MS,
    })
    return false
  }
  return !!rt.sessions.holderFor(model)
}
/** 接管探测失败时的告警消息(判据只此一份). */
const ACK_PAID_UNAVAILABLE =
  'paid-session probe unavailable; retry backed off'
