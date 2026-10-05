/**
 * 全部账号都没能承接时的归因与错误体构造.
 *
 * 从 _acquireForModelUnlocked 抽出(原方法 271 行, 尾巴 183 行全是这一族分支).
 * 为什么单独成模块: 这些分支决定"用户看到什么错误码与什么解释", 是排障体验的
 * 全部来源. 它们只依赖 failures / model / 两本额度账, 与选号流程无关.
 *
 * 返回 never: 每条支路都以 throw 结束; 调用方写完这条语句即代表"控制流已终止".
 */
import { UpstreamError } from '../../upstream/client.ts'
import {
  countReasons,
  sanitizeFailuresForClient,
  summarizeFreebucks,
} from '../ops/round-handlers.ts'
import { PAID_WINDOW_BOUND_CODES } from '../state/codes.ts'

/**
 * 按失败明细聚合出对应的 UpstreamError 并抛出.
 * @param {any} self 账号池(runtimes)
 * @param {Array<any>} failures 失败明细
 * @param {string} model 请求模型
 * @param {any} fatalFailure 出口级故障记录(非空则优先抛出)
 * @returns {void} 条件命中时抛出; 否则返回让调用方继续下一类归因
 */
/**
 * 全池账号都[这一小时已买给别的模型]时的错误.
 *
 * 与额度无关的一类不可用: 账号健康, 有钱, 有会话, 只是每个号在付费时段内各绑
 * 一个模型. 必须给独立错误码并把恢复时刻说清, 否则用户只能去查账号/额度 --
 * 而查不出任何问题(面板显示 ok).
 * @param {any} self 账号池(runtimes)
 * @param {Array<any>} failures 失败明细
 * @param {string} model 请求模型
 * @returns {void} 条件命中时抛出; 否则返回让调用方继续下一类归因
 */
export function throwPaidWindowBound(self: any, failures: any, model: any): void {
  const allPaidBound =
    failures.length > 0 &&
    failures.every((f: any) => PAID_WINDOW_BOUND_CODES.has(f.code))
  if (allPaidBound) {
    // 恢复时刻 = 最早到期的那条已付费会话(批号里取最小 expiresAt)
    let resumeAtMs = null
    for (const f of failures) {
      const exp = Date.parse(f?.body?.expiresAt || '')
      if (Number.isFinite(exp) && (resumeAtMs == null || exp < resumeAtMs)) {
        resumeAtMs = exp
      }
    }
    const waitMs =
      resumeAtMs != null ? Math.max(0, resumeAtMs - Date.now()) : null
    throw new UpstreamError(
      `Every account already holds a paid hour bound to another model; ` +
        `switching now would void the hour already paid for. ` +
        (waitMs != null
          ? `Retry after ${new Date(resumeAtMs as number).toISOString()} ` +
            `(about ${Math.ceil(waitMs / 60000)} min), or use the model each account is currently bound to.`
          : `Retry later, or use the model each account is currently bound to.`) +
        ` ${failures.length} account(s) tried.`,
      {
        status: 429,
        code: 'paid_window_model_mismatch',
        body: {
          model,
          failures: sanitizeFailuresForClient(failures),
          reasons: countReasons(failures),
          tried: failures.length,
          banned: 0,
          // 每个账号此刻绑定的模型:用户据此改用它们(而不是干等)
          boundModels: failures
            .map((f: any) => f?.body?.boundModel)
            .filter(Boolean),
          resumeAt: resumeAtMs != null ? new Date(resumeAtMs).toISOString() : null,
        },
        retryAfterMs: waitMs ?? undefined,
      },
    )
  }
}

/**
 * 全池都被[本次请求的新会话预算]拦下时的错误.
 *
 * 本地请求级限制, 不是账号不可用: 该重试(下个请求重新拿到预算)或调高控制台
 * [额度保护]里的单请求新会话上限.
 * @param {any} self 账号池(runtimes)
 * @param {Array<any>} failures 失败明细
 * @param {string} model 请求模型
 * @returns {void} 条件命中时抛出; 否则返回让调用方继续下一类归因
 */
export function throwBudgetExhausted(self: any, failures: any, model: any): void {
  const allBudgetExhausted =
    failures.length > 0 &&
    failures.every((f: any) => f.code === 'session_budget_exhausted')
  if (allBudgetExhausted) {
    throw new UpstreamError(
      'No available Freebuff account for model ' +
        model +
        ': this request used up its new-session budget (Freebucks meter). ' +
        'Retry, or raise the per-request new-session limit in the console. ' +
        'Tried ' + failures.length + ' account(s).',
      {
        status: 429,
        code: 'session_budget_exhausted',
        body: {
          model,
          failures: sanitizeFailuresForClient(failures),
          reasons: countReasons(failures),
          tried: failures.length,
          banned: failures.filter((f: any) => f.code === 'banned').length,
        },
        retryAfterMs: self.earliestCooldownMs(),
      },
    )
  }
}

/**
 * 全池额度用尽(两本账任一)时的错误.
 *
 * 附上终态语义与 resetAt: 这是遍历完所有账号才得出的聚合结论, 换号不可能
 * 改变它, 下游不该盲目重试.
 * @param {any} self 账号池(runtimes)
 * @param {Array<any>} failures 失败明细
 * @param {string} model 请求模型
 * @returns {void} 条件命中时抛出; 否则返回让调用方继续下一类归因
 */
export function throwAllExhausted(self: any, failures: any, model: any): void {
  const EXHAUST_CODES = new Set(['freebucks_exhausted', 'units_exhausted'])
  const allExhausted =
    failures.length > 0 && failures.every((f: any) => EXHAUST_CODES.has(f.code))
  if (allExhausted) {
    //  顶层 message 也不能拼 failures 的原始 message:那条 message 里
    // 可能带邮箱/账号标识,而 message 是下游最先看到,最容易被整段转发的字段.
    // 这里只给聚合概览(几个账号,什么类型),明细看 details.reasons.
    const summary = Object.entries(countReasons(failures))
      .map(([c, n]: any) => `${c}×${n}`)
      .join(', ')
    // 两个闸门都命中时用更中性的 freebucks_exhausted 保持兼容(既有调用方/测试
    // 认这个码);只有全是 units 用尽时才报 units_exhausted.
    const onlyUnits = failures.every((f: any) => f.code === 'units_exhausted')
    const code = onlyUnits ? 'units_exhausted' : 'freebucks_exhausted'
    /**
     *  全池额度耗尽 = 终态,必须一次就收场(2026-10-04 真实事故).
     *
     * 旧行为:这里抛单账号级的 freebucks_exhausted,而外层
     * shouldSwitchAccountOnError(429, ...) 把 429 判成"该换号" →
     * 再轮一遍全部账号 → 全部买不起 → 再抛同样的错 → 循环到 maxAttempts.
     * 实测(远程日志 14:01:47-14:02:00):13 个客户端请求,每个都白轮 3 次,
     * 每次都要遍历所有账号查额度 ---- 而这些日志本身把日志缓冲冲爆了,
     * 导致用户事后查不到更早的排障记录(这是我加日志缓冲太小之外的连带伤害).
     *
     * 现在:这是聚合结论(遍历完所有账号才得出),不是某个账号的瞬时故障 ----
     * 换号不可能改变它(池子里每一个都被检查过了).所以:
     *   1) 附上 no_available_account 这个终态语义(外层 isTerminal 直接返回);
     *   2) 带上 resetAt,让下游知道何时能恢复,而不是盲目重试.
     *
     * 注意保留 code(freebucks_exhausted / units_exhausted)以兼容既有消费方,
     * 只在消息与 body 里补终态信息 ---- 判据由 terminalExhausted 标记表达.
     */
    throw new UpstreamError(
      `No Freebuff account can afford model ${model} ` +
        `(${onlyUnits ? 'session units' : 'Freebucks'} exhausted). ` +
        `${failures.length} account(s) tried (${summary}).` +
        ` Retry after ${new Date(Date.now() + self.earliestCooldownMs()).toISOString()}.`,
      {
        status: 429,
        code,
        /**
         * 终态标记:池内每个账号都因额度被拒,重试(换号/同号)都不会成功.
         * 外层 proxy.js 据此直接返回,不再轮 maxAttempts 轮.
         */
        terminalExhausted: true,
        body: {
          model,
          failures: sanitizeFailuresForClient(failures),
          reasons: countReasons(failures),
          tried: failures.length,
          banned: failures.filter((f: any) => f.code === 'banned').length,
          ...(summarizeFreebucks(failures, self, model) || {}),
        },
        retryAfterMs: self.earliestCooldownMs(),
      },
    )
  }
  /**
   * 笼统兜底:no_available_account.
   *
   *  这里也必须带上额度账.真实部署里最常见的就是这个码:账号没封
   * (banned=0),没冷却,只是余额买不起下一个小时.此前它只回"没有可用
   * 账号",用户据此去查账号/凭证 ---- 查不出任何问题,只能反复重试.
   * 带上 balance / price / resetAt 后,这句话才自解释.
   */
}

/**
 * 笼统兜底: no_available_account.
 *
 * 真实部署里最常见的就是这个码(没封没冷却, 只是买不起下一个小时). 带上逐账号
 * 的额度账与恢复时刻, 这句话才自解释.
 * @param {any} self 账号池(runtimes)
 * @param {Array<any>} failures 失败明细
 * @param {string} model 请求模型
 * @returns {void} 条件命中时抛出; 否则返回让调用方继续下一类归因
 */
export function throwNoAvailableAccount(self: any, failures: any, model: any): void {
  const fbSummary = summarizeFreebucks(failures, self, model)
  /**
   *  message 里逐账号列出每一笔账,不再只报"最差那个".
   *
   * 实测误导(2026-10-04 用户报):池里 3 个号,其中有 15 点的那个被
   * 正常放行,卡在槽位;而 message 只报 balance 0 < price 15(那是另外两个
   * 0 余额号的账)→ 用户看到"页面明明显示 15,却说我一点都没有".
   *
   * 数字必须与账号一一对应才不误导.message 不写邮箱(那是 PII,
   * 且 message 最容易被整段转发),只按序号列出每笔账.
   */
  const ledger = (fbSummary?.accounts || [])
    .map(
      (a: any, i: any) =>
        `#${i + 1} balance=${a.balance ?? '?'} price=${a.price ?? '?'}` +
        ` (daily ${a.dailyRemaining ?? '?'}/${a.dailyLimit ?? '?'}${a.reason ? `, ${a.reason}` : ''})`,
    )
    .join('; ')
  throw new UpstreamError(
    `No available Freebuff account for model ${model}. Tried ${failures.length} account(s).` +
      (ledger
        ? ` Per-account Freebucks: ${ledger}.` +
          (fbSummary?.resetAt ? ` Refills ${fbSummary.resetAt}.` : '') +
          ' One admit buys a whole hour and is charged upfront.'
        : ''),
    {
      status: 429,
      code: 'no_available_account',
      body: {
        model,
        failures: sanitizeFailuresForClient(failures),
        reasons: countReasons(failures),
        tried: failures.length,
        banned: failures.filter((f: any) => f.code === 'banned').length,
        ...(fbSummary || {}),
      },
      retryAfterMs: self.earliestCooldownMs(),
    },
  )
}

/**
 * 按失败明细聚合出对应的 UpstreamError 并抛出.
 *
 * 四类归因各自成函数(见同文件上方), 这里只做检查顺序与出口级故障的短路:
 * 出口级优先(换号无意义), 再付费时段绑定, 再两本额度账, 最后兜底.
 * @param {any} self 账号池(runtimes)
 * @param {Array<any>} failures 失败明细
 * @param {string} model 请求模型
 * @param {any} fatalFailure 出口级故障记录(非空则优先抛出)
 * @returns {void} 条件命中时抛出; 否则返回让调用方继续下一类归因
 */
export function throwAcquireFailure(
  self: any,
  failures: any,
  model: any,
  fatalFailure: any,
): never {
  if (fatalFailure) {
    throw new UpstreamError(
      'Upstream blocked this egress: ' + fatalFailure.message,
      {
        status: 403,
        code: fatalFailure.code,
        // 出口级故障: 原因要让用户看懂(该换代理而非换号), 但不给账号标识.
        body: { model, egress: true, reason: fatalFailure.code },
      },
    )
  }
  throwPaidWindowBound(self, failures, model)
  throwBudgetExhausted(self, failures, model)
  throwAllExhausted(self, failures, model)
  throwNoAvailableAccount(self, failures, model)
  // 四个分支都只在条件命中时抛出; 走到这里说明 failures 为空(调用方已保证非空),
  // 兜一个显式抛错, 让本函数的返回类型诚实地是 never.
  throw new UpstreamError(`No available Freebuff account for model ${model}.`, {
    status: 429,
    code: 'no_available_account',
    body: { model, failures: [], tried: 0 },
  })
}
