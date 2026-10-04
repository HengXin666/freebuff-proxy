import { logger, runWithLogContext } from './util/log.js'
import { UpstreamError, isTerminalCountryBlock } from './upstream/client.js'
import { newCliClaimId, newRawInstanceId } from './upstream/official-fingerprint.js'
import { isFreeModel } from './model.js'

/** 账号级故障状态码(回执反映账号处境,不反映某条会话的生死). */
const ACCOUNT_LEVEL_SESSION_STATUSES = new Set([
  'banned',
  'country_blocked',
  'rate_limited',
  'spend_limited',
  'ip_capped',
  'free_mode_rate_limited',
])

/** 待结算退款的重试间隔:上游算完最终用量才会给回执,30s 足够且不扰上游. */
const REFUND_RETRY_INTERVAL_MS = 30_000
/** 待结算退款的追问窗口上限(毫秒).超窗后句柄仍留在 sessions.json,交给下次启动扫尾. */
const REFUND_RETRY_MAX_MS = 60 * 60 * 1000

/**
 * Manages a single Freebuff free-session slot for this proxy process.
 * Model is always taken from the downstream request — never a proxy default.
 */
export class SessionManager {
  /**
   * @param {object} opts
   * @param {ReturnType<import('./upstream/client.js').createUpstreamClient>} opts.upstream
   * @param {import('./config.js').ProxyConfig} opts.config
   * @param {string} [opts.accountKey] 账号标识(sessions.json 持久化的 owner key)
   * @param {(entry: {key: string, instanceId: string, model: string, admittedAt?: string | null, expiresAt?: string|null}) => void} [opts.onSessionChange]
   *   会话句柄变化通知(admit/释放)——由上层落盘到 /data/sessions.json,
   *   保证进程退出/换容器后仍能寻址并 DELETE 掉活着的会话.
   */
  constructor({
    upstream,
    config,
    getSessionSettings,
    hasPendingUser,
    accountKey = null,
    logContext = null,
    onSessionChange = null,
    onStateChange = null,
    /**
     *  模型标识归一函数(必须解构,否则静默失效).
     *
     * 上层(app-context.js)创建本类时一直在传这个函数,但早期版本的
     * 解构列表里漏了它 —— JS 解构不会因为"多传了参数"报错,
     * 于是 this.resolveModelAlias 恒为 undefined,holderFor() /
     * freebucksFor() 的归一静默退化成严格相等.
     *
     * 后果(正是要修的那个 bug 的复现条件):上游会话清单用上游 id
     * (deepseek/deepseek-v4-flash),而调度内部用目录 key
     * (m-096e75164d)—— 两侧标识不同 → 永远匹配不上 →
     * 面板能显示那条已付费会话,调度却看不见它 → 白花钱重买.
     *
     * 而使用同形态标识的既有用例全绿,把这个缺陷掩盖了(实测:
     * 构造时传 v => 'K:'+v,sm.resolveModelAlias 仍是 undefined).
     */
    resolveModelAlias = null,
  }) {
    this.upstream = upstream
    this.config = config
    /** 模型标识归一(目录 key / 上游 id / 可读名 → 目录 key);见上方说明. */
    this.resolveModelAlias = resolveModelAlias
    /**
     * 会话实例 id:裸 UUID,整个进程生命周期内复用同一个.
     *
     * 抓包复核(docs/reverse/15-protocol-review.md P0-2):官方是裸 UUID
     * 且整场复用 —— line 8/34/54 三次 admission 同为
     * e1be7199-331e-4622-b5a9-0a2cfe8aecc1,line 38 的 metadata 也是它.
     * 我们此前用 cli:<uuid> 且每次 admit 新建,review 指出这可能就是
     * [购买被全额退款作废]的直接诱因:官方回执里 desktopRefunds 从未出现,
     * 而我们每次都退(见 docs/reverse/12 §12.2[诱因尚未确定]).
     *
     * cli-bridge 改成裸 UUID 复用后实测:admission 200 且未产生退款条目.
     */
    this.instanceId = newRawInstanceId()
    /**
     * 上游的会话清单快照(每次 _apply 从回执刷新):
     * 谁占着哪个模型的槽位,何时到期.见 _apply 里的说明.
     * @type {Array<{model?: string, expiresAt?: string, holderInstanceId?: string}>}
     */
    this.desktopPurchases = []
    /** 上游的活跃会话计数(premium / unlimited / nextExpiryAt). */
    this.desktopSessionCounts = null
    /** 上游的退款记录(对账用). */
    this.desktopRefunds = []
    /** 账号标识(sessions.json 里的 owner key). */
    this.accountKey = accountKey
    /**
     * 日志上下文(account/key)——本 Manager 产生的每条日志都自动带上.
     *
     * 为什么需要:logger 的 account 字段此前只在 chat 路径(proxy.js
     * patchLogContext)被写上,探测/刷新/选号/空闲释放这些路径全是空的.
     * 于是控制台[日志]页的账号筛选对这些日志永远筛不出东西 —— 而排障
     * 恰恰最需要它们(一次 admit 失败,一次风控拒绝都是这条路径产生的).
     * 上层创建 runtime 时把邮箱传进来,这里包住所有入口方法.
     */
    this._logContext =
      logContext && typeof logContext === 'object' ? logContext : null
    /** 句柄变更回调(落盘 /data/sessions.json). */
    this._onSessionChange =
      typeof onSessionChange === 'function' ? onSessionChange : null
    /**
     * [账号账目变了]回调(freebucks / quota / lastProbe)——由上层落盘到
     * /data/account-state.json.这些数字原先是纯内存的:重启后余额归零会让
     * "买不起就别 admit" 的闸门失忆,于是重启后的第一个请求就会去撞一个
     * 已知余额不足的账号(正是要避免的封禁触发条件).
     */
    this._onStateChange =
      typeof onStateChange === 'function' ? onStateChange : null
    /**
     * [有人正排队要用这个账号]的判定(账号级 chat 锁在途/排队).
     * 空闲释放要跳过这种情况:选号阶段就 admit,随后在等 chat 锁的请求还没
     * 走到 beginRequest(在途计数仍为 0),若此刻把会话删掉,请求会撞上
     * 已失效会话,白白多买一条计费会话.
     */
    this._hasPendingUser =
      typeof hasPendingUser === 'function' ? hasPendingUser : () => false
    /**
     * 控制台[额度保护]设置(settings.json)实时覆盖 config.yaml:
     * idleReleaseSec(空闲自动释放秒数).返回 null 时用 config 默认值.
     */
    this._getSessionSettings =
      typeof getSessionSettings === 'function' ? getSessionSettings : () => null
    /** @type {null | {
     *   status: string,
     *   instanceId?: string,
     *   model?: string,
     *   admittedAt?: string,
     *   expiresAt?: string,
     *   remainingMs?: number,
     *   accessTier?: string,
     *   raw?: any
     * }} */
    this.session = null
    /**
     * Cached per-model daily quota from the last admit/refresh that included
     * rateLimit / rateLimitsByModel. Survives session release so the console
     * can keep showing 已用/上限 until the next admit refreshes it.
     * @type {null | { byModel: Record<string, any>, rateLimit: any, updatedAt: string }}
     */
    this.quota = null
    this._mutex = Promise.resolve()
    this._pollTimer = null
    /** 当前正在处理中的请求数(在途 chat 时跳过轮询 GET,避免干扰活跃会话). */
    this._inFlight = 0
    /**
     * 最近一次探测(refresh GET)的结果:成功/失败 + 具体原因.
     * 供控制台展示"为什么这个账号刷新失败"(country_blocked / rate_limited /
     * invalid key...),而不是笼统的"冷却中".成功时 ok=true.
     * @type {null | { ok: boolean, at: string, code?: string | null, status?: number | null, message?: string } }
     */
    this.lastProbe = null
    /** 等待在途请求归零的监听器(会话平滑切换/优雅释放时用). */
    this._idleWaiters = []
    /**
     * Freebucks 计量块(上游每次 session 响应都带):余额 / 每日池 / 每模型
     * session 单价.用于[余额买不起就别 admit]以及控制台展示.
     * @type {null | {
     *   balance: number,
     *   daily: { limit: number, spent: number, remaining: number, resetAt: string | null },
     *   wallet: { balance: number, monthlyBonus: number, nextBonusAt: string | null },
     *   prices: Record<string, number>,
     *   quotaExempt: boolean,
     *   planId: string | null,
     *   monthly: { remainingUsd: number, resetAt: string | null } | null,
     *   updatedAt: string
     * }}
     */
    this.freebucks = null
    /** 最近一次早退 DELETE 的回执(控制台展示/排查用). */
    this.lastRefund = null
    /**
     * 待结算退款(上游回 freebucksRefundPending 时的 instanceId).
     *
     * 这是钱:pending = "最终用量还没算完,用同一个 instance 再问一次回执",
     * 不是"不退".句柄一旦丢弃,这笔已经预扣的 Freebucks 就永远取不回来.所以
     * 只要还挂起就必须留着它,由 _refundRetryTimer 持续重试,直到拿到终态回执
     * (含 0——0 也是终态,那时才允许收工).
     * @type {string | null}
     */
    this._pendingRefundInstanceId = null
    /** 待结算退款的追问定时器. */
    this._refundRetryTimer = null
    /** 本轮追问窗口的起点(用于 REFUND_RETRY_MAX_MS 封顶). */
    this._refundRetryStartedAt = null
    /** 空闲自动释放定时器(在途归零后开始计时). */
    this._idleTimer = null
    /** 正在早退 DELETE(空闲释放/换号释放):期间不得被选号复用. */
    this._releasing = false
    /**
     * 成功新建的上游会话计数(每次 POST /session 成功 +1).
     * 下游请求的[新会话预算]据此扣减:被上游拒绝的 admit(rate_limited 等)
     * 不消耗额度,只有真正扣了 Freebucks 的会话才算.
     */
    this.admitCount = 0
    /**
     * 复用热 session 的次数(每次请求命中"已有可用会话,无需 admit"时 +1).
     *
     * 与 admitCount 配对,用来在控制台上直接证明我们在省钱:复用不产生任何
     * 上游扣费(一次 admit = 买断一小时,时段内复用边际成本为 0),所以
     * reuseCount / (reuseCount + admitCount) 就是这段时间里省掉的重买次数.
     *
     * 只统计请求侧的复用(ensureSession 走热路径),不含后台轮询.
     */
    this.reuseCount = 0
    /**
     * 释放失败待重试:DELETE 失败时绝不能丢弃 instanceId——丢了这条会话
     * 就永远删不掉(连 session_units 也退不回来),只能白占一个上游会话槽位.
     * true = session 里仍留着 instanceId,等待下一次释放机会重试.
     */
    this._releasePending = false
    /** 释放重试定时器. */
    this._releaseRetryTimer = null
    /** 已连续重试次数(成功后清零). */
    this._releaseRetries = 0
    /**
     * 本账号本轮连续调度的开始时刻(第一条在途请求开始时写入,归零时清空).
     * 与 scheduledMs(累计调度时长,跨轮累加)一起落盘,控制台即可显示
     * "累计调度 3h20m / 本轮运行 12m".
     *
     * 为什么必须落盘:这是"这个号到底被用了多久"的唯一口径——账号池里
     * 哪些号在干活,哪些号从没被启用过,光看 requests(次数)是看不出来的
     * (长对话 1 次 = 几十分钟,短批量 300 次可能只有几分钟).
     * @type {number | null} epoch ms
     */
    this._schedulingSince = null
  }

  /** 请求开始(在途计数 +1,轮询跳过,取消空闲释放计时). */
  beginRequest() {
    this._inFlight += 1
    // 本轮调度起算点:只在 0 → 1 时写,同一轮内的并发请求共享同一个起点.
    if (this._inFlight === 1) {
      this._schedulingSince = Date.now()
      this._notifyScheduleChange()
    }
    this._clearIdleRelease()
  }

  /** 请求结束(在途计数 -1),归零时唤醒等待方并开始空闲释放计时. */
  endRequest() {
    const before = this._inFlight
    this._inFlight = Math.max(0, this._inFlight - 1)
    if (before > 0 && this._inFlight === 0) {
      // 本轮调度结束:把时长结算掉(跨轮累加),并清空起算点.
      this._settleScheduling()
      const waiters = this._idleWaiters
      this._idleWaiters = []
      for (const wake of waiters) wake()
      this._armIdleRelease()
    }
  }

  /**
   * 本轮调度时长(毫秒).有在途请求时 = now - 起算点;否则 0.
   * 控制台用它显示"本轮已运行 ..."(实时增长).
   */
  currentSchedulingMs() {
    if (this._inFlight <= 0 || this._schedulingSince == null) return 0
    return Math.max(0, Date.now() - this._schedulingSince)
  }

  /** 结算本轮调度:上报时长给上层累加落盘,然后清空起算点. */
  _settleScheduling() {
    const since = this._schedulingSince
    if (since == null) return
    const ms = Math.max(0, Date.now() - since)
    this._schedulingSince = null
    if (ms > 0) this._emitScheduling(ms)
    else this._notifyScheduleChange()
  }

  /**
   * 上报一次"本轮调度结束"(时长毫秒).上层按账号累加进账本
   * (AccountStateStore),去抖落盘,不阻塞转发.
   */
  _emitScheduling(ms) {
    if (this._onStateChange) {
      try {
        this._onStateChange({ schedulingMs: ms })
      } catch (err) {
        logger.warn('scheduling report callback failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * 上报"本账号本轮调度正在运行"(起算点变化 / 本轮结束).
   * 只用于把 schedulingSince 持久化,好让控制台在重启后仍能区分
   * "这个号刚才还在干活"和"从来没动过".
   */
  _notifyScheduleChange() {
    if (!this._onStateChange) return
    try {
      this._onStateChange({
        schedulingSince: this._schedulingSince
          ? new Date(this._schedulingSince).toISOString()
          : null,
      })
    } catch {
      // 可观测性失败不影响转发
    }
  }

  /** 空闲自动释放时长(毫秒,0 = 关闭).控制台设置优先于 config.yaml. */
  idleReleaseMs() {
    const override = this._getSessionSettings?.()?.idleReleaseSec
    const sec = Number.isFinite(override)
      ? override
      : this.config.session.idleReleaseSec
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0
  }

  /**
   * session_units 闸门(与 Freebucks 并行的第二道,见
   * .agents/notes/implemented/architecture/2026-09-14-two-ledgers-parallel-gates.md).
   *
   * 上游一笔会话同时扣两本账:units(rateLimitsByModel[model].recentCount,小数)
   * 与 Freebucks.实测 deepseek-v4-flash 在 units 0.1/6 完全没超标时仍被
   * rate_limited(理由 freebucksShortfall),所以 Freebucks 那道不能删;
   * 但 units 用尽同样会被上游拒,不拦就等于白跑一次 admit 再换回冷却.
   *
   * 返回 {known, used, limit, remaining, exhausted, pool, poolLabel, resetAt}.
   * fail-open:无该模型行 / limit<=0 / 非有限数 → known:false(不拦截),
   * 这样老上游与没有 rateLimitsByModel 的账号行为不变.
   * @param {string} model
   */
  sessionUnitsFor(model) {
    const row = this.quota?.byModel?.[model]
    if (!row || typeof row !== 'object') {
      return { known: false, used: null, limit: null, remaining: null, exhausted: false }
    }
    const limit = Number(row.limit)
    const used = Number(row.recentCount)
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) {
      return { known: false, used: null, limit: null, remaining: null, exhausted: false }
    }
    const remaining = Math.max(0, limit - used)
    return {
      known: true,
      used,
      limit,
      remaining,
      exhausted: remaining <= 0,
      pool: row.period || row.pool || null,
      poolLabel: row.poolLabel || null,
      resetAt: row.resetAt || null,
    }
  }

  /**
   * 距离本会话[已付费时段]结束还有多少毫秒;无法判定时返回 null.
   *
   * 上游一次 admit 就是买断一小时(一手实测 2026-09-14):POST 当场扣满
   * 整小时单价(Freebucks 5 → 0),回执带 admittedAt / expiresAt.因此在这
   * 一小时之内,继续发请求的边际成本是 0;而 DELETE 之后那一小时就作废,
   * 重开 = 重新买一整小时.
   *
   * expiresAt 优先;上游只回 remainingMs 时用它兜底(admit 时的快照).
   * @param {{expiresAt?: string|null, remainingMs?: number|null, status?: string, admittedAt?: string|null}} [session]
   */
  paidWindowRemainingMs(session = this.session) {
    if (!session) return null
    // grace(ended 但仍持 instanceId):上游允许把在途做完,不再续期.
    if (session.status === 'ended') return 0
    const exp = session.expiresAt != null ? Date.parse(session.expiresAt) : NaN
    if (Number.isFinite(exp)) return exp - Date.now()
    const rem = Number(session.remainingMs)
    if (Number.isFinite(rem)) {
      // remainingMs 是 admit 时的快照,按 admit 时刻折算成"现在还剩多少".
      const admitted = session.admittedAt != null ? Date.parse(session.admittedAt) : NaN
      if (Number.isFinite(admitted)) return admitted + rem - Date.now()
      return rem
    }
    return null
  }

  /** 本会话是否仍在已付费时段内(判不出来时返回 false = 不拦). */
  inPaidWindow(session = this.session) {
    const left = this.paidWindowRemainingMs(session)
    return left != null && left > 0
  }

  /**
   * 空闲自动释放:在途归零后空闲超过 session.idleReleaseSec 就早退 DELETE.
   *
   *  已付费时段内不释放(2026-09-14 一手实测后改).
   *
   * 上游一次 admit 就是买断一小时:POST 当场扣满整小时单价,回执带
   * expiresAt.实测(账号 lolid8faw4er,模型 solar-pro4,该模型无 units 行
   * → 纯 Freebucks 计费):
   *
   *     admit      rem 5 → 0      (当场扣满)
   *     25s 后 DELETE → {status:"ended", freebucksRefundPending:true}
   *     +20/+40/+60/+120s          rem 仍为 0,未到账
   *     重放 DELETE ×2             仍然只有 pending,无金额
   *
   * 而 session_units 那本账早退是当场按比例退的(实测 1.1 → 0.2).
   * 关键是不对称:实测 24 个[账号 × 模型]组合,22 个是 Freebucks 先见底
   * (Freebucks 才是上游真正的拒付判据 freebucksShortfall).所以早退等于
   * 拿稀缺的账去省不稀缺的账——已付费的这一小时内继续用,边际成本为 0.
   *
   * 因此:付费时段内不因空闲而释放(见
   * .agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md,
   * docs/freebucks-strategy.html).
   * 腾槽位给别的模型由上层显式 release 负责,不走这条空闲路径.
   * idleReleaseSec 仍然有效:它是付费时段结束之后的空闲释放时长.
   */
  _armIdleRelease() {
    const ms = this.idleReleaseMs()
    // 仍在已付费时段内:闲置不花钱,释放才是浪费(那一小时已买断).
    const left = this.paidWindowRemainingMs()
    const inPaid = left != null && left > 0
    if (!ms || !this.hasLiveSlot() || inPaid) {
      this._clearIdleRelease()
      return
    }
    // 已有计时就不重置:后台轮询(GET /session)每 pollIntervalSec 一次,
    // 若每次都顺延,空闲释放永远触发不了.
    if (this._idleTimer) return
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null
      if (this._inFlight > 0 || !this.hasLiveSlot()) return
      if (this._hasPendingUser()) {
        // 有请求正排队等这条会话:别删,等它用完后重新计时.
        this._armIdleRelease()
        return
      }
      logger.info('releasing idle freebuff session (paid window over; frees the account slot)', {
        instanceId: this.session?.instanceId,
        model: this.session?.model,
        idleSec: Math.round(ms / 1000),
      })
      this.release().catch((err) => {
        logger.warn('idle session release failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, ms)
    if (this._idleTimer.unref) this._idleTimer.unref()
  }

  _clearIdleRelease() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
  }

  /**
   * 该模型在这个账号上的 Freebucks 账目:
   *   { known, price, balance, affordable, quotaExempt, resetAt, reason }
   * known=false 表示还没有拿到过 freebucks 块(老上游/尚未探测)——此时不拦截.
   * 无 price 的模型 = 不计费(unmetered),永远可买.
   *
   * 上游的封号判定有两条(issue #11 实测):
   *   ① Freebucks 跑完了(今日池 daily.remaining <= 0);
   *   ② 本次请求所需 Freebucks 高于剩余余额(balance < prices[model]).
   * 命中任一条就可能直接封号,所以 affordable === false 必须同时覆盖两者
   * ——只判 ② 会漏掉"池子跑完但 balance 还留着数字"的账号,照样送上去撞封禁.
   * reason 标明是哪一条命中,便于日志与前端解释(不再只报"余额不够").
   * @param {string} model
   */
  freebucksFor(model) {
    const fb = this.freebucks
    if (!fb) return { known: false, price: null, balance: null, affordable: true }
    // 每日池重置时刻已过 → 本地数字自认过期(太平洋午夜刷新),不再据此
    // 拦截选号:让一次真实 admit 用上游的最新余额重新校准,而不是拿冻结的
    // 旧数字把账号一直排除在外.
    const resetAt = fb.daily?.resetAt ? Date.parse(fb.daily.resetAt) : NaN
    if (Number.isFinite(resetAt) && resetAt <= Date.now()) {
      return {
        known: false,
        price: null,
        balance: fb.balance,
        affordable: true,
        stale: true,
      }
    }
    /**
     *  价格表查找必须走模型标识归一(2026-10-04 实测缺陷).
     *
     * 上游价格表(freebucks.prices)的键是上游模型 id
     * (deepseek/deepseek-v4-flash),而调度传进来的 model 通常是
     * 目录 key(m-096e75164d)—— 直接用 fb.prices[model] 查不到,
     * 于是 price 为 null → 走进上面的 unmetered 分支恒放行,
     * 额度闸门形同虚设(实测:测试用例里 freebucksFor 判 known:false
     * 导致闸门不拦,用例失去意义).
     *
     * 用注入的 resolveModelAlias(同一唯一真源)把两侧都归一到目录 key 再比.
     */
    const normModel = (v) =>
      typeof this.resolveModelAlias === 'function' ? this.resolveModelAlias(v) : v
    const wantModel = normModel(model)
    let price = null
    {
      const prices = fb.prices || {}
      // ① 先按原样查(快路径:键已是同形态时零开销)
      if (typeof prices[model] === 'number') price = prices[model]
      else {
        // ② 逐键归一再比(价格表很小,逐键成本可忽略)
        for (const [k, v] of Object.entries(prices)) {
          if (typeof v !== 'number') continue
          if (normModel(k) === wantModel) {
            price = v
            break
          }
        }
      }
    }
    if (price == null) {
      return {
        known: true,
        price: null,
        balance: fb.balance,
        affordable: true,
        unmetered: true,
        resetAt: fb.daily?.resetAt || null,
      }
    }
    /**
     *  免费模型(price === 0)不受任何 Freebucks 闸门约束.
     *
     * 实测(2026-10-04 用户指出):上游价格表里有 price: 0 的免费模型
     * (upstage/solar-mini4,stealth/space-bunny-alpha).既然它不花钱,
     * 余额/每日池耗尽就与它无关 —— 用"没钱"去拒绝一个免费模型是纯粹的自伤:
     * 用户明明能用,却被我们自己的闸门挡住.
     *
     * 旧行为:两道闸门(dailyExhausted / shortOnBalance)对 price: 0 一样生效
     * —— Number(fb.balance) < 0 为 false 尚可,但 dailyRemaining <= 0 会把
     * 账号直接判死,免费模型一并被排除(用户原话:"免费的给它排除了,
     * 我都不知道怎么想的").
     *
     *  注意判据是 price === 0(不是"price 缺失"):
     * 缺失(price == null)在上面的 unmetered 分支已放行并明确标注,
     * 那是"上游没给价"的未知态;这里是"上游明确标价 0"的已知免费态.
     */
    const isFreeModel = price === 0
    const monthlySpent =
      !isFreeModel && fb.monthly != null && Number(fb.monthly.remainingUsd) <= 0
    // 条件①:今日池跑完(limit > 0 才算真的有池子,避免把 limit=0 的
    // "没有池子" 误判成"池子跑完").resetAt 已过在上面就 return 了,所以这里
    // 的 remaining 一定是未重置周期的数字.quotaExempt 账号不受任何池限制.
    const dailyLimit = Number(fb.daily?.limit)
    const dailyRemaining = Number(fb.daily?.remaining)
    const dailyExhausted =
      !isFreeModel &&
      Number.isFinite(dailyLimit) &&
      dailyLimit > 0 &&
      Number.isFinite(dailyRemaining) &&
      dailyRemaining <= 0
    // 条件②:余额买不起本次请求(免费模型恒买得起 —— 它不花钱)
    const shortOnBalance = !isFreeModel && Number(fb.balance) < price
    const exempt = fb.quotaExempt === true
    const affordable =
      exempt || (!dailyExhausted && !shortOnBalance && !monthlySpent)
    /** 命中哪一条(用于日志/前端解释;affordable=true 时为 null). */
    const reason = affordable
      ? null
      : dailyExhausted
        ? "daily_exhausted"
        : monthlySpent
          ? "monthly_exhausted"
          : "balance_shortfall"
    return {
      known: true,
      price,
      balance: fb.balance,
      affordable,
      unmetered: false,
      quotaExempt: exempt,
      dailyExhausted,
      dailyRemaining: Number.isFinite(dailyRemaining) ? dailyRemaining : null,
      dailyLimit: Number.isFinite(dailyLimit) ? dailyLimit : null,
      reason,
      resetAt: fb.daily?.resetAt || null,
    }
  }

  /** 当前在途请求数(监控/优雅释放用). */
  inFlightCount() {
    return this._inFlight
  }

  /**
   * 等待在途请求全部结束.默认不限时:每个在途 SSE 流都受自身 idle 超时
   * 约束(幽灵连接会在 streamIdleTimeoutSec 后被掐断并释放锁),健康的长流
   * 会正常结束——切换连接时绝不能掐断健康流,所以无限等待是安全的.
   * @param {number} [timeoutMs] >0 时强制设上限,超时直接返回(由调用方兜底)
   */
  async _waitForIdle(timeoutMs = 0) {
    if (this._inFlight <= 0) return
    await new Promise((resolve) => {
      const wake = () => {
        if (timer) clearTimeout(timer)
        resolve()
      }
      let timer = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const i = this._idleWaiters.indexOf(wake)
          if (i >= 0) this._idleWaiters.splice(i, 1)
          resolve()
        }, timeoutMs)
        if (timer.unref) timer.unref()
      }
      this._idleWaiters.push(wake)
    })
  }

  /** Serialize admit/release operations. */
  async withLock(fn) {
    let release
    const wait = new Promise((resolve) => {
      release = resolve
    })
    const prev = this._mutex
    this._mutex = prev.then(() => wait)
    await prev
    try {
      // 锁内的整段执行都带上本账号的日志上下文(refresh / admit / release /
      // 退款追问全走这里)——没有它,探测与释放产生的日志在控制台上
      // 就是几十条无主记录,按账号筛选筛不出任何东西.
      return this._logContext
        ? await runWithLogContext(this._logContext, fn)
        : await fn()
    } finally {
      release()
    }
  }

  getSnapshot() {
    const s = this.session
    // admit/reuse 计数:让控制台能显示"这个号买了几条,复用了几次"——
    // 复用是零成本的(买断的一小时内),这个比例直接就是省下的重买次数.
    const counts = {
      admitCount: this.admitCount,
      reuseCount: this.reuseCount,
    }
    /**
     * 上游的会话清单一并带进快照 —— 前端据此显示"这一小时买给了谁,
     * 什么时候到期",从而分布式部署下能看到对方建的会话(用户诉求).
     * 见 _absorbInventory 与 holderFor.
     */
    const inventory = {
      purchases: this.desktopPurchases || [],
      sessionCounts: this.desktopSessionCounts || null,
    }
    if (!s) {
      return {
        status: 'none',
        quota: this.quota,
        freebucks: this.freebucks,
        lastRefund: this.lastRefund,
        lastProbe: this.lastProbe,
        inventory,
        ...counts,
      }
    }
    const remainingMs =
      s.expiresAt != null
        ? Math.max(0, Date.parse(s.expiresAt) - Date.now())
        : s.remainingMs
    return {
      ...s,
      remainingMs,
      live: this.hasLiveSlot(s),
      quota: this.quota,
      freebucks: this.freebucks,
      lastRefund: this.lastRefund,
      lastProbe: this.lastProbe,
      inventory,
      ...counts,
    }
  }

  hasLiveSlot(session = this.session) {
    if (!session) return false
    if (session.status === 'active' && session.instanceId) return true
    // grace window: ended but instance still present
    if (session.status === 'ended' && session.instanceId) return true
    return false
  }

  /**
   * 会话剩余时间低于该阈值(秒)后不再承接新请求,提前 re-admit 换新会话,
   * 避免请求发到马上过期的会话上,中途卡住(切换流量更平滑).
   *
   * 按模型计费方式分层:
   * - 免费模型(daily/referral/limited_offer/helper):剩余不足
   *   session.free_model_re_admit_lead_sec(默认 300s = 5 分钟)即不再调度——
   *   会话按整小时计价,过期中途被掐断会让响应截断,提前换最平滑(未用时长会退还);
   * - 付费模型(premium):每次 admit 都是计费会话,尽量用到接近过期
   *   (沿用 session.re_admit_lead_sec,默认 60s),避免频繁新建付费会话.
   * @param {string} model
   */
  reAdmitLeadMs(model) {
    const sec = this.config.session.reAdmitLeadSec
    const base = (Number.isFinite(sec) && sec > 0 ? sec : 60) * 1000
    if (isFreeModel(model)) {
      const freeSec = this.config.session.freeModelReAdmitLeadSec
      const freeBase =
        (Number.isFinite(freeSec) && freeSec > 0 ? freeSec : 300) * 1000
      return Math.max(base, freeBase)
    }
    return base
  }

  /**
   * 会话切换等待在途请求的上界(毫秒):约等于"持锁者最坏存活时长"——响应头
   * 等待(与 body idle 同量级)+ body idle 一个周期 + 余量.超过该值视为账号
   * 卡死(网络波动叠加),放弃本账号让上层冷却/换号,绝不无限等待.
   */
  switchWaitMs() {
    const idleSec = this.config.limits.streamIdleTimeoutSec
    const idleMs = (Number.isFinite(idleSec) && idleSec > 0 ? idleSec : 120) * 1000
    return 2 * idleMs + 60_000
  }

  isUsableForModel(model, session = this.session) {
    // 正在早退释放(空闲/换号)的会话不再被选号复用,避免 DELETE 与 chat 抢同一条会话.
    if (this._releasing) return false
    if (!this.hasLiveSlot(session)) return false
    if (!session?.model || !session.instanceId) return false
    if (session.status === 'ended') {
      // grace: can finish in-flight, but proxy policy: allow continue until
      // instance disappears if reAdmit not needed mid-request
      return session.model === model
    }
    if (this.config.session.reAdmitOnExpire) {
      // expiresAt 优先;上游只回 remainingMs 时用它兜底(admit 时的快照).
      const left =
        session.expiresAt != null
          ? Date.parse(session.expiresAt) - Date.now()
          : typeof session.remainingMs === 'number'
            ? session.remainingMs
            : null
      // 已过期 / 剩余时间不足 lead → 新请求需要 re-admit(提前平滑切换)
      if (left != null && left <= this.reAdmitLeadMs(model)) return false
    }
    return session.status === 'active' && session.model === model
  }

  /**
   * Ensure an active free session bound to model.
   * @param {string} model upstream freebuff model id
   */
  async ensureSession(model) {
    if (!model) {
      throw new UpstreamError('model is required to admit a freebuff session', {
        status: 400,
        code: 'model_required',
      })
    }
    return this.withLock(async () => {
      if (this.isUsableForModel(model)) {
        // 热路径:这条会话的整小时已经买过了,复用它不产生任何新扣费.
        this.reuseCount += 1
        return this.session
      }

      // 平滑切换的竞态保护:live 会话可能正被在途 SSE 流使用(例如热会话
      // 排队等待 chat 锁期间,另一个请求先走到这里).此时若直接释放再
      // re-admit,会把正在传输的 session 从上游删掉——上游连接还在但
      // session 已消失,用户端会永久卡住.先等在途请求全部结束(受 stream
      // idle 超时约束,幽灵连接也会被掐断),再释放重建.
      // 用循环而非单次等待:某次归零的瞬间可能有新请求刚拿到 chat 锁开始
      // 在途,需继续等它,直到观察到真正的空闲窗口.
      // 等待必须有上界:在途流若因网络波动长时间不结束(虽然最终会受
      // idle 超时约束结束),新请求不能无限干等——否则"一条链卡死 → 所有
      // 后续请求全部超时".超时放弃本账号,由上层冷却/换下一个账号.
      const switchDeadline = Date.now() + this.switchWaitMs()
      while (
        this.hasLiveSlot() &&
        !this.isUsableForModel(model) &&
        this._inFlight > 0
      ) {
        const left = switchDeadline - Date.now()
        if (left <= 0) {
          logger.warn('session switch timed out waiting for in-flight requests', {
            model,
            from: this.session?.model,
            to: model,
            inFlight: this._inFlight,
            waitMs: this.switchWaitMs(),
          })
          throw new UpstreamError(
            'session switch timed out: in-flight requests did not finish in time',
            { status: 429, code: 'account_busy' },
          )
        }
        logger.info('waiting for in-flight requests before session switch', {
          model,
          from: this.session?.model,
          to: model,
          inFlight: this._inFlight,
        })
        await this._waitForIdle(Math.min(left, 2_000))
      }
      // 等待期间可能已被其他路径重建/续期,重新检查(同样是复用已有会话)
      if (this.isUsableForModel(model)) {
        this.reuseCount += 1
        return this.session
      }

      /**
       * 持有的 slot 已不可用(模型不符 / 已过期 / 即将过期):先释放再 admit.
       *
       *  仍在已付费时段内时绝不释放(issue #24).
       *
       * 这段原本无条件释放,而 _armIdleRelease 的注释基于 24 组实测得出
       * 完全相反的结论——那两条结论打架了很久,直到 #24 在真实部署上复现:
       *
       *     18:41:24  session active  expiresAt=19:41:19
       *     18:41:28  ← 请求成功
       *     18:41:36  releasing session before re-admit(切模型)
       *     18:41:36  DELETE /api/v1/freebuff/session
       *     18:41:38  slot busy; not cooling  code=purchase_claim_released
       *
       * 即:已买断的那一小时被主动扔掉,新模型又没拿到,账号进入最差状态.
       * 且实测 DELETE 之后接不回来(0s / 45s / 90s 三次重试,换回原模型或
       * 换另一个模型,全部 purchase_claim_released),直到 expiresAt 到期才恢复.
       *
       * 所以付费时段内换模型 = 纯亏损:已付的钱丢了,新会话拿不到,面板还显示
       * 账号正常.正确做法是不碰这条会话,把请求交给别的账号(本账号的那一
       * 小时继续服务它自己的模型).
       */
      if (this.hasLiveSlot() && !this.isUsableForModel(model)) {
        /**
         * 付费时段内的会话不是"不可用的 slot",是"正在生效的资产".
         * 抛 paid_window_model_mismatch:上层据此跳过本账号去选下一个,
         * 而不是冷却它(它是健康的,只是这一个小时内只能服务旧模型).
         */
        //  只拦[模型不符],不拦[即将过期需要续期]:后者是同一模型
        // 的 re-admit(近过期续期),会话本来就该换新的,不拦它否则会让
        // 到期前无法续期,请求撞上已失效会话.
        const modelMismatch = Boolean(
          this.session?.model && this.session.model !== model,
        )
        if (modelMismatch && this.inPaidWindow()) {
          const left = this.paidWindowRemainingMs()
          logger.warn('model switch inside paid window; keeping the paid session', {
            from: this.session?.model,
            to: model,
            instanceId: this.session?.instanceId,
            expiresAt: this.session?.expiresAt,
            paidWindowLeftMin: left != null ? Math.round(left / 60000) : null,
          })
          throw new UpstreamError(
            'account holds a paid session bound to another model; ' +
              'keeping it (switching inside the paid window voids the hour)',
            {
              status: 409,
              code: 'paid_window_model_mismatch',
              body: {
                boundModel: this.session?.model ?? null,
                instanceId: this.session?.instanceId ?? null,
                expiresAt: this.session?.expiresAt ?? null,
                paidWindowRemainingMs: left,
              },
            },
          )
        }
        logger.info('releasing session before re-admit', {
          model,
          status: this.session?.status,
          from: this.session?.model,
          to: model,
        })
        await this._releaseUnlocked()
      }

      // 冷路径:本地已知"没有活跃会话",直接 admit.
      //
      // 这里原本还要先 GET 一次("in case another path left a row").但上游
      // 同一个账号同一时间只能有一个客户端在线:本进程的会话状态由
      // session-manager 单点持有(admit/释放/轮询都经 withLock 串行化),
      // refresh() 与本方法同用一把锁,不存在"别人偷偷建了会话而我不知道".
      // 那次 GET 只在本进程之外有人用同一个号时才有意义,代价却是每条
      // 冷请求都多一个完整 RTT(实测 +580ms 首字节,见
      // test/repro-firstbyte.mjs).真正的兜底已经在上游:模型不符时 admit 会
      // 返回 model_locked,_admitUnlocked 内部会释放并重试一次.
      //
      // 换模型时仍需先释放旧会话(上游一次只服务一个模型),这段逻辑保留在
      // 上面的分支里.此前此处还重复了一次 _releaseUnlocked():上面已经释放过,
      // 这里 hasLiveSlot() 恒为 false,属于死代码.它不会多释放一次(条件恒假),
      // 但同一个动作写两遍,且第二遍不带任何守卫,后面若有人给上面那处加守卫,
      // 这里会静默绕过——所以删掉,只保留带上下文的那一处.

      return this._admitUnlocked(model)
    })
  }

  async _admitUnlocked(model, { forceReleaseLocked = false } = {}) {
    if (forceReleaseLocked) {
      await this._releaseUnlocked()
    }

    /**
     *  admission 前先把"待结束的会话"结清(官方行为,2026-10-04 逆向后补).
     *
     * 官方 orchestrator.js:208130-208136:
     *
     *   for (let end of journal.pending(owner)) {
     *     if (end.instanceId !== instanceId) continue;
     *     if ((await recovery.finish(end, auth, {...})).status === "ended") continue;
     *     throw localSessionError("previous_end_unconfirmed");
     *   }
     *
     * 即:同一条 instanceId 上有未结清的会话时,先把它结束掉再 admission.
     * 否则上游会认为该账号的槽位仍被占(purchase_capacity)—— 而本地账本
     * 却显示 status: none(因为 _apply 早把它覆盖成 none 了),
     * 面板与上游各说各话,正是用户看到的"明明没会话却说槽位被占".
     *
     * 实测(2026-10-04 远程 12:52:18):账号直连上游 status: none,
     * balance 15,但远程 admission 一直 purchase_capacity.
     *
     * 只在确实处于待结束状态时做(_releasePending),正常路径零开销.
     */
    if (this._releasePending && this.session?.instanceId) {
      const stale = this.session.instanceId
      logger.info('admit: clearing a pending session end first', {
        model,
        staleInstanceId: stale,
      })
      await this.upstream
        .freebuffSession('DELETE', { instanceId: stale })
        .catch((err) => {
          logger.warn('admit: pending-end DELETE failed; continuing', {
            staleInstanceId: stale,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      this._releasePending = false
    }

    // 官方 CLI 自己生成 claim(cli:<uuid>)并带给服务端,而不是等服务端
    // 签发一个裸 uuid —— 服务端据此认出这是 CLI 的 claim
    // ("The server reads it to tell the CLI's claims from Desktop tabs").
    //
    //  2026-10-01 真机抓包修正:官方 CLI(0.2.6)从不打 /admission,
    // 全程 18 次 GET /api/v1/freebuff/session(带 cli: claim +
    // x-freebuff-multi-session: 1)+ 1 次 DELETE .../session/attempt.
    // 而 GET 建会话不带 x-freebuff-model —— 模型由服务端在回执里给出
    // (不透明句柄,如 m-00032eaeec).
    // 我们此前一直 POST /admission:那是官方不走的端点,被 503/409 拒.
    // 见 .agents/notes/implemented/bug-fix/2026-10-01-cli-get-session-path.md
    // 裸 UUID + 复用(官方形态,见构造函数注释)
    const claimId = this.instanceId
    logger.info('admitting freebuff session', { model, claimId })
    // 先走官方路径(GET + claim);失败且是"端点/方法不认"类错误时再回落 POST.
    let body = null
    try {
      body = await this.upstream.freebuffSession('GET', { instanceId: claimId })
      /**
       *  GET 回执也要吸清单(不只在拿到 active 时).
       *
       * status: none 的回执同样带 desktopPurchases / desktopSessionCounts
       * —— 而"谁占着槽位"恰恰只在没有自己会话时才重要(有自己会话就直接复用了).
       * 此前只在 _apply(仅 active 路径)里解析,于是 holderFor() 永远读不到,
       * "发请求前先接管"这条路等于没接上(测试抓到了).
       */
      this._absorbInventory(body)
    } catch (err) {
      logger.warn('GET-claim admit failed; falling back to POST admission', {
        code: err?.code,
        status: err?.status,
        //  没有这两个字段时(网络层异常)必须留 message,否则日志里
        // 只剩一句"失败"而看不出原因(实测排障时就卡在这里).
        message: err instanceof Error ? err.message : String(err),
        cause: err?.cause ? String(err.cause).slice(0, 200) : undefined,
        claimId,
      })
      body = null
    }
    // GET 没给出可用会话:再 GET 一次(带 model 作为 hint).
    //
    // 官方行为(真机抓包):全程 18 次 GET,零次 POST,会话最终变成 active.
    // 说明 GET 本身就是建会话路径,服务端会在某次 GET 上置为 active.
    // 此前我们 status:none 就立刻回落 POST admission —— 而那是服务端会拒的
    // 路径(实测 country_not_allowed),等于主动把自己送进死路.
    if (!body || body.status === 'none') {
      // 官方建会话路径(真机抓包 2026-10-01,从零开始):
      //   GET /session ×3(轮询,返回 none)
      //   → POST /session/admission(带 fbm1. 句柄的 x-freebuff-model)
      //   → 200 active
      // 所以我们此前 POST admission 的方向是对的,错的是 model 传了名字
      // 而不是句柄(已在 client.js 里修正).这里直接走 POST.
      /**
       *  已知占用者时首次 POST 就带 takeover(官方 knownHolder 的用法).
       *
       * 官方在发请求之前就从 desktopPurchases 读出持有者,直接带
       * x-freebuff-takeover-instance-id 接管;而不是先撞一次
       * purchase_capacity 再从错误回执里捡 id.
       *
       * 好处:少一次必然失败的请求;且跨部署可见 —— 上游回执会列出
       * 全部持有者(含别的部署建的会话),所以本地/远程之间不再互相"看不见".
       */
      const knownHolder = this.holderFor(model)
      logger.info('GET returned none; POSTing admission with claim', {
        model,
        claimId,
        knownHolder: knownHolder || null,
      })
      try {
        body = await this.upstream.freebuffSession('POST', {
          model,
          instanceId: claimId,
          // 只在与自己不同时才接管(自己占着就正常 admission)
          ...(knownHolder && knownHolder !== claimId
            ? { takeoverInstanceId: knownHolder }
            : {}),
        })
      } catch (err) {
        logger.warn('POST admission failed', {
          code: err?.code,
          status: err?.status,
          claimId,
        })
      }
    }
    // 仍拿不到:最后再试一次 POST(等价重复,作为老部署兜底).
    //
    // 说明:真机抓包确认官方建会话只走一次 POST /session/admission;
    // 上面的 POST 失败后这里不会再成功,但保留一层兜底不影响保真度
    // (与官方 session_admission_unavailable 的容错语义一致).
    if (!body || body.status === 'none') {
      logger.warn('admission produced no session; retrying POST once', {
        model,
        claimId,
      })
      body = await this.upstream.freebuffSession('POST', {
        model,
        instanceId: claimId,
      })
    }

    //  2026-10-01 真机抓包修正:status: 'active' 必须优先.
    //
    // 官方 CLI 在完全相同的出口(countryCode: JP,
    // countryBlockReason: 'country_not_allowed',verificationReason:
    // 'region_locked')下,服务端返回的是 status: "active" ——
    // 会话照常建立,照常可用:
    //
    //   {"status":"active","accessTier":"limited","instanceId":"cli:...",
    //    "model":"m-00032eaeec","countryCode":"JP",
    //    "countryBlockReason":"country_not_allowed",
    //    "verificationReason":"region_locked"}
    //
    // 也就是说 countryBlockReason 是说明性字段(告诉客户端为什么模型集
    // 变小了),而不是拒绝信号.此前我们把它当拒绝信号 → 明明拿到了可用
    // 会话却主动抛错,把可用账号判死.
    //
    // 只有没有 instanceId 的 terminal 封锁才该抛(那才是真拒绝).
    // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
    if (
      body?.status !== 'active' &&
      body?.countryBlockReason &&
      isTerminalCountryBlock(body.countryBlockReason) &&
      body.instanceId
    ) {
      this.admitCount += 1
      this._apply({ ...body, status: 'active' })
      this._armPoll()
      logger.warn('admitted but egress country blocked; keeping paid session', {
        model: body.model,
        instanceId: body.instanceId,
        expiresAt: body.expiresAt,
        countryCode: body.countryCode ?? null,
        reason: body.countryBlockReason,
      })
      throw this._terminalSessionError(body, model)
    }

    if (body?.status === 'active' && body.instanceId) {
      this.admitCount += 1
      this._apply(body)
      this._armPoll()
      logger.info('freebuff session active', {
        model: body.model,
        instanceId: body.instanceId,
        expiresAt: body.expiresAt,
        accessTier: body.accessTier,
      })
      /**
       *  立刻发一次持有心跳(官方行为,2026-10-04 逆向后补).
       *
       * 官方 syncHeartbeatTimer 在有会话时立即执行一次 heartbeat(),
       * 之后每 45 秒一次(orchestrator.js:208905-208957;常量
       * FREEBUFF_SESSION_HEARTBEAT_INTERVAL_MS = 45000).
       * 形态:GET /session + x-freebuff-instance-id + x-freebuff-heartbeat: 1.
       *
       * 抓包实证:admission(line 8)→ 首个心跳(line 17)间隔 20.5 秒.
       * 而真实事故里我们在 admission 后 25 秒就被退款 —— 时间尺度吻合,
       * 这是"上游认为这条会话无人持有"的最强候选.
       *
       * fire-and-forget:心跳失败不能影响 admit 的返回值(会话已经拿到手了),
       * 失败只记日志.绝不 await 阻塞主流程.
       */
      this._sendHoldHeartbeat(body.instanceId)
      return this.session
    }

    if (body?.status === 'model_locked') {
      // End current and re-claim requested model
      logger.info('model_locked; releasing and re-admitting', {
        currentModel: body.currentModel,
        requestedModel: body.requestedModel || model,
      })
      await this._releaseUnlocked()
      const again = await this.upstream.freebuffSession('POST', { model })
      if (again?.status === 'active' && again.instanceId) {
        this.admitCount += 1
        this._apply(again)
        this._armPoll()
        return this.session
      }
      throw this._terminalSessionError(again, model)
    }

    /**
     *  槽位被占时用 x-freebuff-takeover-instance-id 接管重试(官方行为).
     *
     * 官方 orchestrator.js:208152-208155:
     *
     *   if (response = await post(named),
     *       options.takeover &&
     *       (response.status === "premium_slot_taken" ||
     *        response.status === "purchase_in_use" ||
     *        response.status === "purchase_capacity") &&
     *       response.currentInstanceId &&
     *       response.currentInstanceId !== instanceId)
     *     response = await post(response.currentInstanceId);   // ← 带占用者 id 重发
     *
     * 即:上游回执会告诉我们谁占着槽位(currentInstanceId),
     * 官方据此显式"接管"(带 x-freebuff-takeover-instance-id 重发一次).
     *
     * 我们此前完全没有这一步 —— takeover 逻辑只存在于 cli-bridge 的
     * admit(),而主服务的 admission 走的是另一条路(Node/freebuffSession),
     * 从不带该头.后果(实测 2026-10-04):账号直连上游 status: none,
     * balance 15,但每个请求都回 purchase_capacity(回执
     * currentInstanceId=3fb8894c-... 指向另一个 instance),
     * 用户看到[明明有额度却永远说槽位被占].
     *
     * 只重试一次(与官方一致),避免与占用者互相抢夺.
     */
    if (
      body &&
      (body.status === 'purchase_capacity' ||
        body.status === 'purchase_in_use' ||
        body.status === 'premium_slot_taken') &&
      typeof body.currentInstanceId === 'string' &&
      body.currentInstanceId &&
      body.currentInstanceId !== claimId
    ) {
      logger.warn('session slot held by another instance; attempting takeover', {
        model,
        holderInstanceId: body.currentInstanceId,
        ourInstanceId: claimId,
        slotStatus: body.status,
      })
      try {
        const took = await this.upstream.freebuffSession('POST', {
          model,
          instanceId: claimId,
          takeoverInstanceId: body.currentInstanceId,
        })
        if (took?.status === 'active' && took.instanceId) {
          this.admitCount += 1
          this._apply(took)
          this._armPoll()
          logger.info('took over the held slot', {
            model,
            instanceId: took.instanceId,
            expiresAt: took.expiresAt,
          })
          this._sendHoldHeartbeat(took.instanceId)
          return this.session
        }
        logger.warn('takeover did not produce an active session', {
          model,
          status: took?.status ?? null,
        })
        body = took || body
      } catch (err) {
        logger.warn('takeover attempt failed', {
          model,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    /**
     *  purchase_claim_released —— 必须换一个全新的 instanceId 再试一次.
     *
     * 这是官方客户端的确切行为(官方 desktop 0.0.158 解包 orchestrator.js:208166-208176):
     *
     *   if (response.status === "purchase_claim_released") {
     *     let cancelled = await recovery.finish(attempt, auth);   // 结束失败尝试
     *     if (cancelled.status !== "ended") throw localSessionError("release_unconfirmed");
     *   }
     *   if (response.status !== "purchase_claim_released" || rotated || !persistInstanceId)
     *     throw error;                                            // rotated = 只重试一次
     *   await releasePurchaseClaim({owner, instanceId, auth}, journal, host);  // DELETE 该 claim
     *   host.forget(instanceId);                                  // 忘掉旧 id
     *   instanceHint = crypto.randomUUID();                       //  换全新 UUID
     *   options.persistInstanceId(instanceHint);                  // 持久化新 id
     *   rotated = true;
     *
     * releasePurchaseClaim 的实现(同文件 208111)就是 deleteSession(instanceId) ——
     * 也就是说官方确实会 DELETE,但删的是"已被作废的那条 claim",删完立刻换新 id 重试.
     *
     * 我们此前把它归进 SLOT_BUSY_CODES 当"槽位忙,跳过",于是永远卡在同一个
     * 已作废的 instanceId 上:每个模型都返回同样的错,直到 expiresAt 到期才恢复
     * (实测日志 11:29:07 / 11:29:44 / 11:29:56 连续三个模型全部
     * purchase_claim_released,其中 m-22ff70c712 单价 0 也失败 —— 证明卡的不是钱,
     * 是那条 claim).
     *
     * 判据:本方法只重试一次(与官方 rotated 同语义),避免无限循环.
     */
    if (body?.status === 'purchase_claim_released') {
      const staleId = this.instanceId
      logger.warn('purchase_claim_released; rotating instance id and retrying once', {
        model,
        staleInstanceId: staleId,
      })
      // ① 删掉那条已被作废的 claim(官方 releasePurchaseClaim 同语义).
      //    这一步不会动到任何仍在生效的会话 —— 它本来就已经被上游作废了.
      await this.upstream
        .freebuffSession('DELETE', { instanceId: staleId })
        .catch(() => null)
      // ② 换一个全新 instanceId(官方 crypto.randomUUID 同语义)
      this.instanceId = newRawInstanceId()
      this.session = { status: 'none' }
      this._notifySessionChange()
      // ③ 用新 id 重新 admission(只这一次)
      const retry = await this.upstream
        .freebuffSession('POST', { model, instanceId: this.instanceId })
        .catch(() => null)
      if (retry?.status === 'active' && retry.instanceId) {
        this.admitCount += 1
        this._apply(retry)
        this._armPoll()
        logger.info('re-admitted after claim rotation', {
          model,
          instanceId: retry.instanceId,
          expiresAt: retry.expiresAt,
        })
        return this.session
      }
      logger.warn('claim rotation did not produce an active session', {
        model,
        status: retry?.status ?? null,
      })
      throw this._terminalSessionError(retry || body, model)
    }

    throw this._terminalSessionError(body, model)
  }

  _terminalSessionError(body, model) {
    const statusMap = {
      rate_limited: 429,
      spend_limited: 429,
      ip_capped: 429,
      country_blocked: 403,
      banned: 403,
      model_unavailable: 409,
      premium_slot_taken: 409,
      superseded: 409,
      none: 503,
    }
    const st = body?.status || 'admit_failed'
    return new UpstreamError(
      `freebuff session admit failed: ${st}` +
        (body?.message ? ` — ${body.message}` : ''),
      {
        status: statusMap[st] || 502,
        code: st,
        body: { ...body, requestedModel: model },
        retryAfterMs: body?.retryAfterMs,
        // 地理封锁是出口属性,不是账号属性:所有账号共享同一出口,
        // 换号只会把每个账号的额度依次买断(一次 admit = 一整小时 Freebucks)
        // 却永远拿不到答案.标记后调度层立即终止选号并把原因交给用户,
        // 出路是换代理(前端[代理设置]),不是换号.
        // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
        fatal: st === 'country_blocked',
      },
    )
  }

  _apply(body) {
    if (!body || typeof body !== 'object') {
      this.session = { status: 'none' }
      return
    }
    const prev = this.session
    // 旧的 handle 还没删掉(DELETE 一直失败)而现在要换成新会话:不能就这么
    // 覆盖丢掉 instanceId——把它作为[待清理]交给上层落盘持久化,之后仍会
    // 继续尝试 DELETE(否则它就成了无法寻址的孤儿,一直占着上游会话槽位).
    if (
      this._releasePending &&
      this.hasLiveSlot(prev) &&
      prev.instanceId !== body.instanceId
    ) {
      this._emitSessionEvent({
        type: 'orphan',
        key: this.accountKey,
        instanceId: prev.instanceId,
        model: prev.model ?? null,
        admittedAt: prev.admittedAt ?? null,
        expiresAt: prev.expiresAt ?? null,
      })
      this._releasePending = false
    }
    this.session = {
      status: body.status,
      instanceId: body.instanceId,
      model: body.model,
      admittedAt: body.admittedAt,
      expiresAt: body.expiresAt,
      remainingMs: body.remainingMs,
      accessTier: body.accessTier,
      raw: body,
    }
    const quota = extractQuota(body)
    if (quota) this.quota = quota
    const freebucks = extractFreebucks(body)
    if (freebucks) this.freebucks = freebucks
    /**
     *  解析上游的会话清单.
     *
     * 为什么这是必需的(2026-10-04,用户提议 + 官方源码 + 实测三重印证):
     * 上游一次 admit = 买断一小时,槽位 slotLimit: 1.谁占着槽位只在上游那里——
     * 本地账本(sessions.json)只记自己创建的会话,分布式部署下彼此看不见:
     * 我在本地建了一条会话,远程读不到 → 远程拿同一账号请求就撞
     * purchase_capacity,而本地面板显示 status: none,两边各说各话.
     *
     * 上游其实把答案直接给了我们(GET /session 回执,实测字段):
     *   "desktopSessionCounts": {"premium":1,"unlimited":0,
     *                            "nextExpiryAt":"2026-10-04T14:01:37.143Z"}
     *   "desktopPurchases": [{"model":"mimo/mimo-v2.5",
     *                         "expiresAt":"2026-10-04T13:31:37.143Z",
     *                         "holderInstanceId":"6c5b0c7e-..."}]
     *
     * 官方据此实现 knownHolder(model)(orchestrator.js:208639)——
     * 从回执里读出占用者 instanceId,然后带 x-freebuff-takeover-instance-id
     * 接管(208152-208155).我们此前完全没解析这几个字段,
     * 于是 takeover 只能靠"撞到 purchase_capacity 后从错误回执里捡",慢一拍.
     *
     * 现在解析并保留:holderFor(model) 可在发请求之前就知道谁占着槽位.
     */
    this._absorbInventory(body)
    if (quota || freebucks) this._notifyStateChange()
    // admit 可能发生在没有任何在途请求时(选号阶段就 admit,随后才拿 chat
    // 锁):这里兜底起空闲计时,否则会话会一直挂到过期.
    if (this._inFlight === 0) this._armIdleRelease()
    // 句柄落盘:进程退出/换容器后仍能凭 instanceId 去 DELETE 释放上游会话槽位.
    this._notifySessionChange()
  }

  /**
   * @param {{ heartbeat?: boolean }} [opts]
   *   heartbeat=true = 持有心跳形态(官方每 45s 一次的保活):
   *   GET /session + instance-id + x-freebuff-heartbeat: 1,不带时区.
   *   轮询用这个;控制台[检测/刷新]用默认(普通形态,能拿回额度/单价).
   *   见 orchestrator.js:207945-207957(两种形态的唯一差别就是那几个头).
   */
  async refresh(opts = {}) {
    return this.withLock(async () => {
      // 上游同一个号同一时间只能有一个客户端在线:轮询 GET 若撞上在途
      // chat 会干扰/顶掉活跃会话(428 waiting_room_required),因此跳过.
      if (this._inFlight > 0) return this.session
      //  2026-10-01 真机对比修正:官方 CLI 每个 GET 都带自生成的 cli claim
      // (含 x-freebuff-multi-session / -purchase-continuity / -heartbeat),
      // 即使当时没有活跃会话.我们此前只在"已有会话"时才带 instanceId,
      // 没有会话就裸发 —— 抓包对比一栏就看出少了整整 5 个头:
      //   x-freebuff-instance-id / -multi-session / -purchase-continuity /
      //   -heartbeat / -compact-session
      // 裸发的 GET 服务端只能按 legacy 处理,这是被拒的直接原因之一.
      // 见 .agents/notes/implemented/bug-fix/2026-10-01-cli-get-session-path.md
      const reqOpts = {
        // 裸 UUID(desktop 形态);没有会话时用本进程复用的那个
        instanceId: this.session?.instanceId || this.instanceId,
        compact: true,
        // 持有心跳形态(官方保活):轮询走它
        heartbeat: opts.heartbeat === true,
      }
      try {
        const body = await this.upstream.freebuffSession('GET', reqOpts)
        /**
         *  上游对账号级故障的 GET 回执也是 200 + {status:'banned'} 这种
         * 形态(见 upstream/client.js 里 403 的 country_blocked/banned 直通).
         * 以前这里无条件 this._apply(body),于是控制台点一次[刷新]就会:
         *   1) 把 session 覆盖成 {status:'banned', instanceId: undefined} ——
         *      活着的 instanceId 被抹掉,那条已付费一小时的会话从此无法寻址,
         *      既 DELETE 不掉(腾不出上游槽位)也追不回钱(退款的唯一凭据就是它);
         *   2) 记成 lastProbe.ok = true —— 探测明明失败了却显示成功;
         *   3) 把健康判定从"账号是否封禁"退化成"还有没有本地会话",
         *      没会话的正常账号反而被判成"未就绪".
         * 所以账号级错误回执只当探测结果:保留会话现场,不入 _apply,
         * 落 lastProbe 原因后抛出(调用方据此区分 ban / 风控 / IP 上限).
         */
        const accountLevel = accountLevelSessionStatus(body?.status)
        if (accountLevel) {
          const probe = {
            ok: false,
            code: accountLevel,
            status: null,
            message: body?.message || null,
          }
          this._setLastProbe(probe)
          this._clearPoll()
          throw new UpstreamError(
            `freebuff session probe: ${accountLevel}` +
              (body?.message ? ` — ${body.message}` : ''),
            { status: 403, code: accountLevel, body },
          )
        }
        this._apply(body)
        this._setLastProbe({ ok: true })
        if (this.hasLiveSlot()) this._armPoll()
        else this._clearPoll()
        return this.session
      } catch (err) {
        this._setLastProbe({
          ok: false,
          code: err?.code || (err instanceof Error ? err.name : null),
          status: err?.status ?? null,
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    })
  }

  _setLastProbe(patch) {
    const now = new Date().toISOString()
    if (patch.ok) {
      this.lastProbe = { ok: true, at: now, code: null, status: null, message: null }
    } else {
      this.lastProbe = {
        ok: false,
        at: now,
        code: patch.code ?? null,
        status: patch.status ?? null,
        message: patch.message ?? null,
      }
    }
    this._notifyStateChange()
  }

  /** 释放会话(早退 DELETE;Freebucks 侧只回 pending,实测未到账).返回 true = 上游已确认结束. */
  async release() {
    return this.withLock(() => this._releaseUnlocked())
  }

  /**
   * 优雅释放:先在途请求全部结束(受 idle 超时约束,不会永久阻塞),
   * 再释放 session.用于代理切换/账号重建——避免把正在传输的 SSE 掐断.
   */
  async releaseWhenIdle() {
    await this._waitForIdle()
    return this.withLock(() => this._releaseUnlocked())
  }

  /**
   * 释放会话(早退 DELETE:按实际占用时长退还 Freebucks 未用部分,见 §3).
   *
   * 失败时绝不丢弃 instanceId:句柄没了就永远无法再删,这条会话会一直占着
   * 上游会话槽位(该账号再也 admit 不了别的新模型).所以失败时保留 session(连同
   * instanceId)并置 _releasePending,由 _scheduleReleaseRetry 退避重试;即使
   * 重试耗尽也把句柄留在 sessions.json 里,交给下一次释放机会 / 下次进程启动
   * 的扫尾继续删.
   *
   * @returns {Promise<boolean>} true = 上游已确认结束(或本来就无会话)
   */
  async _releaseUnlocked({ retry = true } = {}) {
    this._clearPoll()
    this._clearIdleRelease()
    if (!this.hasLiveSlot()) {
      this.session = { status: 'none' }
      this._releasePending = false
      this._notifySessionChange()
      return true
    }
    const instanceId = this.session?.instanceId
    const model = this.session?.model
    this._releasing = true
    /** @type {boolean} */
    let released = false
    // 退款结算是否已到终态.注意 released=true 只表示"上游确认会话已结束",
    // 挂起(freebucksRefundPending)时同样是 true —— 所以不能用 released 来判断
    // 该不该摘掉 orphan(摘早了这笔预扣就永远要不回来).
    let refundSettled = false
    try {
      // 必须带 instance id:上游 DELETE 没有 x-freebuff-instance-id 会 400
      // instance_required,会话既删不掉也拿不到 session_units 退还(issue #7 的元凶之一).
      let body = await this.upstream.freebuffSession('DELETE', { instanceId })
      // 结算未完成(freebucksRefundPending):用同一个 instance 重放 DELETE
      // 拿回执.有界重放,失败只记日志,绝不阻塞调用方.
      //
      // 2026-09 实测:上游对"提前结束"的会话会持续回 freebucksRefundPending,
      // 1.5s / 7s / 17s / 37s / 67s 五次重放全部仍为 pending.所以这里既不
      // 能让挂起的回执冒充"退款 0"(那是把"没结算完"错读成"退了 0 元"),
      // 也不能无限重放.重放两次后仍 pending 就保留句柄,交给下一次释放 /
      // 下次启动扫尾继续试.
      let refundPending = body?.freebucksRefundPending === true
      for (let i = 0; refundPending && i < 2; i += 1) {
        await sleep(i === 0 ? 1_500 : 4_000)
        body = await this.upstream.freebuffSession('DELETE', { instanceId })
        refundPending = body?.freebucksRefundPending === true
      }
      const settled = !refundPending && body?.status === 'ended'
      const refund =
        typeof body?.freebucksRefund === 'number' ? body.freebucksRefund : null
      if (settled) {
        // 只有拿到终态回执才算结算完成.没有金额 = 退款 0(vendor
        // af898dc 口径:ended 且不带 freebucksRefund 字段就是 0)——0 也是终态,
        // 到这一步才算"问完了",可以收工.
        refundSettled = true
        if (this._pendingRefundInstanceId === instanceId) {
          this._pendingRefundInstanceId = null
          this._clearRefundRetry()
        }
        // expected:按"实际占用时长"应付的退款(单价 × 未用满的小时数).
        // 上游把结算挂在整点/5 的倍数上,expected 与 refund 的差就是需要解释的
        // 那部分——这正是"退款怎么都不是 5 的倍数"该被对账掉的地方.
        const price =
          typeof this.freebucks?.prices?.[model] === 'number'
            ? this.freebucks.prices[model]
            : null
        const admittedAt = this.session?.admittedAt
          ? Date.parse(this.session.admittedAt)
          : NaN
        const holdMs =
          Number.isFinite(admittedAt) && admittedAt > 0
            ? Math.max(0, Date.now() - admittedAt)
            : null
        const expected =
          price != null && holdMs != null
            ? Math.max(0, round2(price * (1 - holdMs / 3_600_000)))
            : null
        // units 口径的应退:上游有 0.1 小时的最小时长下限(扣 0.1 起),
        // 所以"应退"= 1 − max(0.1, 占用小时数).与 Freebucks 口径的 expected
        // 并存:两本账的应退是两个不同的数,混在一起会让"Freebucks 侧为何
        // 长期 pending"这个未结问题彻底隐身(见架构 note).
        const expectedUnits =
          holdMs != null
            ? Math.max(0, round2(1 - Math.max(0.1, holdMs / 3_600_000)))
            : null
        const entry = {
          instanceId,
          model,
          refund,
          expected,
          expectedUnits,
          price,
          holdMs,
          at: new Date().toISOString(),
        }
        this.lastRefund = entry
        this._emitRefund(entry)
      } else {
        // 仍挂起:这笔钱还没结算完(pending = "最终用量还没算完,用同一个
        // instance 再问一次回执",不是"不退").所以:
        //   ① 句柄必须留着(丢了这笔预扣就永远取不回来);
        //   ② 立刻挂上持续重试定时器——只靠"下次启动扫尾"意味着进程不重启
        //      就再也没人问过,钱会一直挂在 pending 里(这正是我们之前把
        //      "没结算完"误读成"不退"的工程原因);
        //   ③ 也不能上报成退款 0——报 pending=true,账本归到"待结算".
        logger.warn('session refund still pending; will keep polling for the receipt', {
          instanceId,
          model,
          attempts: 3,
        })
        this._pendingRefundInstanceId = instanceId
        this._scheduleRefundRetry()
        // 落盘到 sessions.json 的待结算退款队列:本进程内由
        // _scheduleRefundRetry 追问,进程重启后由启动/周期扫尾接着追.
        // 少了这一步,重启就把这笔钱的存在本身弄丢了.
        this._emitSessionEvent({
          type: 'refund_pending',
          key: this.accountKey,
          instanceId,
          model,
        })
        // 上游已确认会话 ended —— 这条 session 不能继续占着,否则该账号
        // 永远无法 admit 新会话(等于把整号废掉).把句柄登记为 orphan:
        // 额度占用解除,但 instanceId 落盘保留,交给启动扫尾 / 后续重放去
        // 把挂起的结算要回来(handle store 已实现这套持久化).
        this._emitSessionEvent({
          type: 'orphan',
          key: this.accountKey,
          instanceId,
          model,
          admittedAt: this.session?.admittedAt ?? null,
          expiresAt: this.session?.expiresAt ?? null,
        })
      }
      const freebucks = extractFreebucks(body)
      if (freebucks) this.freebucks = freebucks
      else if (refund != null && this.freebucks) {
        // 上游只回回执,不回 freebucks 块时,本地按退款回填余额,
        // 让控制台和调度立刻看到[退款已到账].
        this.freebucks = {
          ...this.freebucks,
          balance: round2(Number(this.freebucks.balance || 0) + refund),
          daily: this.freebucks.daily
            ? {
                ...this.freebucks.daily,
                spent: round2(
                  Math.max(0, Number(this.freebucks.daily.spent || 0) - refund),
                ),
                remaining: round2(
                  Number(this.freebucks.daily.remaining || 0) + refund,
                ),
              }
            : this.freebucks.daily,
          updatedAt: new Date().toISOString(),
        }
      }
      this._notifyStateChange()
      logger.info('released freebuff session', {
        instanceId,
        model,
        refund,
        balance: this.freebucks?.balance ?? null,
      })
      released = true
    } catch (err) {
      // 关键:保留 handle(不动 this.session).丢弃 instanceId 会让这条会话
      // 变成无法寻址的孤儿:既删不掉,也会一直占着该账号的上游会话槽位.
      this._releasePending = true
      logger.warn('session DELETE failed; keeping handle for retry', {
        instanceId,
        model,
        error: err instanceof Error ? err.message : String(err),
        code: err?.code,
        attempt: this._releaseRetries,
      })
      if (retry) this._scheduleReleaseRetry()
      return false
    } finally {
      this._releasing = false
    }
    if (released) {
      // 只有结算到终态才摘 orphan.若仍挂起就保留它,交给下次启动扫尾继续
      // 重放——那时钱还没回来,摘掉就再也要不回来了.
      if (refundSettled) {
        this._emitSessionEvent({
          type: 'drop',
          key: this.accountKey,
          instanceId,
        })
      }
      this.session = { status: 'none' }
      this._releasePending = false
      this._releaseRetries = 0
      this._clearReleaseRetry()
      this._notifySessionChange()
    }
    return released
  }

  /**
   * 待结算退款的持续重试:只要这笔预扣还没拿到终态回执就一直在问.
   * 决策与证据见 .agents/notes/implemented/bug-fix/2026-09-13-refund-reversed.md.
   *
   * 与 _scheduleReleaseRetry(删不掉的退避重试)是两件事:那个问的是"会话删没删掉",
   * 这个问的是"钱退回来没有".上游在 pending 期间要求用同一个 instanceId 重放
   * DELETE 才能取回执(官方类型注释原话:"replay DELETE with the same instance for
   * its receipt"),官方客户端在 pending 期间每 3 秒重放一次.
   *
   * 这里取 30s 间隔 + 最长 1 小时:既不像 3s 那样对上游刷请求,又保证进程不重启
   * 也能拿到钱.超时后句柄仍留在 sessions.json,由下次启动扫尾继续(信息不丢).
   */
  _scheduleRefundRetry() {
    if (this._refundRetryTimer) return
    const instanceId = this._pendingRefundInstanceId
    if (!instanceId) return
    if (!this._refundRetryStartedAt) this._refundRetryStartedAt = Date.now()
    if (Date.now() - this._refundRetryStartedAt > REFUND_RETRY_MAX_MS) {
      logger.warn('pending refund still unsettled after the retry window; handle kept for next startup sweep', {
        instanceId,
        model: this.session?.model ?? null,
      })
      return
    }
    this._refundRetryTimer = setTimeout(() => {
      this._refundRetryTimer = null
      this._refundRetryStartedAt = null
      if (!this._pendingRefundInstanceId) return
      this._replayPendingRefund().catch((err) => {
        logger.warn('pending refund replay failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, REFUND_RETRY_INTERVAL_MS)
    if (this._refundRetryTimer.unref) this._refundRetryTimer.unref()
  }

  /**
   * 用同一个 instanceId 重放 DELETE 取退款回执.
   *
   * instanceId 只存在于内存(this._pendingRefundInstanceId)与 sessions.json 的
   * orphan 列表里;这里不依赖 this.session(那条会话早已置为 none),所以空闲释放
   * 之后的挂起退款也能继续被追问.
   */
  async _replayPendingRefund() {
    const instanceId = this._pendingRefundInstanceId
    if (!instanceId) return
    const body = await this.upstream.freebuffSession('DELETE', {
      instanceId,
      timeoutMs: this.config.session?.admitTimeoutMs ?? 30_000,
    })
    const pending = body?.freebucksRefundPending === true
    if (pending) {
      // 还没算完:继续等,句柄留着.
      this._scheduleRefundRetry()
      return
    }
    if (body?.status !== 'ended') {
      // 上游既没给终态也没说 pending:保留句柄,下次再问(绝不当作退 0).
      this._scheduleRefundRetry()
      return
    }
    const refund =
      typeof body?.freebucksRefund === 'number' ? body.freebucksRefund : null
    this._pendingRefundInstanceId = null
    this._clearRefundRetry()
    this._refundRetryStartedAt = null
    const model = this.session?.model ?? null
    const price =
      typeof this.freebucks?.prices?.[model] === 'number'
        ? this.freebucks.prices[model]
        : null
    const entry = {
      instanceId,
      model,
      refund,
      expected: null,
      expectedUnits: null,
      price,
      holdMs: null,
      replayed: true,
      at: new Date().toISOString(),
    }
    this.lastRefund = entry
    // 结算到了才允许摘 orphan——这时钱已经回来了.
    this._emitSessionEvent({ type: 'drop', key: this.accountKey, instanceId })
    this._emitRefund(entry)
    this._notifyStateChange()
    logger.info('pending refund settled on replay', {
      instanceId,
      model,
      refund,
    })
  }

  /** 取消待结算重试(拿到终态回执后调用). */
  _clearRefundRetry() {
    if (this._refundRetryTimer) {
      clearTimeout(this._refundRetryTimer)
      this._refundRetryTimer = null
    }
    this._refundRetryStartedAt = null
  }

  /**
   * 释放失败后的退避重试:0s → 5s → 15s → 60s(最多 4 次).
   * 重试仍失败也不丢句柄——session 原样留着,等下一次释放机会(空闲计时 /
   * 换号 / [断开全部连接]/ 重启前严格释放)或下次进程启动的扫尾继续删.
   */
  _scheduleReleaseRetry() {
    if (this._releaseRetryTimer) return
    const delays = [0, 5_000, 15_000, 60_000]
    if (this._releaseRetries >= delays.length) return
    const delay = delays[this._releaseRetries]
    this._releaseRetries += 1
    this._releaseRetryTimer = setTimeout(() => {
      this._releaseRetryTimer = null
      if (!this.hasLiveSlot()) {
        this._clearReleaseRetry()
        return
      }
      this.release().catch((err) => {
        logger.warn('session release retry failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, delay)
    if (this._releaseRetryTimer.unref) this._releaseRetryTimer.unref()
  }

  _clearReleaseRetry() {
    if (this._releaseRetryTimer) {
      clearTimeout(this._releaseRetryTimer)
      this._releaseRetryTimer = null
    }
  }

  /**
   * 通知上层把会话句柄落盘(/data/sessions.json).进程退出/换容器后仍能
   * 凭 instanceId 去 DELETE 退款,而不是留下无法寻址的孤儿会话.
   */
  _notifySessionChange() {
    const s = this.session
    if (!this.hasLiveSlot(s)) {
      this._emitSessionEvent({ type: 'clear', key: this.accountKey })
      return
    }
    this._emitSessionEvent({
      type: 'track',
      key: this.accountKey,
      instanceId: s.instanceId,
      model: s.model,
      admittedAt: s.admittedAt ?? null,
      expiresAt: s.expiresAt ?? null,
    })
  }

  /** 上报会话事件(track / orphan)——上层据此维护会话句柄索引. */
  _emitSessionEvent(entry) {
    if (this._onSessionChange) {
      try {
        this._onSessionChange(entry)
      } catch (err) {
        logger.warn('session event callback failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /** 上报一笔已结算的退款(上层记进账号账本的退款流水). */
  _emitRefund(entry) {
    if (!this._onStateChange) return
    try {
      this._onStateChange({ refund: entry })
    } catch (err) {
      logger.warn('refund callback failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** 上报账号账目变化(freebucks / quota / lastProbe)——上层据此落盘. */
  _notifyStateChange() {
    if (!this._onStateChange) return
    try {
      this._onStateChange({
        freebucks: this.freebucks,
        quota: this.quota,
        lastProbe: this.lastProbe,
      })
    } catch (err) {
      logger.warn('state change callback failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** 带 handle 的严格释放:失败时返回 false(调用方据此重试/上报,不谎报成功). */
  async releaseIfLive() {
    return this.withLock(() => this._releaseUnlocked({ retry: false }))
  }

  /**
   *  禁止用本方法处理 waiting_room_required(428).
   *
   * 它做的两件事都是错的(2026-10-04 真实事故,用户原话"花了钱买了东西,
   * 上游说重发一遍,你却把钱交了又重新买一遍"):
   *
   *   1. _releaseUnlocked() —— 先 DELETE 掉已经买断的那一小时.
   *      上游对早退 DELETE 不退 Freebucks(实测只回 freebucksRefundPending,
   *      观察 2 分钟未到账),所以这是直接烧钱.
   *   2. _admitUnlocked() —— 再买一小时.余额已扣光时这一步必然失败
   *      (skip re-admit: freebucks cannot afford model),于是钱花了,
   *      货退了,新的还买不起,账号进入最差状态.
   *
   * 官方真值(orchestrator.js,官方 desktop 0.0.158 解包):
   *   - 179243  waiting_room_required: { status: 428, endsTheSession: !0 }
   *   - 180126  命中后存进度 → 重新 admission → 用同一条消息重跑
   *   - 207147  重新 admission 带 x-freebuff-purchase-continuity: "1"
   *               + 同一个 instanceId(整线程复用)→ 上游认作续用那一小时
   *   - 官方从不先 DELETE
   *
   * 所以 428 的正确处置是 readmitToContinue()(复用同一 instanceId +
   * purchase-continuity 续用),不是本方法.本方法仅保留给
   * 确实需要换一条新会话的 gate(如 session_model_mismatch 要换绑模型).
   * @param {string} model
   */
  async forceReadmit(model) {
    return this.withLock(async () => {
      await this._releaseUnlocked()
      return this._admitUnlocked(model)
    })
  }

  /**
   * 428 waiting_room_required 的官方对齐处置:续用当前已买断的会话,
   * 不 DELETE,不重买.
   *
   * 上游原话就是 "Send your message again to start a new one" —— 它要的是
   * 重发消息,不是重新购买.官方客户端据此做的是:带同一个 instanceId
   * 与 purchase-continuity: 1 重新 admission(上游按"续用"处理,不再计入
   * 新的购买),再重跑同一条消息.
   *
   * 本方法只做"续用"这一跳(re-admit with continuity);chat 重发由调用方
   * 在重试循环里完成(用同一 prompt).
   *
   * 关键约束:绝不释放既有会话 —— 那一小时是实付的,扔了就没了.
   * @param {string} model
   * @returns {Promise<{ continued: boolean, instanceId?: string | null, reason?: string }>}
   */
  async readmitToContinue(model) {
    return this.withLock(async () => {
      const existing = this.session?.instanceId || this.instanceId || null
      if (!existing) {
        // 本来就没有会话(不是"续用"场景):交给常规 admit
        logger.info('readmitToContinue: no live instance; falling back to admit', {
          model,
        })
        const s = await this._admitUnlocked(model)
        return { continued: true, instanceId: s?.instanceId ?? null }
      }
      /**
       * 复用同一 instanceId 重新 admission.
       *
       * officialSessionHeaders() 在有 instanceId 时自动带上
       * x-freebuff-purchase-continuity: 1(见 official-fingerprint.js:191-193),
       * 所以这里只需把 instanceId 传进去 —— 不额外造一个参数,
       * 以免发明一个并不存在的契约.
       */
      const body = await this.upstream.freebuffSession('POST', {
        model,
        instanceId: existing,
      })
      const status = body?.status
      if (status === 'active') {
        this._apply(body)
        this._setLastProbe({ ok: true })
        return { continued: true, instanceId: body?.instanceId || existing }
      }
      // 续用没成:保留会话现场(不释放),让上层决定是否换号.
      // 绝不在这里 DELETE —— 那一小时已付款,丢了就是纯亏.
      logger.warn('readmitToContinue did not return active; keeping session', {
        model,
        status: status ?? null,
        instanceId: existing,
      })
      return { continued: false, instanceId: existing, reason: status || 'not_active' }
    })
  }

  /**
   * 发一次持有心跳(官方形态):GET /session + instance-id + -heartbeat: 1.
   *
   * 见 _admitUnlocked 里的说明 —— 官方在 admission 后立刻发一次,之后每 45s
   * 一次;我们此前一次都没发(makeSessionViaBun 丢弃 opts).
   * 失败只记日志,绝不影响调用方(可用性优先).
   * @param {string} instanceId
   */
  /**
   * 吸收上游回执里的会话清单(官方 absorbRefunds / desktopPurchases 同源).
   *
   * 上游 GET /session(任何 status,包括 none)都会带:
   *   desktopPurchases     — 谁占着哪个模型的槽位(含 holderInstanceId / expiresAt)
   *   desktopSessionCounts — 活跃会话计数(premium / unlimited / nextExpiryAt)
   *   desktopRefunds       — 退款记录(对账用)
   *
   * 这是跨部署可见的唯一真源:本地账本各记各的,而这份清单列出全部
   * 持有者(含别的部署建的会话)—— 于是"我在本地建的会话,远程也能看到".
   * @param {any} body
   */
  _absorbInventory(body) {
    if (!body || typeof body !== 'object') return
    // 只要收到过上游回执(任何 status),就说明"对过账"了 —— 见 hasInventorySnapshot.
    if (Array.isArray(body.desktopPurchases)) this._inventorySeen = true
    const purchases = Array.isArray(body.desktopPurchases)
      ? body.desktopPurchases.filter(
          (p) =>
            p &&
            typeof p === 'object' &&
            typeof p.holderInstanceId === 'string' &&
            p.holderInstanceId,
        )
      : null
    if (purchases) this.desktopPurchases = purchases
    if (body.desktopSessionCounts && typeof body.desktopSessionCounts === 'object') {
      this.desktopSessionCounts = body.desktopSessionCounts
    }
    if (Array.isArray(body.desktopRefunds)) this.desktopRefunds = body.desktopRefunds
  }

  /**
   * 上游此刻谁占着这个模型的槽位(官方 knownHolder,orchestrator.js:208639).
   *
   * 官方原文:
   *   knownHolder: (model) => this.desktopPurchases
   *     .find(p => p.model === model && p.holderInstanceId
   *                && Date.parse(p.expiresAt) > Date.now())
   *     ?.holderInstanceId
   *
   * 用途:发请求之前就知道槽位被谁占着,可以直接带
   * x-freebuff-takeover-instance-id 接管 —— 不必等撞上 purchase_capacity
   * 再从错误回执里捡那个 id(慢一拍,且多一次失败请求).
   *
   * 这也是跨部署可见的来源:本地/远程各建过会话时,上游回执里的
   * desktopPurchases 会把全部持有者都列出来(含别的部署建的),
   * 因为真值在上游,不在任何一方的本地账本里.
   *
   * @param {string} model 目录 key(m-xxx)
   * @returns {string | null} 占用者 instanceId;无人占用返回 null
   */
  /**
   * 上游此刻谁占着这个模型的槽位(官方 knownHolder,orchestrator.js:208639).
   *
   * 上游清单里的 model 是上游模型 id(deepseek/deepseek-v4-flash),
   * 而我们调用方传的是目录 key(m-096e75164d)—— 两套标识不同,严格相等
   * 永远匹配不上,这正是"面板能显示那条已付费会话,调度却看不见"的原因
   * (2026-08-04 用户当场指出:展示了却不复用 = 白花钱).
   *
   * 所以这里复用仓库既有的唯一映射真源(SessionManager 不认识
   * AppContext,故由构造时注入的 resolveModelAlias 提供;缺失时退回严格相等):
   * 把两侧都归一成目录 key 再比.不另写一套映射 —— 那只会制造第二真源.
   *
   * @param {string} model 目录 key / 上游 id / 可读名,任一形式
   * @returns {string | null} 占用者 instanceId;无人占用返回 null
   */
  /**
   * 本进程是否已经拿到过上游会话清单快照.
   *
   * 用于区分"从没对过账"与"对过账但这次没命中" —— 前者不该为了让某个
   * 尚未决定购买的请求去探测(那个 GET 在官方建会话路径上会建出会话).
   * @returns {boolean}
   */
  hasInventorySnapshot() {
    return this._inventorySeen === true
  }

  holderFor(model) {
    if (!model || !Array.isArray(this.desktopPurchases)) return null
    const now = Date.now()
    const norm = (v) =>
      typeof this.resolveModelAlias === 'function'
        ? this.resolveModelAlias(v)
        : String(v ?? '')
    const want = norm(model)
    const hit = this.desktopPurchases.find(
      (p) =>
        p &&
        p.model &&
        norm(p.model) === want &&
        typeof p.holderInstanceId === 'string' &&
        p.holderInstanceId &&
        (!p.expiresAt || Date.parse(p.expiresAt) > now),
    )
    return hit?.holderInstanceId || null
  }

  _sendHoldHeartbeat(instanceId) {
    if (!instanceId) return
    Promise.resolve()
      .then(() =>
        this.upstream.freebuffSession('GET', {
          instanceId,
          heartbeat: true,
        }),
      )
      .then((body) => {
        logger.info('hold heartbeat sent', {
          instanceId,
          status: body?.status ?? null,
        })
      })
      .catch((err) => {
        logger.warn('hold heartbeat failed (non-fatal)', {
          instanceId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  _armPoll() {
    this._clearPoll()
    const ms = Math.max(5_000, (this.config.session.pollIntervalSec || 30) * 1000)
    this._pollTimer = setInterval(() => {
      // 轮询 = 持有心跳(官方 45s 一次;我们按 pollIntervalSec 跑,更密更安全)
      this.refresh({ heartbeat: true }).catch((err) => {
        logger.warn('session poll failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, ms)
  }

  _clearPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  }

  /** 该账号当前仍活着的上游 instance id(含一次也没删掉的句柄). */
  knownInstances() {
    const s = this.session
    if (!this.hasLiveSlot(s)) return []
    return [s.instanceId]
  }

  /**
   * 严格释放(用于[断开全部连接]/[重启服务]/进程退出):
   * 逐次 DELETE 直到上游确认结束,或退避重试耗尽;返回结果明细,
   * 绝不谎报成功——失败时句柄仍留在 sessions.json 里,下次启动扫尾.
   * @returns {Promise<{ok: boolean, instanceId?: string, attempts: number, error?: string}>}
   */
  async releaseStrict() {
    const delays = [0, 400, 1_500, 5_000]
    let attempts = 0
    let lastError = null
    for (const delay of delays) {
      if (!this.hasLiveSlot()) {
        return { ok: true, attempts }
      }
      if (delay > 0) await sleep(delay)
      attempts += 1
      try {
        const ok = await this.withLock(() =>
          this._releaseUnlocked({ retry: false }),
        )
        if (ok) return { ok: true, attempts }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      const inst = this.session?.instanceId
      if (!this.hasLiveSlot()) return { ok: true, attempts }
      lastError = lastError || `session ${inst} still live after DELETE`
    }
    return {
      ok: false,
      instanceId: this.session?.instanceId,
      attempts,
      error: lastError || 'release failed',
    }
  }

  async shutdown() {
    this._clearPoll()
    this._clearIdleRelease()
    this._clearReleaseRetry()
    if (this.config.session.releaseOnShutdown) {
      await this.release()
    }
  }
}


/**
 * 上游 session 回执里账号级的终态状态码(不是"这条会话怎么了",而是
 * "这个账号怎么了").这类回执到达时,会话现场必须原样保留——它们既不代表
 * 当前会话已结束,也不携带新的 instanceId,用它覆盖 session 等于把唯一能
 * 用来 DELETE 退款的句柄丢掉(见 refresh() 里的注释).
 *
 * 名单与 app-context.js 的 ACCOUNT_COOLDOWN_CODES,_terminalSessionError 的
 * statusMap 保持一致:banned / country_blocked 是 403 直通,rate_limited /
 * spend_limited / ip_capped / free_mode_rate_limited 是 429 直通.
 *
 * @param {unknown} status
 * @returns {string | null} 命中则返回规范化后的 code
 */
export function accountLevelSessionStatus(status) {
  const s = typeof status === 'string' ? status.trim().toLowerCase() : ''
  if (!s) return null
  return ACCOUNT_LEVEL_SESSION_STATUSES.has(s) ? s : null
}

/**
 * Pull daily-session quota out of a Freebuff session payload.
 * Present on admit (POST) and on GET while a slot is live; absent when
 * status is none. Returns null when the payload has no quota info.
 * @param {any} body
 * @returns {null | { byModel: Record<string, any>, rateLimit: any, updatedAt: string }}
 */
function extractQuota(body) {
  if (!body || typeof body !== 'object') return null
  const byModel =
    body.rateLimitsByModel && typeof body.rateLimitsByModel === 'object'
      ? body.rateLimitsByModel
      : null
  if (!byModel && !body.rateLimit) return null
  const single = byModel || {}
  if (body.rateLimit && body.rateLimit.model) {
    single[body.rateLimit.model] = body.rateLimit
  }
  return {
    byModel: single,
    rateLimit: body.rateLimit || null,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Pull the Freebucks meter out of a Freebuff session payload (2026-09 计费改版).
 *
 * 上游把[计费货币]放在每个 session 响应的 freebucks 字段里:
 *   { balance, daily:{limit,spent,remaining,resetAt}, wallet:{...},
 *     prices:{ modelId: price }, quotaExempt, planId, monthly, peak, priceChanges }
 * admit 按整小时单价预扣,提前 DELETE 不退(2026-09-13 实测,见 §3),所以本地必须知道
 * [每个模型多少钱]和[这个账号还买不买得起],否则会白白 admit 一堆计费会话.
 * 老上游/未登录状态没有该字段 → 返回 null,调度退回旧行为(不拦截).
 * @param {any} body
 */
function extractFreebucks(body) {
  if (!body || typeof body !== 'object') return null
  const fb = body.freebucks
  if (!fb || typeof fb !== 'object') return null
  const daily = fb.daily && typeof fb.daily === 'object' ? fb.daily : {}
  const wallet = fb.wallet && typeof fb.wallet === 'object' ? fb.wallet : {}
  /** @type {Record<string, number>} */
  const prices = {}
  if (fb.prices && typeof fb.prices === 'object') {
    for (const [id, price] of Object.entries(fb.prices)) {
      const n = Number(price)
      if (Number.isFinite(n)) prices[id] = n
    }
  }
  const monthly =
    fb.monthly && typeof fb.monthly === 'object'
      ? {
          limitUsd: num(fb.monthly.limitUsd),
          spentUsd: num(fb.monthly.spentUsd),
          remainingUsd: num(fb.monthly.remainingUsd),
          resetAt: fb.monthly.resetAt ?? null,
        }
      : null
  return {
    balance: num(fb.balance),
    daily: {
      limit: num(daily.limit),
      spent: num(daily.spent),
      remaining: num(daily.remaining),
      resetAt: daily.resetAt ?? null,
    },
    wallet: {
      balance: num(wallet.balance),
      monthlyBonus: num(wallet.monthlyBonus),
      nextBonusAt: wallet.nextBonusAt ?? null,
    },
    prices,
    quotaExempt: fb.quotaExempt === true,
    planId: typeof fb.planId === 'string' ? fb.planId : null,
    monthly,
    peak: fb.peak && typeof fb.peak === 'object' ? fb.peak : null,
    updatedAt: new Date().toISOString(),
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/** 有界等待(毫秒). */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}
