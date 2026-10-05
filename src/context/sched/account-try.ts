/**
 * 单账号承接: 尝试用某个候选账号完成一次请求.
 *
 * 从 app-context.js 的 _acquireForModelUnlocked 抽出. 这里集中了全部
 * "该不该用这个账号 / 用了会付出什么代价"的判断, 是本仓最容易出错的一段:
 * 两本额度账(units / Freebucks), 付费时段接管, 新会话预算, 热会话复用,
 * 以及失败后的冷却. 任何一处判据漂移都会直接烧钱, 因此单独成文件.
 */
import { UpstreamError } from '../../upstream/client.ts'
import { logger } from '../../util/log.ts'
import { PAID_WINDOW_BOUND_CODES, SLOT_BUSY_CODES } from '../state/codes.ts'
import { admitAndSettle } from './account-settle.ts'
import { checkQuotaGates, makePaidUpstreamChecker } from './account-gates.ts'

/**
 * 冷却预检: 该账号(或该模型在它上)是否仍在冷却中.
 *
 * 从 _tryAccountForModel 抽出. 冷却中的账号直接跳过并不再记失败(它已经在
 * 冷却那一刻记过一次), 否则同一个号会在每个请求里重复刷失败明细.
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
 * 从 _acquireForModelUnlocked 的 for-of 循环体抽出(原方法 598 行, 循环体 342 行).
 * 这段是"这个账号能不能用"的完整判据与副作用(两本额度账, 付费时段接管,
 * 新会话预算, admit, 冷却), 抽出来之后编排层只剩顺序.
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
 * @returns {any} 承接结果(见上)
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
      // 立即停止选号,把原因原样交给用户 ---- 出路是换代理,不是换号.
      // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
      if (err?.fatal === true) {
        return { stop: true, rec }
      }
  return NEXT
    }

    const reusable = rt.sessions.isUsableForModel(model)
    /**
     *  [上游有没有一条我能接管的已付费会话]----惰性查询(2026-10-04 铁律).
     *
     * 一次 admit 买断一小时,这一小时内继续发请求边际成本为 0;
     * 而 balance: 0 只说明"再买一条买不起",不代表已付费的会话不能用.
     * 所以额度闸门只该约束"新买一条",绝不能把一条已付过钱的会话挡在外面.
     *
     *  必须是惰性的(只在额度闸门即将拒绝时才查):
     * 首版把它放在热路径上无条件执行,结果每个请求都多发一次
     * GET /session,而且那个 GET 在官方建会话路径上会建出会话 ----
     * 凭空造出一条 model=A 的会话,紧接着请求模型 B 就撞
     * paid_window_model_mismatch(实测把既有测试打红).
     *
     * 清单可能过期(另一个部署刚买的),所以只有在本地上次快照没命中时
     * 才补一次只读探测;探测天然被"额度即将拒绝"这个罕见状态限制频率.
     */
    const checkPaidUpstream = makePaidUpstreamChecker(rt, key, model, emailByKey)
    /**
     * 额度闸门(units / freebucks / 新会话预算)只约束"新买一条".
     * 只有在真的要新买时才去问上游"有没有可接管的已付费会话"
     * (惰性 ---- 热路径与可用账号路径零开销),有则跳过闸门直接复用.
     */
    /**
     *  只在额度真的不够时才去问上游"有没有可接管的已付费会话".
     *
     * 不能写成 reusable || await checkPaidUpstream() ---- 那样对额度充足的
     * 普通请求也会多发一次 GET /session,而那个 GET 在官方建会话路径上会
     * 建出会话(mockMode='get_claim_admit' 的 GET 直接回 active),
     * 于是凭空多出一条会话去撞 paid_window_model_mismatch(实测把既有测试打红).
     *
     * 正确触发条件:本账号买不起(两道额度闸门任一命中).那时才值得多一次
     * 只读探测 ---- 因为它可能揭示"钱虽花完,但那一小时还在".
     *
     * 整个闸门必须包在 !reusable 里(2026-10-05 回归,实测打红 smoke:5669):
     * 活跃的同模型热 session 在 admit 时就已经预扣了整小时,复用它不再产生
     * 费用 ---- 拦下来等于把已经付过的钱丢掉,再去别的号上买一条新的,
     * 粘性调度(drain, not rotate)因此彻底失效.
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
