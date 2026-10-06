import fs from 'node:fs'
import path from 'node:path'
import { readJsonFileState, noteDataFile } from '../../../util/json-store.ts'
import { readTunables, writeTunables } from './tunables-store.ts'
import {
  LIVE_FIELDS, clampConcurrency, clampOverflowWait, clampLowBalance,
  clampIdleReleaseSec, clampNewSessions,
} from './settings-fields.ts'

/** 运行设置字段表; 语义逐项见 DEFAULT_SETTINGS 的注释. */
interface Settings {
  freeToolSignatureEnabled: boolean; cliTelemetryEnabled: boolean; stripToolsOnSchemaRejection: boolean
  toolCarrierEnabled: boolean
  upstreamChannel: 'legacy' | 'official'; accountSchedulingMode: 'sticky' | 'spread'
  accountMaxConcurrency: number; accountOverflowWaitMs: number; lowBalanceThreshold: number
  blockPremiumModels: boolean; idleReleaseSec?: number; maxNewSessionsPerRequest?: number
  /**
   * 出站注入哪些官方工具.
   *
   * undefined = 未配置, 全注入(与旧行为一致); [] = 一个都不注入;
   * [名字...] = 只注入这些. 语义唯一真源见 signals/official-tool-select.ts.
   */
  officialToolNames?: string[]
  /**
   * 官方 system 提示词的三态.
   *
   * 为什么单独做一个开关而不是只给个文本框: 官方 worker 模板里点名要求模型
   * 调用 suggest_prompts / write_todos 等下游没有的工具, 用户需要能在
   * [照抄官方] / [换成自己的] / [整段不带] 之间切换并随时回到官方原文.
   * 'official' = 未改过, 用抓包原文; 'custom' = 用 officialSystemPromptText;
   * 'none' = 不带官方 system(下游自己的 system 原样透传).
   *
   * 见 .agents/notes/implemented/bug-fix/2026-10-06-config-passthrough-and-system-prompt-controls.md
   */
  officialSystemPromptMode: 'official' | 'custom' | 'none'
  /** 自定义正文; 只在 mode='custom' 时参与渲染. */
  officialSystemPromptText?: string
  /**
   * 自动签到开关(默认关闭).
   *
   * 间隔固定 25 小时(比 24 多一点, 避开跨时区/夏令时边界上"同一天触发两次").
   * 签到本身要发一条消息, 有成本, 所以默认关闭 ---- 不能替用户默认花钱.
   */
  autoSignInEnabled: boolean
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
  // 出站注入哪些官方工具(2026-10-06 新增). undefined = 未配置 = 全注入:
  // 官方工具集是上游的指纹判据之一, 默认不能动; 只有控制台显式配置过才按名单裁剪.
  // 见 src/upstream/signals/official-tool-select.ts 与控制台[官方工具]页.
  officialToolNames: undefined,
  // 官方 system 提示词: 默认照抄抓包原文(零回归). 见接口注释里的三态说明.
  officialSystemPromptMode: 'official',
  officialSystemPromptText: undefined,
  // 自动签到默认关闭: 它要发消息(有成本), 默认替用户花钱是错的.
  autoSignInEnabled: false,
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

/**
 * 把盘上存过的字段逐个读回默认值快照, 返回合并后的设置.
 *
 * 为什么抽成独立纯函数: 它是 13 个字段的 if 链, 每条都带[为什么必须读回]的
 * 注释(漏读的症状一律是"控制台改了, 重启就自己变回去"), 塞在 load() 里会让
 * 那个方法超函数长度红线, 也让"读回判据"与"装载流程"两件事糊在一起.
 *
 * 判据纪律: 只用[类型 + 取值域]判, 不做静默纠正 ----
 * 非法值落回默认值比接受一个拼错的枚举更安全(见 upstreamChannel 那条).
 *
 * @param {Settings} base 默认值快照
 * @param {any} raw 盘上读出的原始对象
 * @returns {Settings} 合并后的设置
 */
function applyStoredSettings(base: Settings, raw: any): Settings {
  const s: any = { ...base }
  if (typeof raw?.freeToolSignatureEnabled === 'boolean') {
    s.freeToolSignatureEnabled = raw.freeToolSignatureEnabled
  }
  if (typeof raw?.stripToolsOnSchemaRejection === 'boolean') {
    s.stripToolsOnSchemaRejection = raw.stripToolsOnSchemaRejection
  }
  // 第三方工具承载开关: 不读回的话, 控制台关掉它重启后又自己打开
  // (症状与"开关没生效"无法区分).
  if (typeof raw?.toolCarrierEnabled === 'boolean') {
    s.toolCarrierEnabled = raw.toolCarrierEnabled
  }
  // 遥测开关必须读回: 它能经 save() 写进 settings.json, 漏读则重启回落到 false.
  // 白名单读回的纪律与往返回归用例见
  // .agents/notes/implemented/bug-fix/2026-10-01-web-channel-switch-not-persisted.md
  if (typeof raw?.cliTelemetryEnabled === 'boolean') {
    s.cliTelemetryEnabled = raw.cliTelemetryEnabled
  }
  // 官方工具注入名单: 空数组是合法值(一个都不注入), 所以只判是不是数组,
  // 不能用长度判 ---- 用长度判会把[全不注入]读成[未配置], 重启即失效.
  if (Array.isArray(raw?.officialToolNames)) {
    s.officialToolNames = raw.officialToolNames.filter(
      (n: any) => typeof n === 'string' && n,
    )
  }
  // 官方 system 三态同样必须读回(漏读 = 改成自定义后重启又回官方).
  if (raw?.officialSystemPromptMode === 'official'
    || raw?.officialSystemPromptMode === 'custom'
    || raw?.officialSystemPromptMode === 'none') {
    s.officialSystemPromptMode = raw.officialSystemPromptMode
  }
  if (typeof raw?.officialSystemPromptText === 'string') {
    s.officialSystemPromptText = raw.officialSystemPromptText
  }
  // 自动签到开关(漏读 = 开了自动签到, 重启就自己关了).
  if (typeof raw?.autoSignInEnabled === 'boolean') {
    s.autoSignInEnabled = raw.autoSignInEnabled
  }
  if (Number.isInteger(raw?.accountMaxConcurrency)) {
    s.accountMaxConcurrency = clampConcurrency(raw.accountMaxConcurrency)
  }
  // 只接受两个已知通道, 非法值一律回落到 legacy(不静默接受拼写错误).
  if (raw?.upstreamChannel === 'official' || raw?.upstreamChannel === 'legacy') {
    s.upstreamChannel = raw.upstreamChannel
  }
  if (raw?.accountSchedulingMode === 'sticky' || raw?.accountSchedulingMode === 'spread') {
    s.accountSchedulingMode = raw.accountSchedulingMode
  }
  if (Number.isInteger(raw?.accountOverflowWaitMs)) {
    s.accountOverflowWaitMs = clampOverflowWait(raw.accountOverflowWaitMs)
  }
  if (typeof raw?.blockPremiumModels === 'boolean') {
    s.blockPremiumModels = raw.blockPremiumModels
  }
  if (Number.isInteger(raw?.lowBalanceThreshold)) {
    s.lowBalanceThreshold = clampLowBalance(raw.lowBalanceThreshold)
  }
  if (Number.isInteger(raw?.idleReleaseSec)) {
    s.idleReleaseSec = clampIdleReleaseSec(raw.idleReleaseSec)
  }
  if (Number.isInteger(raw?.maxNewSessionsPerRequest)) {
    s.maxNewSessionsPerRequest = clampNewSessions(raw.maxNewSessionsPerRequest)
  }
  return s as Settings
}

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
      // 字段逐个读回的逻辑抽成纯函数: load 本身只剩[装载 + 记录状态],
      // 而每个字段的读回判据与注释集中在一处, 新增字段改那一个函数即可.
      this.settings = applyStoredSettings(this.settings, st.data)
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
   * 不会出现"只改了两处判据,漏掉第三处"的形态(那会变成"没传的字段被清零").
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
export { DEFAULT_SETTINGS }
