import fs from 'node:fs'
import path from 'node:path'
import { readJsonFileState, noteDataFile } from '../util/json-store.js'

const DEFAULT_SETTINGS = Object.freeze({
  freeToolSignatureEnabled: true,
  // 每个账号同一时间可并发的 SSE 响应流数（账号内并发），默认 2。
  // 账号调度是"粘性优先"（drain, not rotate）：并发请求先挤同一账号，超过该值
  // 才溢出到下一个账号；从不主动平摊到新账号（上游把轮换健康账号当农场特征，
  // 且 Freebucks 按会话占用时长计费，换号 = 新买一条计费行）。
  accountMaxConcurrency: 2,
  // 账号调度模式（2026-09 新增，默认保持旧行为）：
  //   'sticky' = 粘性优先（drain, not rotate）：并发上限是**溢出**阈值——
  //              满员先在该账号上有界排队，排队超时才溢出到下一个账号。
  //              最少换号 = 最少新建计费会话（换号就是新买一条 Freebucks 行）。
  //   'spread' = 并发优先：排序时**优先有空闲槽位的账号**，只在所有账号都
  //              满员时才排队；已用账号仍优先于从未用过的账号，但"已用账号
  //              全满 + 还有未用账号"时允许启用一个未用账号（= 申请新号）。
  //              代价是可能多预占（N 路并发铺到 M 个账号 = 最多 M 条计费会话），
  //              换来的是**不再为并发让请求干等**（低提交延迟）。
  // 用户场景：并发满了就该开新号（批量/绘图）；默认关闭以保持升级不改变行为。
  accountSchedulingMode: 'sticky',
  // 溢出前的最长排队时长（毫秒）。sticky 下热会话/冷账号各有自己的等待
  // （见 proxy.chatWaitMs），本值只在 spread 模式生效：账号满员时最多等这么久
  // 就换号，绝不把并发钉死在一个账号上。
  accountOverflowWaitMs: 15_000,
  // 一键屏蔽收费模型（pool=premium，如 gpt-5.6-luna / kimi-k3-eco / 各 -max）。
  // 免费反代用户用不了收费模型，放着在列表里既占位又容易误触风控——开/关由
  // 前端「模型管理」一键切换：开启则从 /v1/models 列表和调度（白名单）彻底排除。
  // 默认关闭以保持升级不改变现有行为；免费反代场景建议开启。
  blockPremiumModels: false,
  // 「低额度」分组阈值（FB）：余额低于它就在控制台归到「低额度」分组——**只是分组
  // 展示，不影响调度**（这些号照常参与选号，低额度不等于不能用）。默认 15 FB，
  // 0 = 关闭该分组。用户要的是「一眼看到快跑完的号」，所以阈值可调。
  lowBalanceThreshold: 15,
  // 注意：额度保护两项（idleReleaseSec / maxNewSessionsPerRequest）**不写死默认值**
  // ——只有用户在控制台保存过才进 settings.json，否则回落 config.yaml
  // （session.idle_release_sec / limits.max_new_sessions_per_request），
  // 这样"config.yaml 只作兜底默认值"的约定才成立。
})

/** Frontend-managed runtime settings persisted under /data. */
export class SettingsStore {
  /** @param {string} file e.g. /data/settings.json */
  constructor(file) {
    this.file = file
    this.settings = { ...DEFAULT_SETTINGS }
    /** 装载结果（'ok' | 'missing' | 'invalid'）：损坏时是**回落默认值**，必须在
     * 启动横幅/自检里说清楚，否则用户配的额度保护会悄悄消失。 */
    this.loadStatus = 'missing'
    this.loadReason = null
    this.load()
  }

  load() {
    const st = readJsonFileState(this.file)
    noteDataFile(this.file, st)
    this.loadStatus = st.status
    this.loadReason = st.status === 'invalid' ? st.reason : null
    if (st.status === 'invalid') {
      // 结构也一并判：能解析但不是对象（如被写成数组/字符串）同样按损坏处理。
      this.loadReason = st.reason
    }
    if (st.status === 'ok') {
      const raw = st.data
      if (typeof raw?.freeToolSignatureEnabled === 'boolean') {
        this.settings.freeToolSignatureEnabled = raw.freeToolSignatureEnabled
      }
      if (Number.isInteger(raw?.accountMaxConcurrency)) {
        this.settings.accountMaxConcurrency = clampConcurrency(
          raw.accountMaxConcurrency,
        )
      }
      if (raw?.accountSchedulingMode === 'sticky' || raw?.accountSchedulingMode === 'spread') {
        this.settings.accountSchedulingMode = raw.accountSchedulingMode
      }
      if (Number.isInteger(raw?.accountOverflowWaitMs)) {
        this.settings.accountOverflowWaitMs = clampOverflowWait(
          raw.accountOverflowWaitMs,
        )
      }
      if (typeof raw?.blockPremiumModels === 'boolean') {
        this.settings.blockPremiumModels = raw.blockPremiumModels
      }
      if (Number.isInteger(raw?.lowBalanceThreshold)) {
        this.settings.lowBalanceThreshold = clampLowBalance(raw.lowBalanceThreshold)
      }
      if (Number.isInteger(raw?.idleReleaseSec)) {
        this.settings.idleReleaseSec = clampIdleReleaseSec(raw.idleReleaseSec)
      }
      if (Number.isInteger(raw?.maxNewSessionsPerRequest)) {
        this.settings.maxNewSessionsPerRequest = clampNewSessions(
          raw.maxNewSessionsPerRequest,
        )
      }
    } else if (st.status === 'invalid') {
      console.error(`[freebuff-proxy] 数据文件损坏: ${this.file} — ${st.reason}（已回落默认设置）`)
    }
    return st
  }

  get() {
    return { ...this.settings }
  }

  /** @param {{ freeToolSignatureEnabled?: boolean, accountMaxConcurrency?: number }} next */
  save(next) {
    if (next?.freeToolSignatureEnabled !== undefined) {
      if (typeof next.freeToolSignatureEnabled !== 'boolean') {
        throw new TypeError('freeToolSignatureEnabled must be a boolean')
      }
      this.settings.freeToolSignatureEnabled = next.freeToolSignatureEnabled
    }
    if (next?.accountMaxConcurrency !== undefined) {
      if (
        !Number.isInteger(next.accountMaxConcurrency) ||
        next.accountMaxConcurrency < 1
      ) {
        throw new TypeError('accountMaxConcurrency must be an integer >= 1')
      }
      this.settings.accountMaxConcurrency = clampConcurrency(
        next.accountMaxConcurrency,
      )
    }
    if (next?.accountSchedulingMode !== undefined) {
      if (
        next.accountSchedulingMode !== 'sticky' &&
        next.accountSchedulingMode !== 'spread'
      ) {
        throw new TypeError("accountSchedulingMode must be 'sticky' or 'spread'")
      }
      this.settings.accountSchedulingMode = next.accountSchedulingMode
    }
    if (next?.accountOverflowWaitMs !== undefined) {
      if (!Number.isInteger(next.accountOverflowWaitMs)) {
        throw new TypeError('accountOverflowWaitMs must be an integer')
      }
      this.settings.accountOverflowWaitMs = clampOverflowWait(
        next.accountOverflowWaitMs,
      )
    }
    if (next?.blockPremiumModels !== undefined) {
      if (typeof next.blockPremiumModels !== 'boolean') {
        throw new TypeError('blockPremiumModels must be a boolean')
      }
      this.settings.blockPremiumModels = next.blockPremiumModels
    }
    if (next?.lowBalanceThreshold !== undefined) {
      if (
        !Number.isInteger(next.lowBalanceThreshold) ||
        next.lowBalanceThreshold < 0
      ) {
        throw new TypeError('lowBalanceThreshold must be an integer >= 0')
      }
      this.settings.lowBalanceThreshold = clampLowBalance(
        next.lowBalanceThreshold,
      )
    }
    if (next?.idleReleaseSec !== undefined) {
      if (!Number.isInteger(next.idleReleaseSec) || next.idleReleaseSec < 0) {
        throw new TypeError('idleReleaseSec must be an integer >= 0')
      }
      this.settings.idleReleaseSec = clampIdleReleaseSec(next.idleReleaseSec)
    }
    if (next?.maxNewSessionsPerRequest !== undefined) {
      if (
        !Number.isInteger(next.maxNewSessionsPerRequest) ||
        next.maxNewSessionsPerRequest < 0
      ) {
        throw new TypeError('maxNewSessionsPerRequest must be an integer >= 0')
      }
      this.settings.maxNewSessionsPerRequest = clampNewSessions(
        next.maxNewSessionsPerRequest,
      )
    }
    const settings = { ...this.settings }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, ...settings }, null, 2),
      { mode: 0o600 },
    )
    fs.renameSync(tmp, this.file)
    this.settings = settings
    return this.get()
  }
}

/** 并发上限：1..16，防止误配造成上游顶号。 */
function clampConcurrency(n) {
  return Math.min(16, Math.max(1, n))
}

/**
 * 空闲释放：0（关闭）或 5s..24h。
 * 上游 admit 一次就按**整小时单价预扣**，早退 DELETE 不退 Freebucks（2026-09-13
 * 实测，见 docs/account-scheduling-and-refund.md §3）。所以「空闲早退省钱」是错的——
 * 释放后再来请求就是**又买一小时**，默认值应为「尽量别释放」的 600s。
 * 下限仍保留 5s：低于 ~5s 等于把每个回合都切成一条新会话，admit 往返次数暴涨，
 * 在「按条计费」的档位上反而更亏。
 */
/**
 * 低额度分组阈值：0（关闭）或 1..10000 FB。上限给足空间（个别模型单价很高），
 * 但别到「所有号都在低额度组里」那种失去意义的地步。
 */
function clampLowBalance(n) {
  if (n <= 0) return 0
  return Math.min(10_000, Math.max(1, n))
}

function clampIdleReleaseSec(n) {
  if (n <= 0) return 0
  return Math.min(86_400, Math.max(5, n))
}

/**
 * 溢出前排队上限：0（不等待，槽位满立即换号）或 1s..10min。
 * 上限压到 10 分钟：调度总预算（schedulingBudgetMs 默认 45s）另有约束，
 * 这里再大也不会真的等那么久，只是给了「宁可排队也不换号」一个上限。
 */
function clampOverflowWait(n) {
  if (n <= 0) return 0
  return Math.min(600_000, Math.max(1_000, n))
}

/** 单请求新会话预算：0（不限制）或 1..16。 */
function clampNewSessions(n) {
  if (n <= 0) return 0
  return Math.min(16, Math.max(1, n))
}

export { DEFAULT_SETTINGS }
