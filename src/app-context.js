import path from 'node:path'
import fs from 'node:fs'
import {
  resolveCredentialsDir,
  listAccounts,
  readAccountUser,
  accountKeyOf,
  accountCredentialsPath,
  freebuffAuthHeaders,
} from './auth-store.js'
import { createUpstreamClient } from './upstream/client.js'
import { SessionManager } from './session-manager.js'
import { SessionHandleStore } from './session-handles.js'
import { AccountStateStore } from './account-state-store.js'
import { UpstreamError, isSessionRecoverableGate } from './upstream/client.js'
import { freebuffLegacyModelDigest } from './upstream/catalog-protocol.js'
import { FREEBUFF_AVAILABLE_MODELS } from './model.js'
import { logger, runWithLogContext } from './util/log.js'
import { list } from './context/ops/account-list.ts'
import { _tryAccountForModel } from './context/sched/account-try.ts'
import { throwAcquireFailure } from './context/sched/account-callers.ts'
import { get } from './context/ops/account-runtime.ts'
import {
  _accountConcurrency,
  _recordSuccess,
  _setLastSuccessKey,
  _withAcquireLock,
  acquireForModel,
  everUsed,
  reacquireAfterGate,
  schedulingMode,
} from './context/sched/account-schedule.ts'
import {
  _cooldownKey,
  clearCooldown,
  earliestCooldownMs,
  isCoolingDown,
  markCooldown,
} from './context/state/account-cooldown.ts'
import {
  RESERVE_TTL_MS,
  chatInFlight,
  chatLockFor,
  effectiveLoad,
  isChatBusy,
  reservedCount,
  reserveSlot,
} from './context/state/account-locks.ts'
import { CONTEXT_METHODS } from './context/methods.ts'
import {
  ACCOUNT_COOLDOWN_CODES,
  BANNED_COOLDOWN_MS,
  DAY_MS,
  DEFAULT_COOLDOWN_MS,
  PAID_WINDOW_BOUND_CODES,
  SLOT_BUSY_CODES,
  SWITCHABLE_CODES,
  UNAVAILABLE_COOLDOWN_CODES,
} from './context/state/codes.ts'
import { ChatMutex } from './context/state/chat-mutex.ts'
import {
  countReasons,
  sanitizeFailuresForClient,
  summarizeFreebucks,
} from './context/ops/round-handlers.ts'

/**
 * 评估单个候选账号, 产出排序用的计分对象.
 *
 * 从 candidateKeys 抽出(原方法 107 行). 为什么要抽: 这段是"一个账号此刻值
 * 不值得被选中"的完整判据(会话复用/额度两本账/并发负载/是否用过), 抽成纯函数
 * 之后 candidateKeys 只剩"遍历 + 排序", 两者可以分别阅读与测试.
 * @param {any} self 账号池(runtimes)
 * @param {string} key 候选账号 key
 * @param {string} model 请求模型
 * @param {number} rotation 该 key 在本轮遍历里的序号(平局打破)
 * @returns {any | null} 计分对象; 跳过(冷却/不在候选)时返回 null
 */
/**
 * 计算单个候选账号的调度指标(供排序用).
 *
 * 从 scoreCandidate 抽出. 这些指标回答"这个账号此刻值不值得被选中":
 * 会话复用(tier), 两本额度账(units / Freebucks), 并发负载, 是否用过.
 * @param {any} self 账号池(runtimes)
 * @param {string} key 候选账号 key
 * @param {string} model 请求模型
 * @returns {any} 指标对象
 */
function computeCandidateMetrics(self, key, model) {
const sessions = self.byKey.get(key)?.sessions
const usable = sessions?.isUsableForModel?.(model) === true
const snap = sessions?.getSnapshot?.()
const quota = snap?.quota?.byModel?.[model]
const exhausted =
  !usable &&
  quota &&
  Number.isFinite(quota.limit) &&
  quota.limit > 0 &&
  (Number(quota.recentCount) || 0) >= quota.limit
const live = sessions?.hasLiveSlot?.() === true
const sameModel = snap?.model === model
const chatLock = self.chatLocks.get(key)
// inFlight = 已拿到 chat 锁的真实在途;load 还要算上"刚被选中,正在拿锁"
// 的预留,否则 N 个并发请求会同时看到一个"空账号"而全部挤上去.
const inFlight = chatLock?.inFlight || 0
const load = inFlight + self.reservedCount(key)
const capacity = chatLock?.capacity || self._accountConcurrency()
// Freebucks 余额买不起该模型(balance < prices[model])→ 排到最后:
// 调度不会为了它白开一条计费 session(上游反正也会 429).
const fbInfo = sessions?.freebucksFor?.(model)
const unaffordable = fbInfo?.known && fbInfo.affordable === false ? 1 : 0
// session_units 用尽的账号也排到最后(两本账都扣,units 没了同样会被上游拒).
const unitsInfo = sessions?.sessionUnitsFor?.(model)
const unitsOut = unitsInfo?.known && unitsInfo.exhausted ? 1 : 0
const used = self.everUsed(key, sessions)
// tier 按"会话状态"分(与 used 无关):
//   0 = 同模型热 session(复用零成本)
//   1 = 冷账号(没有活跃会话)或同模型即将过期
//   2 = 活跃 session 绑在别的模型上(换模型要释放它)
// 先按 tier 排:冷账号优先于"杀掉另一个模型的热会话"----否则多模型
// 交替使用会在同一个账号上反复 release/admit(每次都是一条计费会话).
const otherModelLive = live && sameModel === false
const busyNearExpiry =
  live && sameModel && !usable && (sessions?.inFlightCount?.() || 0) > 0
const tier = usable ? 0 : otherModelLive || busyNearExpiry ? 2 : 1
if (process.env.FB_DEBUG_SCHED) {
  console.error(
    `[sched]   ${key} tier=${tier} used=${used} usable=${usable} inFlight=${inFlight}/${capacity}`,
  )
}
  return {
    usable,
    exhausted,
    live,
    sameModel,
    inFlight,
    load,
    capacity,
    unaffordable,
    unitsOut,
    used,
    otherModelLive,
    busyNearExpiry,
  }
}

function scoreCandidate(self, key, model, rotation) {
  const m = computeCandidateMetrics(self, key, model)
  const {
    usable,
    exhausted,
    live,
    sameModel,
    inFlight,
    load,
    capacity,
    unaffordable,
    unitsOut,
    used,
    otherModelLive,
    busyNearExpiry,
  } = m
  const tier = usable ? 0 : otherModelLive || busyNearExpiry ? 2 : 1
  if (process.env.FB_DEBUG_SCHED) {
    console.error(
      `[sched]   ${key} tier=${tier} used=${used} usable=${usable} inFlight=${inFlight}/${capacity}`,
    )
  }
  return {
    key,
    tier,
    used: used ? 0 : 1,
    busy: load >= capacity ? 1 : 0,
    lastUsedAt: self._lastUsedAt.get(key) || 0,
    load,
    exhausted: exhausted ? 1 : 0,
    unaffordable,
    unitsOut,
    rotation,
  }
}

/**
 * 全部账号都在冷却时的失败明细(供 "Tried N" 报错使用).
 *
 * 从 _acquireForModelUnlocked 抽出. 为什么要它: 没有可用候选时若只报
 * "Tried 0", 用户看不出每个号冷却到几点、因为什么; 带上明细后这句话才自解释.
 * @param {any} self 账号池(runtimes)
 * @param {string[]} keys 全部账号 key
 * @param {string} model 请求模型
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @param {Array<any>} failures 失败明细(原地追加)
 * @returns {void}
 */
function collectCooldownFailures(self, keys, model, emailByKey, failures) {
    // 全部账号都在冷却/无可用账号时,把冷却明细带进报错(而不是 "Tried 0"),
    // 让用户一眼看出每个账号冷却到几点,因为什么.
  for (const key of keys) {
    if (self.isCoolingDown(key, model)) {
      const cd =
        self.cooldowns.get(key) || self.cooldowns.get(self._cooldownKey(key, model))
      failures.push({
        key,
        email: emailByKey.get(key),
        code: cd?.code || 'cooldown',
        message: `cooling down until ${cd ? new Date(cd.until).toISOString() : '?'}`,
      })
    }
  }
}
/**
 * Multi-account pool. 账号以[account key]标识:
 * key = Freebuff 用户 id(优先),无 id(历史数据)回落邮箱.
 * GitHub / Google 登录同一邮箱但 id 不同 → 两个独立账号,互不覆盖.
 */

export function maskEmail(email) {
  const str = typeof email === 'string' ? email : ''
  const at = str.lastIndexOf('@')
  if (at <= 0 || at === str.length - 1) return ''
  const local = str.slice(0, at)
  const domain = str.slice(at + 1).toLowerCase()
  const runes = [...local]
  if (runes.length === 0) return '*@' + domain
  if (runes.length === 1) return '*@' + domain
  if (runes.length === 2) return runes[0] + '*@' + domain
  return runes[0] + '***' + runes[runes.length - 1] + '@' + domain
}

export class AccountRuntimes {
  /**
   * @param {import('./config.js').ProxyConfig} config
   * @param {{ getAccountConcurrency?: () => number, getSchedulingMode?: () => 'sticky' | 'spread', getSessionSettings?: () => { idleReleaseSec?: number, maxNewSessionsPerRequest?: number } | null, getCustomModels?: () => { id: string, pool?: string, agentId?: string, fallbackAgentId?: string, displayName?: string, multimodal?: boolean, note?: string }[] }} [opts]
   *   getAccountConcurrency: 每个账号的并发上限来源(控制台设置/配置),
   *   默认取 config.limits.accountMaxConcurrency.
   *   getSchedulingMode: 账号调度模式来源(控制台设置),默认 'sticky'.
   *   sticky = 并发上限是溢出阈值(满员先排队);spread = 并发优先(满员即换号).
   *   getCustomModels: 前端[模型管理]的自定义模型列表(覆盖内置目录),
   *   影响 agent id 解析.
   */
  constructor(config, opts = {}) {
    this.config = config
    this.dir = resolveCredentialsDir(config)
    // 上游会话句柄的持久化索引(/data/sessions.json):admit/释放都落盘, 进程退出/换容器后仍能凭 instanceId 去 DELETE 释放槽位;释放失败的句柄也 留
    this.handleStore = new SessionHandleStore(resolveSessionIndexPath(config))
    // 账号运行状态的持久化账本(/data/account-state.json):加入/封禁时间, 请求数,最近使用,冷却,Freebucks 余额与单价,每日额度,最近探测结果. 这些原本只在
    this.accountState = new AccountStateStore(resolveAccountStatePath(config))
    this._getAccountConcurrency =
      typeof opts.getAccountConcurrency === 'function'
        ? opts.getAccountConcurrency
        : () => this.config.limits.accountMaxConcurrency || 1
    // 账号调度模式来源(控制台[账号调度]实时生效):'sticky'(默认)| 'spread'. sticky = 并发上限是溢出阈值:满员先在原账号有界排队,超时才换号; spread =
    this._getSchedulingMode =
      typeof opts.getSchedulingMode === 'function'
        ? opts.getSchedulingMode
        : () => 'sticky'
    this._getCustomModels =
      typeof opts.getCustomModels === 'function'
        ? opts.getCustomModels
        : () => []
    // 前端[额度保护]设置来源(settings.json,实时生效): idleReleaseSec / maxNewSessionsPerRequest.缺省回落 config.yaml.
    this._getSessionSettings =
      typeof opts.getSessionSettings === 'function'
        ? opts.getSessionSettings
        : () => null
    /** @type {Map<string, { key: string, email: string, id: string | null, authToken: string, user: any, upstream: any, sessions: SessionManager, source: string }>} */
    this.byKey = new Map()
    // Cooldown key: account key  (whole account) or key\0model (per-model). @type {Map<string, { unti
    this.cooldowns = new Map()
    this._rr = 0
    /** Serialize account selection + session admission on cold start. */
    this._acquireMutex = Promise.resolve()
    /** 账号级 chat 串行化锁(key → ChatMutex),跨 runtime 重建保持同一账号互斥. */
    this.chatLocks = new Map()
    this._lastSuccessKey = null
    /** Per-account success counters (in-memory, for load-balance visibility). */
    this.stats = { total: 0, byKey: new Map() }
    // 每个账号最近一次被选中/成功的时间戳(粘性调度的核心输入): 优先继续用刚用过的账号,而不是轮换到下一个健康账号. @type {Map<string, number>}
    this._lastUsedAt = new Map()
    // [已选中,但还没拿到 chat 锁]的预留数(key → 计数).  为什么必须有它:选号(candidateKeys)发生在拿 chat 锁之前,此刻 chatLock.inFlight
    this._reserved = new Map()
    // 预留的兜底释放定时器:请求中途异常退出(选号后未走完 chat 流程)也不该 把账号永久标记为"满".超时自动归还,绝不会泄漏成"账号永远满员". @type {Map<string, No
    this._reserveTimers = new Map()
    // 必须在所有上述容器(cooldowns/stats/_lastUsedAt)初始化之后回灌,
    // 否则账本里存着的计数/冷却没有地方放(早先放在构造函数开头,smoke 直接
    // 以 "Cannot read properties of undefined" 抓到).
    this._restoreAccountState()
  }

                                                  /**
   * 选号排序(2026-09 Freebucks 改版 + 参考项目 ADR-0012 反封控契约):
   *
   * 粘性优先 / drain, not rotate----把请求集中到尽可能少的账号上,用尽
   * (限流 / 额度耗尽 / 冷却 / 满员排队超时)才换下一个;从未用过的账号
   * 排最后,只有已用账号都不可用时才启用.上游把"轮换健康账号"直接当作
   * 账号农场特征(ADR-0012: cycling healthy keys looks like account farming),
   * 而 Freebucks 按会话占用时长计费,换号 = 新买一条计费行.
   *
   * 排序维度(从前到后):
   *   1. tier(会话状态):同模型热 session(复用零成本)> 冷账号 > 活跃 session
   *      绑在别的模型上(换模型要释放它).冷账号优先于"杀掉另一个模型的热会话",
   *      否则多模型交替会在同一账号上反复 release/admit(每次都买一条计费会话);
   *   2. used:同一 tier 内已用过的账号 > 从未用过的账号(不轻易碰新账号);
   *   3. busy:优先有空闲槽位的.满员账号不再一律排最后----它只要属于已用账号,
   *      仍排在"从未用过的账号"之前,新请求会在它上面做一次有界排队(省一条计费
   *      会话),超时后由 proxy.js 加进 skipKeys 才真正溢出;
   *   4. lastUsedAt 倒序(粘性:优先继续用刚用过的那个);
   *   5. 在途少 > 额度耗尽 > 余额不足 > 轮询(平局打破).
   * @param {string} model
   * @param {{ skipKeys?: Set<string> }} [opts] skipKeys:本次请求已经排队超时过的
   *   账号,不再重复选中(否则会一直排在第一位反复等).
   */
  candidateKeys(model, opts = {}) {
    const keys = this.allKeys()
    if (!keys.length) return []
    const skip = opts.skipKeys instanceof Set ? opts.skipKeys : null
    const start = this._rr % keys.length
    const candidates = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length]
      if (skip?.has(key)) continue
      if (this.isCoolingDown(key, model)) continue
      const scored = scoreCandidate(this, key, model, i)
      if (scored) candidates.push(scored)
    }
    // ── 调度模式(控制台[账号调度],默认 sticky)────────────────────
    // sticky(drain, not rotate):并发上限是溢出阈值----满员先原账号排队,
    //   超时才换号;"从未用过的账号"排最后.最少换号 = 最少新建计费会话.
    // spread(并发优先):有空闲槽位的账号提到最前,满员立即溢出;
    //   只有所有账号都满员时才排队.这样"设了并发 2 却只开 1 个号"不再发生.
    //
    //  spread 下 busy 必须排在 used 之前:否则"已用但满员"的账号会一直
    // 压住"空闲但从没用过"的账号,新号永远等不到----那正是用户抱怨的现象.
    // spread 仍然保留 tier 优先(同模型热 session 复用零成本),只是把
    // "有空闲槽位的冷账号"提前到"满员的已用账号"之前.
    const spread = this.schedulingMode() === 'spread'
    if (process.env.FB_DEBUG_SCHED) {
      console.error("[sched] mode=" + (spread ? "spread" : "sticky"))
    }
    candidates.sort(
      (a, b) =>
        // 1) 首要维度:sticky 看能不能复用,spread 看有没有空位.
        //    spread 下 busy 必须排第一:否则[带着热 session 但已满员]的账号
        //    会一直压住[空闲的冷账号],新号永远轮不到----那正是用户抱怨的
        //    [设了并发 2 却只开一个号].热 session 复用的省钱收益在 spread
        //    模式下主动让位给并发(这正是用户切这个模式的目的).
        (spread ? a.busy - b.busy || a.tier - b.tier : a.tier - b.tier) ||
        // 2) 同一梯队里:已用过的账号 > 从未用过的账号(不轻易碰新账号)
        a.used - b.used ||
        // 3) sticky:优先有空闲槽位,其次粘性(最近用过的优先);
        //    spread:随后按在途数平摊(同 busy 档内继续摊薄)
        (spread ? 0 : a.busy - b.busy) ||
        (spread ? a.load - b.load : b.lastUsedAt - a.lastUsedAt) ||
        a.load - b.load ||
        a.exhausted - b.exhausted ||
        // 余额买不起 / 时长额度用尽的账号排最后(复用它的热 session 仍优先----不计费)
        a.unaffordable - b.unaffordable ||
        a.unitsOut - b.unitsOut ||
        a.rotation - b.rotation,
    )
    if (process.env.FB_DEBUG_SCHED) {
      console.error(
        `[sched] model=${model} order: ${candidates.map((c) => `${c.key}#${c.tier}`).join(',')}`,
      )
    }
    return candidates.map((item) => item.key)
  }

      async _acquireForModelUnlocked(model, opts = {}) {
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

    const order = this.candidateKeys(model, { skipKeys: opts.skipKeys })
    /** @type {Array<{ key: string, email?: string, code?: string, message: string }>} */
    const failures = []
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

    // 全部账号都是"余额买不起"时给出独立错误码:这跟"账号都在冷却/没号"
    // 是完全不同的处境(前者等每日池刷新就好,后者要加号/等冷却),调用方与
    // 控制台不该看到同一个笼统的 no_available_account.
    // 两本账任一耗尽都算"额度用尽"(与分开的闸门一一对应):
    //   freebucks_exhausted = 货币预算不够(上游真正的拒付判据)
    //   units_exhausted     = 时长预算用尽
    // 出口级故障(地理封锁):它是出口属性不是账号属性,换号无意义.
    // 必须原样抛出(带 countryCode),让用户知道该换代理而不是去查账号.
    // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
    if (fatalFailure) {
      throw new UpstreamError(
        'Upstream blocked this egress: ' + fatalFailure.message,
        {
          status: 403,
          code: fatalFailure.code,
          // 出口级故障:原因要让用户看懂(该换代理而非换号),但仍不给
          // 账号标识 ---- 它是出口的属性,与具体哪个账号无关.
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

    async _reacquireAfterGateUnlocked(model, opts = {}) {
    if (opts.preferredKey) {
      if (
        opts.switchAccount ||
        (opts.gateCode && SWITCHABLE_CODES.has(opts.gateCode))
      ) {
    // 槽位占用类不冷却:它不是账号故障,只是"槽位正在被用", 等它空出即可.冷却会把可用账号钉死(实测:干净账号仅因上一次会话 未释放就拿到 purchase_claim_released,随即被冷却 → 立刻不可用). 与
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
    // noCooldown 且 switchAccount(free_mode_capacity_deferred / account_busy / runtime_superseded):不是真故障. 分两种情况: 1) a
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
    // 账号已不可用（凭据变更等）→ 走全新选号
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
   * 从 _reacquireAfterGateUnlocked 抽出. 关键约束: 会新买一条计费会话的路径
   * (forceReadmit)必须先过两本额度账; 428 必须排在两道闸门之前 -- 续用不花钱,
   * 用"买不起"把它拦下等于把刚付过款的那一小时白扔掉.
   * @param {string} model 请求模型
   * @param {any} opts 换号/重试选项
   * @returns {Promise<any | null>} 承接的 runtime; null = 该走全新选号
   */
  async _retrySameAccount(model, opts) {
    try {
      const rt = this.get(opts.preferredKey)
// 非 session-gate 的失败(5xx / 网络抖动 / 上游瞬时故障)在同一账号上 重试:会话还能用就直接复用----绝不为了重试再买一条计费 session.
      if (
        (!opts.gateCode || !isSessionRecoverableGate(opts.gateCode)) &&
        rt.sessions.isUsableForModel(model)
      ) {
        this.clearCooldown(opts.preferredKey, model)
        this._setLastSuccessKey(opts.preferredKey)
        return rt
      }
// 同账号 gate 重试时,调用方(chat 流程)已持有该账号的串行化锁, 不会与另一个在途 chat 冲突,可直接 forceReadmit.  但 forceReadmit 会新买一条计费会话(先 DELETE 再
// 428 必须排在两道额度闸门之前(2026-10-05 真实事故修正,二次修复).  这道判断原本写在两个闸门之后,与它自己的注释("必须在 freebucks 闸门之前判断 428")自相矛盾 --
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
// 428 已在上方先行处理(续用不花钱,必须先于额度闸门). 走到这里的是其它需换号的 gate:forceReadmit 先 DELETE 再 admit, 会新买一条计费会话 ---- 两道闸门刚已确认买得起,这一步才
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
    }
  
  }


                /**
   * 扫尾:把上次进程遗留 / 本次释放失败的会话句柄逐个 DELETE 拿退款.
   * 失败的保留在 sessions.json 里等下次机会----绝不静默丢弃.
   *
   *  必须周期性调用,不能只在启动时调一次. 上游对"提前结束"的会话会回
   * freebucksRefundPending: true(结算未完成,"拿同一个 instanceId 再来取").
   * 官方客户端在 pending 期间每 3 秒无限重放直到拿到终态;而本服务原先只在
   * 启动时扫一次,进程不重启就再也没人去取这些结算----这正是"退款总额永远是 0"
   * 最可疑的工程原因(不是上游不退,是我们问得太早且没再问).
   * @param {{budgetMs?: number}} [opts] 本次扫尾的总预算(启动路径必须传,
   *   否则一个连不通的上游能把启动卡住).
   * @returns {Promise<{cleaned: number, failed: number, skipped: number, deferred: number}>}
   */
  async cleanupOrphanSessions(opts = {}) {
    const resolve = (key) => {
      try {
        return this.get(key)?.upstream || null
      } catch {
        return null
      }
    }
    return this.handleStore.cleanupOrphans(resolve, opts)
  }

  /**
   * 扫尾:把上次进程遗留 / 本次释放失败的会话句柄逐个 DELETE 取回执.
   * 失败的保留在 sessions.json 里等下次机会----绝不静默丢弃.
   *
   *  必须周期性调用,不能只在启动时调一次. 上游对"提前结束"的会话会回
   * freebucksRefundPending: true----它的语义是"最终用量还没算完,用同一个 instance
   * 再问一次回执",不是"不退"(这层误解曾让我们得出错误结论并发版,见
   * docs/account-scheduling-and-refund.md §3 的纠错).官方客户端在 pending 期间
   * 每 3 秒重放直到拿到终态;只在启动时扫一次 = 进程不重启就再也没人问过,
   * 那笔已经预扣的 Freebucks 会一直挂在 pending 里.
   * @param {{budgetMs?: number}} [opts] 本次扫尾的总预算(启动路径必须传,
   *   否则一个连不通的上游能把启动卡住).
   * @returns {Promise<{cleaned: number, failed: number, skipped: number, deferred: number}>}
   */
  async cleanupOrphanSessions(opts = {}) {
    const resolve = (key) => {
      try {
        return this.get(key)?.upstream || null
      } catch {
        return null
      }
    }
    return this.handleStore.cleanupOrphans(resolve, opts)
  }

                  }

/**
 * 会话句柄索引(sessions.json)落盘位置.
 *
 * 必须和凭据目录放一起:同一个 dataDir 可能被两个服务共用(本仓库的
 * data/ 与上层 rotator 的 ../data/),句柄索引跟着凭据走才不会各自
 * 持有一份互相看不见的孤儿;也保证"删容器不丢数据"的 /data 约定成立.
 * @param {import('./config.js').ProxyConfig} config
 */
function resolveSessionIndexPath(config) {
  return path.join(accountStateDir(config), 'sessions.json')
}

/**
 * 账号状态账本(account-state.json)落盘位置----与 sessions.json / 凭据同目录,
 * 同样是"删容器不丢数据"的 /data 约定.
 * @param {import('./config.js').ProxyConfig} config
 */
function resolveAccountStatePath(config) {
  return path.join(accountStateDir(config), 'account-state.json')
}

/** 凭据目录的父目录(= /data);凭据目录本身不叫 credentials 时就用它自己. */
function accountStateDir(config) {
  const credDir = resolveCredentialsDir(config)
  const parent = path.dirname(credDir)
  return path.basename(credDir) === 'credentials' ? parent : credDir
}

// 方法实现分散在 src/context/**, 这里挂回原型(装配表见 src/context/methods.ts).
Object.assign(AccountRuntimes.prototype, CONTEXT_METHODS)

/** 预留的兜底存活时长: 足够走完"选号 -> 拿 chat 锁", 又不会让泄漏永久化. */
Object.defineProperty(AccountRuntimes, 'RESERVE_TTL_MS', {
  get: () => RESERVE_TTL_MS,
})

/**
 * @param {import('./config.js').ProxyConfig} config
 * @param {{ getAccountConcurrency?: () => number, getSchedulingMode?: () => 'sticky' | 'spread', getSessionSettings?: () => any, getCustomModels?: () => { id: string, pool?: string, agentId?: string, fallbackAgentId?: string, displayName?: string, multimodal?: boolean, note?: string }[] }} [opts] 透传给 AccountRuntimes
 */
export function buildAppContext(config, opts = {}) {
  const runtimes = new AccountRuntimes(config, opts)
  const keys = runtimes.allKeys()
  if (!keys.length) {
    // Zero-account startup is allowed: the web console can add Freebuff
    // accounts later. Runtime endpoints report 401 until one exists.
    return {
      config,
      dir: runtimes.dir,
      runtimes,
      authToken: null,
      authSource: null,
      authEmail: null,
      authKey: null,
      upstream: null,
      sessions: null,
    }
  }
  const current = runtimes.getAny()
  return {
    config,
    dir: runtimes.dir,
    runtimes,
    // Convenience mirrors of getAny() for CLI status/doctor
    authToken: current.authToken,
    authSource: current.source,
    authEmail: current.email,
    authKey: current.key,
    upstream: current.upstream,
    sessions: current.sessions,
  }
}

export { freebuffAuthHeaders }
