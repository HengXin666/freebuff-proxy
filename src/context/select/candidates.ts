/**
 * 选号排序: 候选计分, 排序, 冷却明细 ---- 从 src/app-context.ts 按职责切出.
 *
 * 本模块回答"这个账号此刻值不值得被选中", 是粘性调度(drain, not rotate)的全部判据;
 * "选到之后怎么拿锁"属于 acquire.
 *
 * 口径: 迁移前后行为一致. 模块级函数 + self/this 首参, 由 src/context/methods.ts 的
 * CONTEXT_METHODS 装配回原型(名字即契约).
 */

/**
 * 计算单个候选账号的调度指标(供排序用): 会话复用(tier 判定输入),
 * 两本额度账(units / Freebucks), 并发负载, 是否用过.
 * @param {any} self 账号池(runtimes)
 * @param {string} key 候选账号 key
 * @param {string} model 请求模型
 * @returns {any} 指标对象
 */
export function computeCandidateMetrics(self: any, key: any, model: any) {
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
  // inFlight = 已拿到 chat 锁的真实在途; load 再计入"刚被选中, 正在拿锁"的预留.
  const inFlight = chatLock?.inFlight || 0
  const load = inFlight + self.reservedCount(key)
  const capacity = chatLock?.capacity || self._accountConcurrency()
  // Freebucks 余额买不起该模型(balance < prices[model])时排到最后:
  // 不为其白开一条计费 session.
  const fbInfo = sessions?.freebucksFor?.(model)
  const unaffordable = fbInfo?.known && fbInfo.affordable === false ? 1 : 0
  // session_units 用尽的账号同样排到最后(两本账都扣).
  const unitsInfo = sessions?.sessionUnitsFor?.(model)
  const unitsOut = unitsInfo?.known && unitsInfo.exhausted ? 1 : 0
  const used = self.everUsed(key, sessions)
  // tier 按"会话状态"分(与 used 无关):
  //   0 = 同模型热 session(复用零成本)
  //   1 = 冷账号(没有活跃会话)或同模型即将过期
  //   2 = 活跃 session 绑在别的模型上(换模型要释放它)
  // 先按 tier 排: 冷账号优先于"杀掉另一个模型的热会话"(多模型交替会在同一账号上
  // 反复 release/admit, 每次都是一条计费会话).
  const otherModelLive = live && sameModel === false
  const busyNearExpiry =
    live && sameModel && !usable && (sessions?.inFlightCount?.() || 0) > 0
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

/**
 * 评估单个候选账号, 产出排序用的计分对象: 会话复用/额度两本账/并发负载/是否用过,
 * 并算出 tier 与 busy.
 * @param {any} self 账号池(runtimes)
 * @param {string} key 候选账号 key
 * @param {string} model 请求模型
 * @param {number} rotation 该 key 在本轮遍历里的序号(平局打破)
 * @returns {any | null} 计分对象; 跳过(冷却/不在候选)时返回 null
 */
export function scoreCandidate(self: any, key: any, model: any, rotation: any) {
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
 * 全部账号都在冷却时的失败明细(供 "Tried N" 报错使用): 每个账号的冷却到期时刻与
 * 冷却码.
 * @param {any} self 账号池(runtimes)
 * @param {string[]} keys 全部账号 key
 * @param {string} model 请求模型
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @param {Array<any>} failures 失败明细(原地追加)
 * @returns {void}
 */
export function collectCooldownFailures(self: any, keys: any, model: any, emailByKey: any, failures: any) {
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
 * 选号排序.
 *
 * 粘性优先 / drain, not rotate: 把请求集中到尽可能少的账号上, 用尽
 * (限流 / 额度耗尽 / 冷却 / 满员排队超时)才换下一个; 从未用过的账号排最后,
 * 只有已用账号都不可用时才启用.
 *
 * 排序维度(从前到后):
 *   1. tier(会话状态): 同模型热 session(复用零成本)> 冷账号 > 活跃 session
 *      绑在别的模型上(换模型要释放它). 冷账号排在"杀掉另一个模型的热会话"之前,
 *      避免多模型交替时在同一账号上反复 release/admit(每次都买一条计费会话);
 *   2. used: 同一 tier 内已用过的账号 > 从未用过的账号(不轻易碰新账号);
 *   3. busy: 优先有空闲槽位的. 满员账号只要属于已用账号, 仍排在"从未用过的账号"
 *      之前, 新请求会在它上面做一次有界排队, 超时后由 proxy.ts 加进 skipKeys
 *      才真正溢出;
 *   4. lastUsedAt 倒序(粘性: 优先继续用刚用过的那个);
 *   5. 在途少 > 额度耗尽 > 余额不足 > 轮询(平局打破).
 * @param {any} this 账号池(runtimes)
 * @param {string} model 请求模型
 * @param {{ skipKeys?: Set<string> }} [opts] skipKeys: 本次请求已经排队超时过的
 *   账号, 不再重复选中.
 * @returns {string[]} 按优先级排序的账号 key
 */
export function candidateKeys(this: any, model: any, opts: any = {}) {
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
  // sticky(drain, not rotate):并发上限是溢出阈值----满员先在原账号排队,
  //   超时才换号;"从未用过的账号"排最后.最少换号 = 最少新建计费会话.
  // spread(并发优先):有空闲槽位的账号提到最前,满员立即溢出;
  //   只有所有账号都满员时才排队.这样"设了并发 2 却只开 1 个号"不再发生.
  //
  // spread 下 busy 必须排在 used 之前:"已用但满员"的账号会压住"空闲但从未用过"
  // 的账号, 新号会一直等不到.
  // spread 仍然保留 tier 优先(同模型热 session 复用零成本), 只是把
  // "有空闲槽位的冷账号"提前到"满员的已用账号"之前.
  const spread = this.schedulingMode() === 'spread'
  if (process.env.FB_DEBUG_SCHED) {
    console.error("[sched] mode=" + (spread ? "spread" : "sticky"))
  }
  candidates.sort(
    (a, b) =>
      // 1) 首要维度:sticky 看能不能复用,spread 看有没有空位.
      //    spread 下 busy 排第一:"带着热 session 但已满员"的账号会压住
      //    "空闲的冷账号", 新号轮不到. 热 session 复用在 spread 模式下
      //    让位给并发.
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
