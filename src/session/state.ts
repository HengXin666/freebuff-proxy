/**
 * session 域的共享类型与状态容器创建.
 *
 * 状态与行为分开: 构造函数与各子模块共用这一份类型定义, 不必各写一份.
 *
 * 字段名保留原实现的下划线前缀: test/smoke.mjs 直接读 sm._releasePending
 * 与调 sm._armIdleRelease(), 改名会打断既有判据.
 */

/** 上游会话句柄(本地账本里的一条已付费会话). */
export interface SessionHandle {
  status: string
  instanceId?: string | null
  model?: string | null
  admittedAt?: string | null
  expiresAt?: string | null
  remainingMs?: number | null
  accessTier?: string | null
  raw?: any
}

/** 上游会话清单里的一条购买记录. */
export interface DesktopPurchase {
  model?: string | null
  expiresAt?: string | null
  holderInstanceId?: string | null
  [k: string]: any
}

/** 一条已结算的退款流水. */
export interface RefundEntry {
  instanceId: string
  model: string | null
  refund: number | null
  expected: number | null
  expectedUnits: number | null
  price: number | null
  holdMs: number | null
  replayed?: boolean
  at: string
}

/** 会话句柄变化事件(track / orphan / drop / clear / refund_pending). */
export interface SessionEvent {
  type: string
  key: string | null
  instanceId?: string | null
  model?: string | null
  admittedAt?: string | null
  expiresAt?: string | null
}

/**
 * SessionManager 的可变状态.
 *
 * 每个字段都保留原实现里的语义: 拆分本身不改行为, 只改代码位置,
 * 因此这里刻意不"顺手"收紧成更窄的类型 -- 那会与运行时真值漂移.
 */
export interface SessionState {
  /** 模型标识归一函数(目录 key / 上游 id / 可读名 -> 目录 key). */
  resolveModelAlias: ((v: any) => any) | null
  /** 会话实例 id: 裸 UUID, 整个进程生命周期内复用同一个. */
  instanceId: string
  /** 上游的会话清单快照(每次 _absorbInventory 从回执刷新). */
  desktopPurchases: DesktopPurchase[]
  /** 上游的活跃会话计数(premium / unlimited / nextExpiryAt). */
  desktopSessionCounts: any
  /** 上游的退款记录(对账用). */
  desktopRefunds: any[]
  /** 账号标识(sessions.json 里的 owner key). */
  accountKey: string | null
  /** 日志上下文(account/key), 本 Manager 产生的每条日志都自动带上. */
  _logContext: Record<string, any> | null
  /** 句柄变更回调(落盘 /data/sessions.json). */
  _onSessionChange: ((entry: SessionEvent) => void) | null
  /** [账号账目变了]回调(freebucks / quota / lastProbe / schedulingMs). */
  _onStateChange: ((patch: any) => void) | null
  /** [有人正排队要用这个账号]的判定(账号级 chat 锁在途/排队). */
  _hasPendingUser: () => boolean
  /** 控制台[额度保护]设置(settings.json)实时覆盖 config.yaml. */
  _getSessionSettings: (() => any) | null
  /** 本地账本里的当前会话. */
  session: SessionHandle | null
  /** 最近一次带 rateLimitsByModel 的回执里的每模型每日额度. */
  quota: { byModel: Record<string, any>, rateLimit: any, updatedAt: string } | null
  /** Freebucks 计量块. */
  freebucks: any
  /** 最近一次早退 DELETE 的回执(控制台展示/排查用). */
  lastRefund: RefundEntry | null
  /** 最近一次探测(refresh GET)的结果. */
  lastProbe: any
  /** 本进程是否已经拿到过上游会话清单快照. */
  _inventorySeen: boolean
  /** 当前正在处理中的请求数(在途 chat 时跳过轮询 GET). */
  _inFlight: number
  /** 本账号本轮连续调度的开始时刻(epoch ms). */
  _schedulingSince: number | null
  /** 成功新建的上游会话计数(每次 POST /session 成功 +1). */
  admitCount: number
  /** 复用热 session 的次数. */
  reuseCount: number
  /** 正在早退 DELETE(空闲释放/换号释放): 期间不得被选号复用. */
  _releasing: boolean
  /** 释放失败待重试: true = session 里仍留着 instanceId. */
  _releasePending: boolean
  /** 已连续重试次数(成功后清零). */
  _releaseRetries: number
  /** 待结算退款(上游回 freebucksRefundPending 时的 instanceId). */
  _pendingRefundInstanceId: string | null
  /** 本轮退款追问窗口的起点. */
  _refundRetryStartedAt: number | null
  /** 等待在途请求归零的监听器. */
  _idleWaiters: Array<() => void>
  /** 序列化 admit / release 的互斥链. */
  _mutex: Promise<void>
  /** 空闲自动释放定时器. */
  _idleTimer: any
  /** 退款追问定时器. */
  _refundRetryTimer: any
  /** 释放重试定时器. */
  _releaseRetryTimer: any
  /** 会话轮询定时器. */
  _pollTimer: any
}

/**
 * 建一份空的会话状态.
 *
 * 集中在这里建: 三十多个字段一次列全, 构造函数只剩"注入依赖 + 建状态";
 * 改字段时不会漏掉某一处赋值.
 * @param {object} opts 构造参数(见 SessionManager 的 constructor)
 * @returns {SessionState} 初始状态
 */
export function createSessionState(opts: any): SessionState {
  /**
   * 注意: instanceId 不在这里生成.
   *
   * 原实现在构造函数里调 newRawInstanceId(), 那是上游指纹模块的能力.
   * 状态容器刻意保持"纯数据", 由 SessionManager 的构造函数注入生成结果,
   * 这样本文件不依赖上游模块, 也不会被误当成有副作用的工厂.
   */
  const state: SessionState = {
    resolveModelAlias:
      typeof opts.resolveModelAlias === 'function' ? opts.resolveModelAlias : null,
    instanceId: opts.instanceId,
    desktopPurchases: [],
    desktopSessionCounts: null,
    desktopRefunds: [],
    accountKey: opts.accountKey ?? null,
    _logContext:
      opts.logContext && typeof opts.logContext === 'object'
        ? opts.logContext
        : null,
    _onSessionChange:
      typeof opts.onSessionChange === 'function' ? opts.onSessionChange : null,
    _onStateChange:
      typeof opts.onStateChange === 'function' ? opts.onStateChange : null,
    _hasPendingUser:
      typeof opts.hasPendingUser === 'function' ? opts.hasPendingUser : () => false,
    _getSessionSettings:
      typeof opts.getSessionSettings === 'function' ? opts.getSessionSettings : null,
    session: null,
    quota: null,
    freebucks: null,
    lastRefund: null,
    lastProbe: null,
    _inventorySeen: false,
    _inFlight: 0,
    _schedulingSince: null,
    admitCount: 0,
    reuseCount: 0,
    _releasing: false,
    _releasePending: false,
    _releaseRetries: 0,
    _pendingRefundInstanceId: null,
    _refundRetryStartedAt: null,
    _idleWaiters: [],
    _mutex: Promise.resolve(),
    _idleTimer: null,
    _refundRetryTimer: null,
    _releaseRetryTimer: null,
    _pollTimer: null,
  }
  return state
}

/**
 * 把状态字段装到实例上, 并挂上注入依赖(upstream / config).
 *
 * 各子域模块通过 Object.assign 挂到 SessionManager.prototype 上, 因此这里
 * 只需要保证字段名与状态容器完全一致.
 * @param {any} self 目标实例
 * @param {SessionState} state 初始状态
 * @param {object} deps 注入依赖(upstream / config)
 * @returns {any} self
 */
export function installSessionState(
  self: any,
  state: SessionState,
  deps: any,
): any {
  for (const [k, v] of Object.entries(state)) self[k] = v
  self.upstream = deps.upstream
  self.config = deps.config
  return self
}
