/** 运行设置(实时字段)的完整形态; 语义逐项见 settings-store.ts 的 DEFAULT_SETTINGS 注释. */
export interface SettingsShape {
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
  /**
   * 思考强度覆盖(默认关闭): 开启后忽略下游传来的档位, 按模型发配置的档位.
   *
   * 形态与判定真源见 src/proxy/reasoning-effort.ts 与
   * .agents/notes/implemented/feature/2026-10-06-reasoning-effort-override.md.
   */
  reasoningOverride?: ReasoningOverride
}

/**
 * 运行设置(实时字段)的字段声明与校验.
 *
 *
 * SettingsStore.save() 原先是一段 ~100 行的 if 链: 每个字段都写三遍
 * (判 undefined / 判类型 / 赋值). 新增一个字段要改三处, 而**漏掉"判 undefined"
 * 那一遍**的后果最隐蔽 ---- 它会变成"没传这个字段也被当成要清零", 于是
 * 保存任一设置都会把其它设置抹掉.
 *
 * 收成"声明表 + 一次遍历"之后: 新增字段只加一行声明, 三处判据都从声明派生,
 * 结构上不可能只改两处.
 *
 * 与 src/config/tunables.ts 的分工:
 *   - 本文件 = 实时字段(裸名, 保存即生效, 有默认值);
 *   - tunables.ts = 可调项(点分路径, 保存后重启生效, 无默认值).
 * 两套东西分开的理由见 ../tunables-store.ts 的文档注释.
 */

import {
  isReasoningOverrideShape, normalizeReasoningOverride, type ReasoningOverride,
} from '../../../proxy/reasoning-effort.ts'

/** 字段规格: key -> 取值器(返回 null 表示合法). */
export interface LiveFieldSpec {
  /** 归一化/校验; 合法则返回归一后的值, 非法则返回错误文案. */
  normalize: (v: unknown) => { ok: true; value: any } | { ok: false; message: string }
}

const ok = (value: any) => ({ ok: true as const, value })
const err = (message: string) => ({ ok: false as const, message })

  /**
   * 并发上限:1..16,防止误配造成上游顶号.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampConcurrency(n: number): number {
  return Math.min(16, Math.max(1, n))
}

  /**
   * 溢出前排队上限: 0(不等待)或 1s..10min.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampOverflowWait(n: number): number {
  if (n <= 0) return 0
  return Math.min(600_000, Math.max(1_000, n))
}

  /**
   * 低额度分组阈值: 0(关闭)或 1..10000 FB.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampLowBalance(n: number): number {
  if (n <= 0) return 0
  return Math.min(10_000, Math.max(1, n))
}

  /**
   * 空闲释放: 0(关闭)或 5s..24h.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampIdleReleaseSec(n: number): number {
  if (n <= 0) return 0
  return Math.min(86_400, Math.max(5, n))
}

  /**
   * 单请求新会话预算: 0(不限制)或 1..16.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampNewSessions(n: number): number {
  if (n <= 0) return 0
  return Math.min(16, Math.max(1, n))
}

/** 布尔字段的规格. */
const bool = (): LiveFieldSpec => ({
  normalize: (v) => (typeof v === 'boolean' ? ok(v) : err('必须是布尔值')),
})

/**
 * 字符串数组字段的规格(元素必须全是字符串; 允许空数组).
 *
 * 去重并丢掉空串: 控制台多选列表不会产生重复, 但 settings.json 是手可编辑的,
 * 重复项会让下游的判据集合变成不确定的大小.
 */
const stringArray = (): LiveFieldSpec => ({
  normalize: (v) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string')
      ? ok([...new Set(v as string[])].filter(Boolean))
      : err('必须是字符串数组'),
})

/** 整数 + 夹取字段的规格. */
const intClamped = (clamp: (n: number) => number, min: number): LiveFieldSpec => ({
  normalize: (v) =>
    Number.isInteger(v) && (v as number) >= min ? ok(clamp(v as number)) : err(`必须是 >= ${min} 的整数`),
})

/** 枚举字段的规格. */
const oneOf = (values: string[]): LiveFieldSpec => ({
  normalize: (v) => (values.includes(v as string) ? ok(v) : err(`必须是 ${values.join(' / ')} 之一`)),
})

/**
 * 自由文本字段的规格(只在超过上限时拒绝).
 *
 * 官方 system 提示词的自定义正文用它: 内容不做语义校验(用户可能想贴任何
 * 指令), 只卡长度 ---- 上限取 200000, 远高于官方模板的 13KB, 又能在误贴
 * 整份文件时给出明确错误而不是让请求体爆掉.
 */
const freeText = (max: number): LiveFieldSpec => ({
  normalize: (v) => (typeof v === 'string' && v.length <= max
    ? ok(v)
    : err(`必须是长度不超过 ${max} 的字符串`)),
})

/**
 * 思考强度覆盖字段的规格: 开关 + 逐模型档位表.
 *
 * 形态由 src/proxy/reasoning-effort.ts 的 isReasoningOverrideShape 判定; 通过后
 * 原样存盘(不做二次归一, 归一发生在装载与消费点).
 */
const reasoningOverride = (): LiveFieldSpec => ({
  normalize: (v) => (isReasoningOverrideShape(v)
    ? ok(normalizeReasoningOverride(v))
    : err('必须是 { enabled, models: [{ model, effort }] } 形态')),
})

/**
 * 实时字段表(与 Settings 接口一一对应).
 *
 */
export const LIVE_FIELDS: Record<string, LiveFieldSpec> = {
  freeToolSignatureEnabled: bool(),
  stripToolsOnSchemaRejection: bool(),
  toolCarrierEnabled: bool(),
  officialToolNames: stringArray(),
  cliTelemetryEnabled: bool(),
  blockPremiumModels: bool(),
  accountMaxConcurrency: intClamped(clampConcurrency, 1),
  accountOverflowWaitMs: intClamped(clampOverflowWait, 0),
  lowBalanceThreshold: intClamped(clampLowBalance, 0),
  idleReleaseSec: intClamped(clampIdleReleaseSec, 0),
  maxNewSessionsPerRequest: intClamped(clampNewSessions, 0),
  upstreamChannel: oneOf(['official', 'legacy']),
  accountSchedulingMode: oneOf(['sticky', 'spread']),
  officialSystemPromptMode: oneOf(['official', 'custom', 'none']),
  officialSystemPromptText: freeText(200_000),
  // 自动签到开关(默认关闭). 间隔固定 25 小时, 见 store/signin/store.ts.
  autoSignInEnabled: bool(),
  // 思考强度覆盖(默认关闭). 见 src/proxy/reasoning-effort.ts.
  reasoningOverride: reasoningOverride(),
}

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
 * @param {SettingsShape} base 默认值快照
 * @param {any} raw 盘上读出的原始对象
 * @returns {SettingsShape} 合并后的设置
 */
export function applyStoredSettings(base: SettingsShape, raw: any): SettingsShape {
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
  // 思考强度覆盖(漏读 = 配了档位, 重启就自己关了). 逐项校验后归一.
  if (raw?.reasoningOverride && typeof raw.reasoningOverride === 'object') {
    s.reasoningOverride = normalizeReasoningOverride(raw.reasoningOverride)
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
  return s as SettingsShape
}
