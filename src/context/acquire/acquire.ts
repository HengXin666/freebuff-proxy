/**
 * 选号与重试的加锁入口 ---- 从 src/app-context.ts 按职责切出.
 *
 * 本模块是"拿到 runtime"的完整流程: 冷启动串行化的选号 / 换号或同号重试 /
 * 同号重试的两本账闸门. 候选排序(candidates)回答"先试谁", 这里回答
 * "怎么试, 失败后怎么接着试".
 *
 * 模块级函数 + self/this 首参, 由 src/context/methods.ts 的 CONTEXT_METHODS
 * 装配回原型(名字即契约).
 *
 * 两本账是并行的两道闸门(units 与 Freebucks 各自独立扣费); 428 排在两道闸门
 * 之前 ---- 续用不花钱.
 */
import { listAccounts } from '../../auth-store.ts'
import { UpstreamError, isSessionRecoverableGate } from '../../upstream/client.ts'
import { logger } from '../../util/log.ts'
import { throwAcquireFailure } from '../sched/account-callers.ts'
import { _tryAccountForModel } from '../sched/account-try.ts'
import {
  PAID_WINDOW_BOUND_CODES,
  SLOT_BUSY_CODES,
  SWITCHABLE_CODES,
} from '../state/codes.ts'
import { collectCooldownFailures, candidateKeys } from '../select/candidates.ts'
import { countReasons } from '../ops/round-handlers.ts'

/**
 * 冷启动串行化下的选号: 遍历候选, 逐个尝试, 汇总失败明细.
 *
 * 全池额度耗尽 / 出口级封锁在这里收敛成可操作的具名错误码, 未命中时才落到
 * 笼统的 no_available_account.
 * @param {any} this 账号池(runtimes)
 * @param {string} model 请求模型
 * @param {any} [opts] 选号选项(skipKeys / sessionBudget)
 * @returns {Promise<any>} 选中的 runtime
 */
export async function _acquireForModelUnlocked(this: any, model: any, opts: any = {}) {
  if (!model) {
    throw new UpstreamError('model is required', {
      status: 400,
      code: 'model_required',
    })
  }

  const rows = listAccounts(this.dir)
  const keys = rows.map((r) => r.key)
  if (!keys.length) {
    throw new UpstreamError(
      'No Freebuff accounts. Add one via the web console (账号管理 → 添加账号) or run `npm run login`.',
      { status: 401, code: 'upstream_auth_missing' },
    )
  }
  const emailByKey = new Map(rows.map((r) => [r.key, r.email]))

  const order = candidateKeys.call(this, model, { skipKeys: opts.skipKeys })
  /** @type {Array<{ key: string, email?: string, code?: string, message: string }>} */
  const failures: any = []
  /** 出口级故障(如地理封锁)的首条记录:出现即停止选号. */
  let fatalFailure = null

  if (!order.length) collectCooldownFailures(this, keys, model, emailByKey, failures)
  for (const key of order) {
    const outcome = await _tryAccountForModel.call(
      this,
      key,
      model,
      opts,
      failures,
      emailByKey,
    )
    if (outcome.done) return outcome.rt
    if (outcome.stop) {
      fatalFailure = failures[failures.length - 1]
      break
    }
  }

  // 全部账号都是"余额买不起"时给出独立错误码: 与"账号都在冷却/没号"是不同处境
  // (前者等每日池刷新, 后者要加号/等冷却), 不给调用方与控制台同一个笼统的
  // no_available_account.
  // 两本账任一耗尽都算"额度用尽"(与分开的闸门一一对应):
  //   freebucks_exhausted = 货币预算不够(上游真正的拒付判据)
  //   units_exhausted     = 时长预算用尽
  // 出口级故障(地理封锁): 它是出口属性不是账号属性, 换号无意义.
  // 原样抛出(带 countryCode), 让用户知道该换代理.
  // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
  if (fatalFailure) {
    throw new UpstreamError(
      'Upstream blocked this egress: ' + fatalFailure.message,
      {
        status: 403,
        code: fatalFailure.code,
        // 出口级故障: 给出可读的失败说明与 egress 标记, 但不给账号标识
        // ---- 它是出口的属性, 与具体哪个账号无关.
        body: {
          model,
          failures: [{ code: fatalFailure.code }],
          reasons: countReasons([fatalFailure]),
          tried: 1,
          egress: true,
        },
        // 必须原样带上 fatal:外层据此立即收场,不再重试换号.
        fatal: true,
      },
    )
  }
  return throwAcquireFailure(this, failures, model, fatalFailure)
}

/**
 * 换号 / 同号重试的统一入口(持锁后调用).
 *
 * 分三支: 槽位占用类不冷却但换号; noCooldown 且 switchAccount 的瞬时排队类
 * 直接续用原 runtime; 其余走同号重试, 失败才全新选号.
 * @param {any} this 账号池(runtimes)
 * @param {string} model 请求模型
 * @param {any} [opts] 换号/重试选项(preferredKey / gateCode / switchAccount ...)
 * @returns {Promise<any>} 承接的 runtime
 */
export async function _reacquireAfterGateUnlocked(this: any, model: any, opts: any = {}) {
  if (opts.preferredKey) {
    if (
      opts.switchAccount ||
      (opts.gateCode && SWITCHABLE_CODES.has(opts.gateCode))
    ) {
      // 槽位占用类不冷却: 它不是账号故障, 只是"槽位正在被用", 等它空出即可.
      // 冷却会把可用账号钉死. 见
      // .agents/notes/implemented/bug-fix/2026-10-01-admission-handle-and-403.md
      if (
        !opts.noCooldown &&
        !SLOT_BUSY_CODES.has(String(opts.gateCode)) &&
        !PAID_WINDOW_BOUND_CODES.has(String(opts.gateCode))
      ) {
        logger.warn('gate is slot-busy; switching account without cooling', {
          key: opts.preferredKey,
          gateCode: opts.gateCode,
          model,
        })
        this.markCooldown(
          opts.preferredKey,
          new UpstreamError(opts.gateCode, {
            code: opts.gateCode,
            status: 429,
            retryAfterMs: opts.retryAfterMs ?? 30_000,
          }),
          model,
        )
      } else if (opts.switchAccount) {
        // noCooldown 且 switchAccount(free_mode_capacity_deferred / account_busy /
        // runtime_superseded): 不是真故障, 分两种情况:
        try {
          const rt = this.get(opts.preferredKey)
          const callerHoldsLock =
            opts.gateCode !== 'account_busy' &&
            opts.gateCode !== 'runtime_superseded'
          if (
            rt.sessions.isUsableForModel(model) &&
            (callerHoldsLock || !this.isChatBusy(opts.preferredKey))
          ) {
            this.clearCooldown(opts.preferredKey, model)
            this._setLastSuccessKey(opts.preferredKey)
            return rt
          }
        } catch {
          // 账号已不可用(凭据变更等) -> 走全新选号
        }
      }
    } else {
      const retried = await this._retrySameAccount(model, opts)
      if (retried) return retried
    }
  }
  return this._acquireForModelUnlocked(model, opts)
}

/**
 * 同号重试: 非账号级故障(5xx / 网络抖动 / gate)时在原账号上重试.
 *
 * 关键约束: 会新买一条计费会话的路径(forceReadmit)必须先过两本额度账;
 * 428 排在两道闸门之前 ---- 续用不花钱.
 * @param {any} this 账号池(runtimes)
 * @param {string} model 请求模型
 * @param {any} opts 换号/重试选项
 * @returns {Promise<any | null>} 承接的 runtime; null = 该走全新选号
 */
export async function _retrySameAccount(this: any, model: any, opts: any) {
  try {
    const rt = this.get(opts.preferredKey)
      // 非 session-gate 的失败(5xx / 网络抖动 / 上游瞬时故障)在同一账号上重试:
    // 会话还能用就直接复用 ---- 绝不为了重试再买一条计费 session.
    if (
      (!opts.gateCode || !isSessionRecoverableGate(opts.gateCode)) &&
      rt.sessions.isUsableForModel(model)
    ) {
      this.clearCooldown(opts.preferredKey, model)
      this._setLastSuccessKey(opts.preferredKey)
      return rt
    }
    // 同账号 gate 重试时, 调用方(chat 流程)已持有该账号的串行化锁, 不会与另一个
    // 在途 chat 冲突, 可直接 forceReadmit. 但 forceReadmit 会新买一条计费会话.
    // 428 排在两道额度闸门之前: 续用不花钱, 被"买不起"拦下会白扔掉已付款的那一小时.
    if (opts.gateCode === 'waiting_room_required') {
      const cont = await rt.sessions.readmitToContinue(model)
      if (cont.continued) {
        this.clearCooldown(opts.preferredKey, model)
        this._setLastSuccessKey(opts.preferredKey)
        logger.info('re-admitted with continuity (428: reused the paid hour)', {
          key: opts.preferredKey,
          model,
          instanceId: cont.instanceId || null,
        })
        return rt
      }
      // 续用没成:保留会话现场抛出,让上层换号;绝不在此释放
      throw new UpstreamError(
        `waiting_room_required: could not continue the existing session (${cont.reason || 'not_active'})`,
        { status: 428, code: 'waiting_room_required' },
      )
    }
    const unitGate = rt.sessions.sessionUnitsFor?.(model)
    if (unitGate?.known && unitGate.exhausted) {
      throw new UpstreamError(
        `session units exhausted (${unitGate.used}/${unitGate.limit}) for ${model}`,
        { status: 429, code: 'units_exhausted' },
      )
    }
    const fbGate = rt.sessions.freebucksFor?.(model)
    if (fbGate?.known && fbGate.affordable === false) {
      logger.info('skip re-admit: freebucks cannot afford model', {
        key: opts.preferredKey,
        model,
        reason: fbGate.reason || 'balance_shortfall',
        balance: fbGate.balance,
        price: fbGate.price,
        dailyRemaining: fbGate.dailyRemaining,
        dailyLimit: fbGate.dailyLimit,
      })
      throw new UpstreamError(
        fbGate.reason === 'daily_exhausted'
          ? `freebucks daily pool exhausted for ${model}`
          : `freebucks balance ${fbGate.balance} < price ${fbGate.price} for ${model}`,
        { status: 429, code: 'freebucks_exhausted' },
      )
    }
    // 428 已在上方先行处理. 走到这里的是其它需换号的 gate:
    // forceReadmit 先 DELETE 再 admit, 会新买一条计费会话.
    await rt.sessions.forceReadmit(model)
    this.clearCooldown(opts.preferredKey, model)
    this._setLastSuccessKey(opts.preferredKey)
    return rt
  } catch (err) {
    const wrap =
      err instanceof UpstreamError
        ? err
        : new UpstreamError(String(err), { code: 'admit_failed' })
    this.markCooldown(opts.preferredKey, wrap, model)
    return null
  }
}
