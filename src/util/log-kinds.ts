/**
 * 日志分类真源: 颗粒度(kind)与事件类型(event).
 *
 * 日志分两类颗粒度:
 *   - request: 以下游请求为单位聚合. 同一次请求产生的全部日志带同一个 reqId,
 *     控制台按 reqId 归成一组, 能看出"这次请求经历了什么".
 *   - event:   与具体下游请求无关的独立事件(额度刷新 / 账号探测 / 模型获取等).
 *
 * 见 .agents/notes/implemented/process/2026-10-05-log-granularity-constants-and-comment-policy.md
 */

/** 颗粒度: 一次下游请求, 或一个独立事件. */
export type LogKind = 'request' | 'event'

/**
 * 事件类型(仅 kind=event 时有意义).
 *
 * 每个类型都有中英双语文案, 前端按当前语种显示.
 */
export const EVENTS = {
  quotaRefresh: { 'zh-CN': '额度刷新', en: 'Quota refresh' },
  accountProbe: { 'zh-CN': '账号探测', en: 'Account probe' },
  modelFetch: { 'zh-CN': '模型获取', en: 'Model fetch' },
  catalogSync: { 'zh-CN': '目录同步', en: 'Catalog sync' },
  accountImport: { 'zh-CN': '账号导入', en: 'Account import' },
  accountDelete: { 'zh-CN': '账号删除', en: 'Account delete' },
  loginFlow: { 'zh-CN': '登录流程', en: 'Login flow' },
  sessionAdmit: { 'zh-CN': '会话建立', en: 'Session admit' },
  sessionRelease: { 'zh-CN': '会话释放', en: 'Session release' },
  sessionRefund: { 'zh-CN': '退款结算', en: 'Refund settle' },
  sessionHeartbeat: { 'zh-CN': '会话保活', en: 'Session heartbeat' },
  deviceKey: { 'zh-CN': '设备密钥', en: 'Device key' },
  proxyTest: { 'zh-CN': '代理测试', en: 'Proxy test' },
  settingsChange: { 'zh-CN': '设置变更', en: 'Settings change' },
  dataFile: { 'zh-CN': '数据文件', en: 'Data file' },
  system: { 'zh-CN': '系统', en: 'System' },
  telemetry: { 'zh-CN': '遥测上报', en: 'Telemetry' },
} as const

/** 事件类型 key. */
export type LogEvent = keyof typeof EVENTS

/** 全部事件类型 key(校验用). */
export const EVENT_KEYS = Object.keys(EVENTS) as LogEvent[]

/** 颗粒度标签(中英双语, 前端显示). */
export const KINDS = {
  request: { 'zh-CN': '请求', en: 'Request' },
  event: { 'zh-CN': '事件', en: 'Event' },
} as const
