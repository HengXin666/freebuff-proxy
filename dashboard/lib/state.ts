/**
 - 控制台共享状态 ---- 唯一的可变状态容器,被所有视图模块读写.
 *
 *

 */
/**
 - 控制台状态对象的类型.
 *
 */
export interface DashboardState {
  me: any
  accounts: any[]
  users: any[]
  models: any[]
  flows: any[]
  proxies: any[]
  version: any
  lowBalanceThreshold: number
  acctSectionsOpen: Record<string, any>
  upstreamModelIds: string[]
  modelNames: Record<string, string>
  upstreamModels: any[]
  [k: string]: any
}

/** 控制台共享状态(唯一实例). */
export const state: DashboardState = {
  me: null,
  accounts: [],
  users: [],
  models: [],
  flows: [],
  proxies: [],
  version: null,
  lowBalanceThreshold: 15,
  /**
   - 分区展开/折叠记忆(分区 id → 是否展开).
   - 局部刷新不能重置它:用户手动摊开"额度不足"看细节,一次刷新就折回去
   - 等于把界面状态当垃圾扔掉(用户明确要求"不要重置当前分组展开和折叠的状态").
   - 记录在内存里而不是读 DOM:分区可能因为这一轮没有任何账号而暂时消失,
   - 消失期间也要记住用户的偏好,等账号回来时按原样展开.
   */
  acctSectionsOpen: {},
  /** 上游此刻真实给出额度的模型 id(多账号并集),测试对话据此标注. */
  upstreamModelIds: [],
  /**
   - 目录 key(m-00032eaeec)→ 可读显示名(MiMo 2.6 Flash).
   *
   - 账号表的 session 列与[额度]chip 的数据源都是上游回执,键全是不透明
   - 目录 key;后端把这一屏用到的映射随 /api/overview 一起下发,前端只管查表.
   - 查不到就回落原 key ---- 绝不因为取不到名字让整行渲染失败.
   */
  modelNames: {},
  /**
   - 上游此刻给了额度的模型的[可读三件套]:{key, displayName, catalogId}.
   - /api/models 的 id 是可读名(口径 = displayName || key,与后端
   - catalogDisplayName() 同源),而 upstreamModelIds 是目录 key ----
   - 标注  时必须用这张表换算,否则永远对不上.
   */
  upstreamModels: [],
}
