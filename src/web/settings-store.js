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
  // 一键屏蔽收费模型（pool=premium，如 gpt-5.6-luna / kimi-k3-eco / 各 -max）。
  // 免费反代用户用不了收费模型，放着在列表里既占位又容易误触风控——开/关由
  // 前端「模型管理」一键切换：开启则从 /v1/models 列表和调度（白名单）彻底排除。
  // 默认关闭以保持升级不改变现有行为；免费反代场景建议开启。
  blockPremiumModels: false,
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
      if (typeof raw?.blockPremiumModels === 'boolean') {
        this.settings.blockPremiumModels = raw.blockPremiumModels
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
    if (next?.blockPremiumModels !== undefined) {
      if (typeof next.blockPremiumModels !== 'boolean') {
        throw new TypeError('blockPremiumModels must be a boolean')
      }
      this.settings.blockPremiumModels = next.blockPremiumModels
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
 * 上游按 session 实际占用时长结算（N Freebucks/小时，提前 DELETE 退未用时长），
 * 所以默认压到 60s、下限放宽到 5s——空闲会话多挂一秒就多扣一秒。
 * 低于 ~5s 等于把每个回合都切成一条新会话（admit 往返变多、额度按条计费的
 * 订阅档位会吃亏），所以不放到 1s。
 */
function clampIdleReleaseSec(n) {
  if (n <= 0) return 0
  return Math.min(86_400, Math.max(5, n))
}

/** 单请求新会话预算：0（不限制）或 1..16。 */
function clampNewSessions(n) {
  if (n <= 0) return 0
  return Math.min(16, Math.max(1, n))
}

export { DEFAULT_SETTINGS }
