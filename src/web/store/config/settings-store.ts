import fs from 'node:fs'
import path from 'node:path'
import { readJsonFileState, noteDataFile } from '../../../util/json-store.ts'
import { readTunables, writeTunables } from './tunables-store.ts'
import { LIVE_FIELDS } from './settings-fields.ts'

/** 运行设置字段表; 语义逐项见 DEFAULT_SETTINGS 的注释. */
interface Settings {
  freeToolSignatureEnabled: boolean; cliTelemetryEnabled: boolean; stripToolsOnSchemaRejection: boolean
  toolCarrierEnabled: boolean
  upstreamChannel: 'legacy' | 'official'; accountSchedulingMode: 'sticky' | 'spread'
  accountMaxConcurrency: number; accountOverflowWaitMs: number; lowBalanceThreshold: number
  blockPremiumModels: boolean; idleReleaseSec?: number; maxNewSessionsPerRequest?: number
}
const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  // 转发上游时是否补齐官方真签名工具(名字 + 真实参数 schema),让上游不把请求
  // 判作第三方客户端并降级.上游 2026-09-17 起要求签名工具[名字 + 真实参数 schema]
  // 判据与对照实验见
  // .agents/notes/implemented/bug-fix/2026-09-19-genuine-tool-signature.md
  freeToolSignatureEnabled: true,
  // 是否上报官方 CLI 形态的遥测(POST codebuff.com/api/logs).
  // 官方 CLI 运行时会发 app_launched / fingerprint_generated / login_started
  // 等生命周期事件;我们从不上报 = 服务端眼里一个"只发 chat,没有任何客户端
  // 生命迹象"的连接.默认关闭:上报等于主动暴露,且端到端尚未验证.
  // 见 .agents/notes/proposed/architecture/2026-09-30-cli-telemetry-reports.md
  cliTelemetryEnabled: false,
  // 上游以 404 "No endpoints found" 拒掉带工具的请求时,是否去掉 tools 重发一次.
  // 默认保留工具语义:上游拒绝就返回错误,不把 agent 请求伪装成成功的纯文本回答.
  // 明确开启时仍可回退到纯文本.见
  // .agents/notes/implemented/bug-fix/2026-10-02-tool-request-fail-closed.md
  stripToolsOnSchemaRejection: false,
  // 第三方工具承载开关(2026-10-05 新增).
  // 开启:下游声明而官方工具集里没有等价物的工具, 包成官方 MCP 形态名字
  // (proxy 加双下划线加原名)随 tools 发出, 回程按映射表拆回下游原名.
  // 官方本来就支持客户端自定义工具, 所以这是上游允许的形态.
  // 关闭:下游工具按旧行为原样发出(上游多半回 503), 用于对照排障.
  // 见 .agents/notes/implemented/architecture/2026-10-05-third-party-tool-carrier.md
  toolCarrierEnabled: true,
  // 上游请求形态通道(2026-10-03 新增):
  //   'legacy'(默认)---- 沿用现有自拼形态(ensureFreebuffSystemMessages +
  //       ensureFreebuffToolSignature + CLI 世代 agent).来源为早期第三方项目
  //       + 多年补丁,已无法与官方逐字段核对,但行为稳定,测试覆盖完整.
  //   'official' ---- 照抄官方客户端抓包真值:官方 37 工具(worker)/ 官方
  //       decide(manager),官方 system 模板,desktop 世代 agent,分层 provider.
  //       见 src/upstream/official-shape.js 与 docs/reverse/14/15/17.
  // 默认 official:与官方客户端抓包逐字段一致,身份/世代不再错配.
  // 回退:控制台[设置 → 上游请求链路]切回 legacy 即可,无需重启.
  upstreamChannel: 'official',
  // 每个账号同一时间可并发的 SSE 响应流数(账号内并发),默认 2.
  // 账号调度是"粘性优先"(drain, not rotate):并发请求先挤同一账号,超过该值
  // 才溢出到下一个账号;从不主动平摊到新账号(上游把轮换健康账号当农场特征,
  // 且 Freebucks 按会话占用时长计费,换号 = 新买一条计费行).
  accountMaxConcurrency: 2,
  // 账号调度模式:
  //   'sticky' = 粘性优先(drain, not rotate):并发上限是溢出阈值----
  //              满员先在该账号上有界排队,排队超时才溢出到下一个账号.
  //              最少换号 = 最少新建计费会话(换号就是新买一条 Freebucks 行).
  //   'spread' = 并发优先:排序时优先有空闲槽位的账号,只在所有账号都
  //              满员时才排队;已用账号仍优先于从未用过的账号,但"已用账号
  //              全满 + 还有未用账号"时允许启用一个未用账号(= 申请新号).
  //              会多预占(N 路并发铺到 M 个账号 = 最多 M 条计费会话),
  //              换来的是不再为并发让请求干等(低提交延迟).
  // 用户场景:并发满了就该开新号(批量/绘图);默认关闭以保持升级不改变行为.
  accountSchedulingMode: 'sticky',
  // 溢出前的最长排队时长(毫秒).sticky 下热会话/冷账号各有自己的等待
  // (见 proxy.chatWaitMs),本值只在 spread 模式生效:账号满员时最多等这么久
  // 就换号,绝不把并发钉死在一个账号上.
  accountOverflowWaitMs: 15_000,
  // 一键屏蔽收费模型(pool=premium,如 gpt-5.6-luna / kimi-k3-eco / 各 -max).
  // 免费反代用户用不了收费模型,放着在列表里既占位又容易误触风控----开/关由
  // 前端[模型管理]一键切换:开启则从 /v1/models 列表和调度(白名单)彻底排除.
  // 默认关闭以保持升级不改变现有行为;免费反代场景建议开启.
  blockPremiumModels: false,
  // [低额度]分组阈值(FB):余额低于它就在控制台归到[低额度]分组----只是分组
  // 展示,不影响调度(这些号照常参与选号,低额度不等于不能用).默认 15 FB,
  // 0 = 关闭该分组.用户要的是[一眼看到快跑完的号],所以阈值可调.
  lowBalanceThreshold: 15,
  // 注意：额度保护两项（idleReleaseSec / maxNewSessionsPerRequest）不写死默认值
  // ——只有用户在控制台保存过才进 settings.json, 否则回落 config.yaml
  // （session.idle_release_sec / limits.max_new_sessions_per_request），
  // 这样"config.yaml 只作兜底默认值"的约定才成立。
})

/** Frontend-managed runtime settings persisted under /data. */
export class SettingsStore {
  declare file: string; declare settings: Settings
  declare loadStatus: 'ok' | 'missing' | 'invalid'; declare loadReason: string | null

  /** @param {string} file e.g. /data/settings.json */
  constructor(file: string) {
    this.file = file
    this.settings = { ...DEFAULT_SETTINGS }
    /** 装载结果('ok' | 'missing' | 'invalid'):损坏时是回落默认值,必须在
     * 启动横幅/自检里说清楚. */
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
      // 结构也一并判:能解析但不是对象(如被写成数组/字符串)同样按损坏处理.
      this.loadReason = st.reason
    }
    if (st.status === 'ok') {
      const raw = st.data
      if (typeof raw?.freeToolSignatureEnabled === 'boolean') {
        this.settings.freeToolSignatureEnabled = raw.freeToolSignatureEnabled
      }
      if (typeof raw?.stripToolsOnSchemaRejection === 'boolean') {
        this.settings.stripToolsOnSchemaRejection = raw.stripToolsOnSchemaRejection
      }
      // 第三方工具承载开关:不读回的话, 控制台关掉它重启后又自己打开
      // (症状与"开关没生效"无法区分), 与上面 cliTelemetryEnabled 同一条纪律.
      if (typeof raw?.toolCarrierEnabled === 'boolean') {
        this.settings.toolCarrierEnabled = raw.toolCarrierEnabled
      }
      //  这个布尔开关必须在这里读回:它能经 save() 写进 settings.json,
      // 但漏读的话重启后一律回落到 DEFAULT_SETTINGS 的 false ---- 表现为
      // [控制台打开了开关,重启就自己关了],症状与"开关没用"无法区分.
      if (typeof raw?.cliTelemetryEnabled === 'boolean') {
        this.settings.cliTelemetryEnabled = raw.cliTelemetryEnabled
      }
      if (Number.isInteger(raw?.accountMaxConcurrency)) {
        this.settings.accountMaxConcurrency = clampConcurrency(raw.accountMaxConcurrency)
      }
      // 只接受两个已知通道,非法值一律回落到 legacy(不静默接受拼写错误)
      if (raw?.upstreamChannel === 'official' || raw?.upstreamChannel === 'legacy') {
        this.settings.upstreamChannel = raw.upstreamChannel
      }
      if (raw?.accountSchedulingMode === 'sticky' || raw?.accountSchedulingMode === 'spread') {
        this.settings.accountSchedulingMode = raw.accountSchedulingMode
      }
      if (Number.isInteger(raw?.accountOverflowWaitMs)) {
        this.settings.accountOverflowWaitMs = clampOverflowWait(raw.accountOverflowWaitMs)
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

  /**
   * 盘上保存过的可调项原始键值(点分路径 -> 值).
   *
   * 与 get() 的区别是刻意的: get() 是运行设置的强类型快照(11 个实时字段,
   * 有默认值); 本方法是 settings.json 里原样存下的可调项(24 项, 无默认值,
   * 没保存过就不该覆盖 config.yaml 的兜底). 实现见 ./tunables-store.ts
   * @returns {Record<string, any>} 已保存的可调项(未保存过则为空对象)
   */
  savedTunables() {
    return readTunables(this.file)
  }

  /**
   * 保存可调项补丁(原样存盘, 与实时字段共存于同一文件).
   * @param {Record<string, any>} patch 点分路径 -> 值
   * @returns {Record<string, any>} 写盘后的可调项
   */
  saveTunables(patch: Record<string, any>) {
    return writeTunables(this.file, patch)
  }

  /**
   * 保存实时字段(只写传了的键 ---- 未传的保持原值).
   *
   * 判据/范围来自 ./settings-fields.ts 的声明表: 新增字段只加一行声明,
   * 不会出现"只改了两处判据、漏掉第三处"的形态(那会变成"没传的字段被清零").
   * @param {Partial<Settings>} next 待保存字段(未传的键不动)
   * @returns {Settings} 保存后的全量设置
   */
  save(next: Partial<Settings>) {
    for (const [key, value] of Object.entries(next || {})) {
      if (value === undefined) continue
      const spec = LIVE_FIELDS[key]
      if (!spec) throw new TypeError(`未知的运行设置字段: ${key}`)
      const r = spec.normalize(value)
      if (!r.ok) throw new TypeError(`${key} ${r.message}`)
      ;(this.settings as any)[key] = r.value
    }
    const settings = { ...this.settings }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...settings }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    this.settings = settings
    return this.get()
  }
}

/** 并发上限:1..16,防止误配造成上游顶号. */
function clampConcurrency(n: number): number {
  return Math.min(16, Math.max(1, n))
}

/**
 * 空闲释放:0(关闭)或 5s..24h.
 * 上游按整小时单价预扣,早退 DELETE 会按实际占用把未用部分退回来
 * (2026-09-13 结论反转,见 docs/design/account-scheduling-and-refund.md §3).所以挂着的
 * 空闲会话是在花钱,默认值应为[短空闲即释放]的 60s.
 * 下限保留 5s:低于 ~5s 等于把每个回合都切成一条新会话,admit 往返次数暴涨.
 */
/**
 * 低额度分组阈值:0(关闭)或 1..10000 FB.上限给足空间(个别模型单价很高),
 * 但别到[所有号都在低额度组里]那种失去意义的地步.
 */
function clampLowBalance(n: number): number {
  if (n <= 0) return 0
  return Math.min(10_000, Math.max(1, n))
}

function clampIdleReleaseSec(n: number): number {
  if (n <= 0) return 0
  return Math.min(86_400, Math.max(5, n))
}

/**
 * 溢出前排队上限:0(不等待,槽位满立即换号)或 1s..10min.
 * 上限压到 10 分钟:调度总预算(schedulingBudgetMs 默认 45s)另有约束,
 * 这里再大也不会真的等那么久,只是给了[宁可排队也不换号]一个上限.
 */
function clampOverflowWait(n: number): number {
  if (n <= 0) return 0
  return Math.min(600_000, Math.max(1_000, n))
}

/** 单请求新会话预算:0(不限制)或 1..16. */
function clampNewSessions(n: number): number {
  if (n <= 0) return 0
  return Math.min(16, Math.max(1, n))
}

export { DEFAULT_SETTINGS }
