/**
 * 选号排序: 候选计分, 排序, 冷却明细 ---- 从 src/app-context.ts 按职责切出.
 *
 * 为什么单独成文件: 这一段回答"这个账号此刻值不值得被选中", 是粘性调度
 * (drain, not rotate)的全部判据; 它与"选到之后怎么拿锁"(acquire)是两件事.
 * 原实现里它们挤在同一个类里, 213 行连注释都读不完.
 *
 * 口径: 纯搬移, 行为零改动. 按本仓既有模式改为模块级函数 + self/this 首参,
 * 并由 src/context/methods.ts 的 CONTEXT_METHODS 装配回原型(名字即契约).
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
 * 全部账号都在冷却时的失败明细(供 "Tried N" 报错使用).
 *
 * 从 _acquireForModelUnlocked 抽出. 为什么要它: 没有可用候选时若只报
 * "Tried 0", 用户看不出每个号冷却到几点/因为什么; 带上明细后这句话才自解释.
 * @param {any} self 账号池(runtimes)
 * @param {string[]} keys 全部账号 key
 * @param {string} model 请求模型
 * @param {Map<string, any>} emailByKey key 到邮箱
 * @param {Array<any>} failures 失败明细(原地追加)
 * @returns {void}
 */
export function collectCooldownFailures(self: any, keys: any, model: any, emailByKey: any, failures: any) {
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
 *      会话),超时后由 proxy.ts 加进 skipKeys 才真正溢出;
 *   4. lastUsedAt 倒序(粘性:优先继续用刚用过的那个);
 *   5. 在途少 > 额度耗尽 > 余额不足 > 轮询(平局打破).
 * @param {any} this 账号池(runtimes)
 * @param {string} model 请求模型
 * @param {{ skipKeys?: Set<string> }} [opts] skipKeys:本次请求已经排队超时过的
 *   账号,不再重复选中(否则会一直排在第一位反复等).
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
