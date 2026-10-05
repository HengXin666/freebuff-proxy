/**
 * 单账号承接: 尝试用某个候选账号完成一次请求.
 *
 * 这里集中全部"该不该用这个账号"的判断: 两本额度账(units / Freebucks), 付费时段
 * 接管, 新会话预算, 热会话复用, 以及失败后的冷却.
 */
import { UpstreamError } from '../../upstream/client.ts'
import { logger } from '../../util/log.ts'
import { PAID_WINDOW_BOUND_CODES, SLOT_BUSY_CODES } from '../state/codes.ts'
import { admitAndSettle } from './account-settle.ts'
import { checkQuotaGates, makePaidUpstreamChecker } from './account-gates.ts'

/**
 * 冷却预检: 该账号(或该模型在它上)是否仍在冷却中.
 *
 * 冷却中的账号直接跳过并不再记失败: 它已在冷却那一刻记过一次, 重复记会让同一个号
 * 在每个请求里刷失败明细.
 * @param {any} self 账号池(runtimes)
 * @param {string} key 账号 key
 * @param {string} model 请求模型
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @param {Array<any>} failures 失败明细(原地追加)
 * @returns {boolean} 冷却中则为真(调用方应换下一个账号)
 */
function isCooledForModel(
  self: any,
  key: any,
  model: any,
  emailByKey: any,
  failures: any,
): boolean {
  if (self.isCoolingDown(key, model)) {
    const cd =
      self.cooldowns.get(key) ||
      self.cooldowns.get(self._cooldownKey(key, model))
    failures.push({
      key,
      email: emailByKey.get(key),
      code: cd?.code || 'cooldown',
      message: `cooling down until ${cd ? new Date(cd.until).toISOString() : '?'}`,
    })
    return true
  }
  return false
}

/**
 * 尝试用单个候选账号承接一次请求.
 *
 * 这段是"这个账号能不能用"的完整判据与副作用(两本额度账, 付费时段接管,
 * 新会话预算, admit, 冷却).
 *
 * 控制流用返回值表达(JS 跨函数没有 continue/break):
 *   { done: true, rt } -- 该账号已承接, 调用方立即返回它
 *   { next: true }     -- 换下一个账号
 *   { stop: true }     -- 停止选号(出口级故障)
 * @param {any} this 账号池(runtimes)
 * @param {string} key 候选账号 key
 * @param {string} model 请求模型
 * @param {any} opts 透传选项(sessionBudget)
 * @param {Array<any>} failures 失败明细(原地追加)
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @returns {Promise<any>} 承接结果(见上)
 */
export async function _tryAccountForModel(
  this: any,
  key: any,
  model: any,
  opts: any,
  failures: any,
  emailByKey: any,
): Promise<any> {
  const NEXT = { next: true }
  const STOP = { stop: true }
    if (isCooledForModel(this, key, model, emailByKey, failures)) return NEXT

    let rt
    try {
      rt = this.get(key)
    } catch (err0) {
      const err: any = err0
      const rec = {
        key,
        email: emailByKey.get(key),
        code: err?.code,
        message: err instanceof Error ? err.message : String(err),
        ...(err?.fatal === true ? { fatal: true } : {}),
      }
      failures.push(rec)
      // 出口级故障(地理封锁):所有账号共享同一出口,继续换号只会把每个
      // 账号的 Freebucks 依次买断(一次 admit = 一整小时)却拿不到答案.
      // 立即停止选号,把失败说明原样交给用户.
      // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
      if (err?.fatal === true) {
        return { stop: true, rec }
      }
  return NEXT
    }

    const reusable = rt.sessions.isUsableForModel(model)
    /**
     * [上游有没有一条我能接管的已付费会话] ---- 惰性查询.
     *
     * 一次 admit 买断一小时, 这一小时内继续发请求边际成本为 0;
     * 而 balance: 0 只说明"再买一条买不起". 所以额度闸门只约束"新买一条".
     *
     * 惰性: 只在额度闸门即将拒绝时才查. 那个 GET 在官方建会话路径上会建出会话,
     * 提前或无条件执行会凭空造出一条 model=A 的会话, 紧接着请求模型 B 就撞
     * paid_window_model_mismatch.
     *
     * 清单可能过期(另一个部署刚买的), 所以只有在本地上次快照没命中时才补一次只读探测.
     */
    const checkPaidUpstream = makePaidUpstreamChecker(rt, key, model, emailByKey)
    /**
     * 额度闸门(units / freebucks / 新会话预算)只约束"新买一条", 且只在真的要新买时
     * 才问上游"有没有可接管的已付费会话"(可用账号路径零开销), 有则跳过闸门直接复用.
     *
     * 触发条件是"本账号买不起"(两道额度闸门任一命中), 不是 reusable||checkPaidUpstream:
     * 后者对额度充足的普通请求也会多发一次 GET /session.
     *
     * 整个闸门包在 !reusable 里: 活跃的同模型热 session 在 admit 时就已经预扣了整小时,
     * 复用它不再产生费用; 拦下来等于把已经付过的钱丢掉再去别的号上买一条新的.
     */
    if (!reusable) {
      if (await checkQuotaGates(this, rt, key, model, opts, emailByKey, failures, checkPaidUpstream)) return NEXT
    }

    const outcome = await admitAndSettle(
      this, rt, key, model, opts, reusable, failures, emailByKey,
    )
    if (outcome.done) return outcome
    if (outcome.stop) return outcome
    return NEXT
}
