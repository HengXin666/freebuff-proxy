/**
 * 全部账号都没能承接时的归因与错误体构造.
 *
 * 这些分支决定用户看到什么错误码与什么解释, 只依赖 failures / model / 两本额度账,
 * 与选号流程无关. 一类的判定条件与其错误体各自成函数.
 *
 * 返回 never: 每条支路都以 throw 结束.
 */
import { UpstreamError } from '../../upstream/client.ts'
import {
  countReasons,
  sanitizeFailuresForClient,
  summarizeFreebucks,
} from '../ops/round-handlers.ts'
import { PAID_WINDOW_BOUND_CODES } from '../state/codes.ts'

/**
 * 对外展示用的模型名.
 *
 * 错误消息与错误体里的 model 是下游最先看到, 也最容易被整段转发的字段 ----
 * 此前直接拼目录 key(m-096e75164d), 用户根本认不出是哪个模型.
 * 这里统一换成可读名; 目录 key 仍以 freebuff_key 并列透出(排障要能对上上游日志).
 *
 * 取不到名字时原样返回, 不隐藏信息(与 catalogDisplayName 同一条纪律).
 *
 * @param {any} self 账号池(runtimes)
 * @param {any} model 请求模型(可能是目录 key)
 * @returns {string} 可读模型名
 */
function readableModel(self: any, model: any): string {
  if (typeof model !== 'string' || !model) return String(model ?? '')
  try {
    return self?.displayNameFor?.(model) || model
  } catch {
    return model
  }
}

/**
 * 全池账号都[这一小时已买给别的模型]时的错误.
 *
 * 与额度无关的一类不可用: 账号健康, 有钱, 有会话, 只是每个号在付费时段内各绑一个模型.
 * 必须给独立错误码并把恢复时刻说清.
 * @param {any} self 账号池(runtimes)
 * @param {Array<any>} failures 失败明细
 * @param {string} model 请求模型
 * @returns {void} 命中条件时抛出, 未命中时正常返回
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
          model: readableModel(self, model),
          freebuff_key: model,
          failures: sanitizeFailuresForClient(failures),
          reasons: countReasons(failures),
          tried: failures.length,
          banned: 0,
          // 每个账号此刻绑定的模型, 供用户改用
          boundModels: failures
            .map((f: any) => f?.body?.boundModel)
            .filter(Boolean)
            .map((m: any) => readableModel(self, m)),
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
 * @returns {void} 命中条件时抛出, 未命中时正常返回
 */
export function throwBudgetExhausted(self: any, failures: any, model: any): void {
  const allBudgetExhausted =
    failures.length > 0 &&
    failures.every((f: any) => f.code === 'session_budget_exhausted')
  if (allBudgetExhausted) {
    throw new UpstreamError(
      'No available Freebuff account for model ' +
        readableModel(self, model) +
        ': this request used up its new-session budget (Freebucks meter). ' +
        'Retry, or raise the per-request new-session limit in the console. ' +
        'Tried ' + failures.length + ' account(s).',
      {
        status: 429,
        code: 'session_budget_exhausted',
        body: {
          model: readableModel(self, model),
          freebuff_key: model,
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
 * @returns {void} 命中条件时抛出, 未命中时正常返回
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
    throw new UpstreamError(
      `No Freebuff account can afford model ${readableModel(self, model)} ` +
        `(${onlyUnits ? 'session units' : 'Freebucks'} exhausted). ` +
        `${failures.length} account(s) tried (${summary}).` +
        ` Retry after ${new Date(Date.now() + self.earliestCooldownMs()).toISOString()}.`,
      {
        status: 429,
        code,
        /**
         * 终态标记:池内每个账号都因额度被拒, 重试(换号/同号)都不会成功.
         * 外层据此直接返回, 不再轮 maxAttempts 轮.
         */
        terminalExhausted: true,
        body: {
          model: readableModel(self, model),
          freebuff_key: model,
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
}

/**
 * 笼统兜底: no_available_account.
 *
 * 池内没有能承接的账号, 且不落在上面任一类. 带上逐账号的额度账与恢复时刻.
 * @param {any} self 账号池(runtimes)
 * @param {Array<any>} failures 失败明细
 * @param {string} model 请求模型
 * @returns {void} 始终抛出
 */
export function throwNoAvailableAccount(self: any, failures: any, model: any): void {
  const fbSummary = summarizeFreebucks(failures, self, model)
  // message 里按序号逐账号列出每一笔账. 不写邮箱(那是 PII), 只给序号与数字.
  const ledger = (fbSummary?.accounts || [])
    .map(
      (a: any, i: any) =>
        `#${i + 1} balance=${a.balance ?? '?'} price=${a.price ?? '?'}` +
        ` (daily ${a.dailyRemaining ?? '?'}/${a.dailyLimit ?? '?'}${a.reason ? `, ${a.reason}` : ''})`,
    )
    .join('; ')
  throw new UpstreamError(
    `No available Freebuff account for model ${readableModel(self, model)}. Tried ${failures.length} account(s).` +
      (ledger
        ? ` Per-account Freebucks: ${ledger}.` +
          (fbSummary?.resetAt ? ` Refills ${fbSummary.resetAt}.` : '') +
          ' One admit buys a whole hour and is charged upfront.'
        : ''),
    {
      status: 429,
      code: 'no_available_account',
      body: {
        model: readableModel(self, model),
        freebuff_key: model,
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
 * @returns {never} 始终抛出
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
        // 出口级故障: 给用户可读的失败说明与 egress 标记, 但不给账号标识.
        body: {
          model: readableModel(self, model),
          freebuff_key: model,
          egress: true,
          reason: fatalFailure.code,
        },
      },
    )
  }
  throwPaidWindowBound(self, failures, model)
  throwBudgetExhausted(self, failures, model)
  throwAllExhausted(self, failures, model)
  throwNoAvailableAccount(self, failures, model)
  // 四个分支都只在条件命中时抛出; 走到这里说明 failures 为空(调用方已保证非空),
  // 兜一个显式抛错, 让本函数的返回类型诚实地是 never.
  throw new UpstreamError(
    `No available Freebuff account for model ${readableModel(self, model)}.`,
    {
      status: 429,
      code: 'no_available_account',
      body: {
        model: readableModel(self, model),
        freebuff_key: model,
        failures: [],
        tried: 0,
      },
    },
  )
}
