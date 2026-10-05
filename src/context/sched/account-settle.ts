/**
 * admit 的执行与结算: 建/接管会话, 扣预算, 失败归类与冷却.
 *
 * 从 account-try.ts 按职责切出. account-try 只保留"单账号承接"的编排;
 * 这里放真正产生副作用的 admit 段(它同时管会话, 预算与冷却).
 */
import { UpstreamError } from '../../upstream/client.ts'
import { logger } from '../../util/log.ts'
import { PAID_WINDOW_BOUND_CODES, SLOT_BUSY_CODES } from '../state/codes.ts'

/**
 * admit 成功后的结算: 扣预算, 清冷却, 记成功, 预留槽位.
 *
 * 从 admitAndSettle 抽出. 顺序有约束: 只有真的新建了计费会话才扣预算
 * (复用热 session / 被拒绝的 admit 不扣); _rr 要推进到"被选中账号"的下一位,
 * 否则跳过冷却账号时列表末尾的账号会被选中两次.
 * @param {any} self 账号池(runtimes)
 * @param {any} rt 账号 runtime
 * @param {string} key 账号 key
 * @param {string} model 请求模型
 * @param {any} opts 透传选项(sessionBudget)
 * @param {boolean} reusable 该账号是否已有可复用热会话
 * @param {number} admitsBefore 本次 admit 之前的 admitCount
 * @returns {any} 承接结果({ done: true, rt })
 */
async function settleAdmitSuccess(
  self: any,
  rt: any,
  key: any,
  model: any,
  opts: any,
  reusable: boolean,
  admitsBefore: number,
): Promise<any> {
  const reusedSession = reusable
    await rt.sessions.ensureSession(model)
    // 只有真的新建了计费会话才扣预算(复用热 session / 被拒绝的 admit 不扣).
    // remaining === null(0 = 不限)不递减:它不是一个会被用尽的额度.
    if (
      !reusedSession &&
      opts.sessionBudget &&
      opts.sessionBudget.remaining !== null &&
      (rt.sessions.admitCount || 0) > admitsBefore
    ) {
      opts.sessionBudget.remaining -= 1
    }
    self.clearCooldown(key, model)
    self._setLastSuccessKey(key)
    // 指针推进到"被选中账号"的下一位:冷却账号被跳过时依然保持公平轮询
    // (若只按 +1 推进,跳过冷却账号会让列表末尾的账号被选中两次).
    const all = self.allKeys()
    self._rr = (all.indexOf(key) + 1) % Math.max(all.length, 1)
    self._recordSuccess(key)
    // 预留一个槽位意向:选号发生在拿 chat 锁之前,"刚被选中,正在拿锁"
    // 的请求必须被后续并发请求看见,否则 spread 模式会全部挤到同一个账号上.
    // 调用方拿到 chat 锁(或请求失败)后必须调用 rt.releaseReservedSlot().
    rt.releaseReservedSlot = self.reserveSlot(key)
    logger.info('selected account for model', {
      key,
      email: rt.email,
      model,
      reusedSession,
      reserved: self.reservedCount(key),
    })
  return { done: true, rt }
}

/**
 * admit 该模型并结算本次请求的[新会话预算].
 *
 * 从 _tryAccountForModel 抽出(原 admit 段 112 行). 为什么单独成函数: 这里同时管
 * 三件事 -- 真正建/接管会话, 预算扣减(只有新建了计费会话才扣), 以及失败后的
 * 冷却归类(含出口级故障与槽位忙两类不冷却的例外).
 *
 * 返回:
 *   { done: true, rt }         -- 成功承接(已记 reuse/指针/预留)
 *   { stop: true, rec }        -- 出口级故障, 调用方停止选号
 *   { skip: true, rec }        -- 本账号失败, 记一条并换下一个
 * @param {any} self 账号池(runtimes)
 * @param {any} rt 账号 runtime
 * @param {string} key 账号 key
 * @param {string} model 请求模型
 * @param {any} opts 透传选项(sessionBudget)
 * @param {boola} reusable 该账号是否已有可复用热会话
 * @param {Array<any>} failures 失败明细(原地追加)
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @returns {Promise<any>} 承接结果(见上)
 */
export async function admitAndSettle(
  self: any,
  rt: any,
  key: any,
  model: any,
  opts: any,
  reusable: boolean,
  failures: any,
  emailByKey: any,
): Promise<any> {
    const admitsBefore = rt.sessions.admitCount || 0
    try {
      return await settleAdmitSuccess(self, rt, key, model, opts, reusable, admitsBefore)
    } catch (err0) {
      const err: any = err0
      const message = err instanceof Error ? err.message : String(err)
      const rec = {
        key,
        email: emailByKey.get(key),
        code: err?.code,
        message,
        ...(err?.fatal === true ? { fatal: true } : {}),
      }
      failures.push(rec)
      // 出口级故障(地理封锁)是出口属性不是账号属性: 停止选号, 出路是换代理.
      if (err?.fatal === true) {
        return { stop: true, rec }
      }
      // 槽位占用类不冷却: 只是"槽位正在被用", 冷却会把可用账号钉死.
      if (PAID_WINDOW_BOUND_CODES.has(String(err?.code))) {
        // 付费时段绑别模型(issue #24): 账号健康, 不释放也不冷却.
        logger.warn('account holds a paid session for another model; skipping', {
          key,
          email: emailByKey.get(key),
          code: err?.code,
          model,
          boundModel: err?.body?.boundModel ?? null,
          expiresAt: err?.body?.expiresAt ?? null,
        })
      } else if (SLOT_BUSY_CODES.has(String(err?.code))) {
        /**
         *  必须把上游回执的细节记下来(2026-10-04 教训).
         *
         * purchase_capacity / purchase_in_use / premium_slot_taken 的
         * 回执里带 currentInstanceId / nextExpiryAt / slotLimit ----
         * 那是定位"槽位被谁占"的唯一线索.此前只记 code,于是用户遇到
         * [上游说 status:none,balance 15,本地却一直 slot busy]时
         * 完全查不出是谁占的(我为此白查了一轮).
         */
        const b = err?.body && typeof err.body === 'object' ? err.body : {}
        logger.warn('account session slot busy; not cooling', {
          key,
          email: emailByKey.get(key),
          code: err?.code,
          model,
          currentInstanceId: b.currentInstanceId ?? null,
          nextExpiryAt: b.nextExpiryAt ?? null,
          slotLimit: b.slotLimit ?? null,
          concurrency: b.concurrency ?? null,
          requestedModel: b.requestedModel ?? null,
        })
      } else {
        const wrap =
          err instanceof UpstreamError
            ? err
            : new UpstreamError(message, { status: 502, code: 'admit_failed' })
        self.markCooldown(key, wrap, model)
      }
      logger.warn('account ensureSession failed; trying next', {
        key,
        email: emailByKey.get(key),
        model,
        error: message,
        code: err?.code,
      })
      return { skip: true, rec }
    }
}
