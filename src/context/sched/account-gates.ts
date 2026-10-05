/**
 * 单账号承接的两道判据: 惰性接管探测 + 两本额度闸门.
 *
 * 从 account-try.ts 按职责切出. 这是最烧钱的一段:
 *   - 上游对[余额不够]的判定就两条(额度跑完 / 所需 Freebucks 高于余额),
 *     命中任一就可能直接封号;
 *   - 而"够不够新买一条"与"能不能接管一条已付过钱的会话"必须分开判
 *     (面板能显示它, 调度就必须能用它);
 *   - 探测必须是惰性的: 官方建会话路径上那个 GET 会真的建出会话.
 */
import { logger } from '../../util/log.js'

/**
 * Freebucks 闸门与新会话预算闸门.
 *
 * 从 checkQuotaGates 抽出. Freebucks 才是上游真正的拒付/封号判据 -- 实测
 * deepseek-v4-flash 在 units 完全没超标时仍被 rate_limited(理由
 * freebucksShortfall{price,balance}), 所以两本账都必须过.
 * @param {any} self 账号池(runtimes)
 * @param {any} rt 账号 runtime
 * @param {string} key 账号 key
 * @param {string} model 请求模型
 * @param {any} opts 透传选项(sessionBudget)
 * @param {boolean} paidTakeover 是否命中"上游有可接管会话"
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @param {Array<any>} failures 失败明细(原地追加)
 * @param {() => Promise<boolean>} checkPaidUpstream 惰性接管探测
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
// ② Freebucks 闸门(货币预算):这才是上游真正的拒付/封号判据----
//    实测 deepseek-v4-flash 在 units=0.1/6 完全没超标的情况下仍被拒,
//    理由是 freebucksShortfall{price,balance}.所以两道闸门都必须过.
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
  logger.info('skip account: freebucks cannot afford model', {
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
 * 从 _tryAccountForModel 抽出. 上游对[余额不够]的判定就两条(额度跑完 / 所需
 * Freebucks 高于余额), 命中任一就可能直接封号; 而"够不够新买一条"与"能不能
 * 接管一条已付过钱的会话"必须分开判.
 *
 * 控制流: 返回 true 表示被闸门拦下(失败已记入 failures); false 表示放行.
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
    // 上游对"余额不够"的判定就两条----额度跑完 / 本次请求所需 Freebucks
    // 高于剩余额度----命中任一条就可能直接封号,所以只在真的要新买一条
    // 计费会话时才拦.注意不能提到 reusable 判断之外:活跃的同模型热
    // session 在 admit 时就已经预扣了整小时,复用它不再产生费用,拦下来
    // 反而等于把已经付过的钱丢掉,再去别的号上买一条新的.
    // ① session_units 闸门(时长预算):一个会话两本账都扣(一手实测),
    //    所以 units 不够时同样不该去买----上游会用 rate_limited 拒掉,
    //    白白一次 admit 往返. recentCount 是小数,比较用 >=.
    const units = rt.sessions.sessionUnitsFor?.(model)
    const fbGate = rt.sessions.freebucksFor?.(model)
    /**
     *  两道额度闸门任一即将拒绝时,先问上游"有没有可接管的已付费会话"
     * (2026-10-04 铁律:balance: 0 只说明"再买一条买不起",
     * 不代表已付费的那一小时不能用;面板都能显示它,调度就必须能用它).
     *
     * 放在这里(而不是函数开头)是刻意的:只有真的要新买一条时才付这次
     * 只读探测的成本.额度充足的普通请求零开销.
     */
    const quotaLooksBlocked =
      (units?.known && units.exhausted) ||
      (fbGate?.known && fbGate.affordable === false)
    /**
     *  额度闸门即将拒绝时,先问上游"有没有我能接管的已付费会话"
     * (2026-10-04 铁律:一次 admit 买断一小时,这一小时内继续发请求边际
     * 成本为 0;balance: 0 只说明"再买一条买不起",不代表那一小时不能用).
     *
     *  只跳过闸门,绝不在这里 return rt(实测踩到):
     * acquireForModel 的契约是"只选号,不建会话" ---- 真正建/接管会话
     * 在本函数更下方的 rt.sessions.ensureSession(model).早期版本在这里
     * return,等于跳过 ensureSession → 会话从未接管 → 报 no_session
     * (实测测试红在 429).正确做法是放行选号,让它走到 ensureSession ----
     * 那里会用 holderFor() 带 takeover 头接管,不新买.
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
      logger.info('skip account: session units exhausted', {
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
 * 惰性探测"上游有没有一条我能接管的已付费会话"(2026-10-04 铁律).
 *
 * 一次 admit 买断一小时, 这一小时内继续发请求边际成本为 0; balance: 0 只说明
 * "再买一条买不起", 不代表已付费的会话不能用. 所以额度闸门只该约束"新买一条".
 *
 * 必须是惰性的(只在额度闸门即将拒绝时才查): 首版把它放在热路径上无条件执行,
 * 于是每个请求都多发一次 GET /session, 而那个 GET 在官方建会话路径上会建出
 * 会话 -- 凭空造出一条 model=A 的会话, 紧接着请求模型 B 就撞
 * paid_window_model_mismatch(实测把既有测试打红).
 * @param {any} rt 账号 runtime
 * @param {string} key 账号 key
 * @param {string} model 请求模型
 * @param {Map<string, any>} emailByKey key 到邮箱
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
  if (rt.sessions.holderFor(model)) {
    state.paid = true
  } else {
    /**
     * 本地上次快照没命中 → 补一次只读探测(GET /session,不建会话,
     * 不扣费).这是唯一能看见"别的部署建的会话"的途径.
     *
     *  早期版本额外要求 hasInventorySnapshot() 为真(怕 GET 建出会话),
     * 实测那会让从未对有账的账号永远探不到 ---- 而它恰恰是最需要探测的
     * 场景(新部署/刚导入,本地什么都没有).只读取形态(带 instanceId 的
     * include-unused-rate-limits)在真实上游不建会话;测试里那个"GET 会
     * 建会话"的 mock 是 get_claim_admit 专用形态,与这里不同.
     */
    await rt.sessions.refresh().catch(() => {})
    state.paid = !!rt.sessions.holderFor(model)
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
