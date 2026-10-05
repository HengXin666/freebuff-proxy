import { normalize } from './session/handles/records.ts'
import {
  dropOrphan,
  dropPendingRefund,
  handleEvent,
  notePendingRefund,
  saveHandles,
} from './session/handles/store-ops.ts'
import { loadHandles } from './session/handles/load.ts'
import { cleanupOrphans, sweepRefunds } from './session/handles/sweeps.ts'

/**
 * 上游会话句柄的持久化索引(/data/sessions.json).
 *
 * 为什么必须有它:Freebuff 的 session 按整小时单价预扣.现行真值(一手实测,
 * 见 docs/account-scheduling-and-refund.md §3.7):
 *   session_units 当场按实际占用比例退;Freebucks 不退.
 *   回执里的 freebucksRefundPending 表示"结算未完成",不等于"会退钱";
 *   重开同一模型会吃 rate_limited + freebucksShortfall.
 * 所以策略是:付费时段内绝不为空闲释放 -- 那一小时已经买断,提前释放只是白扔.
 * 句柄(instanceId)只存在内存里时,一次进程重启 / 换容器 / /data 重挂,活着的会话
 * 就变成无法寻址的孤儿:既删不掉(腾不出槽位),那笔已预扣的钱也永远取不回来
 * (回执必须用同一个 instanceId 重放 DELETE 才能拿到).所以每次 admit/释放都把句柄
 * 落盘,启动时按这份索引扫尾 DELETE 取回执,平时释放失败的句柄也留在里面等下次机会.
 *
 * 文件形如:
 * { version:1, updatedAt, sessions:[{key,instanceId,model,admittedAt,expiresAt}],
 * orphans:[{key,instanceId,model,admittedAt,expiresAt,note}] }
 * sessions = 本进程当前持有的活会话;orphans = DELETE 一直失败,暂时失联但仍
 * 需要继续尝试清理的句柄(绝不静默丢弃).
 *
 * 待结算退款(pendingRefunds)的完整决策与证据见
 * .agents/notes/implemented/bug-fix/2026-09-13-refund-reversed.md.
 *
 * 启动扫尾是有界的:总预算与单次 DELETE 上限在 ./session/handles/sweeps.ts,
 * 超预算的句柄原样留下(信息不丢,只是不挡启动).别把预算删掉"图省事"----
 * 启动被清孤儿卡住是"服务起不来,删 sessions.json 就好"的真实成因
 * (见 .agents/notes/implemented/bug-fix/2026-09-13-startup-path-bounded.md).
 *
 * 本文件保留原路径与全部原有导出名(SessionHandleStore), 实现按职责拆进
 * ./session/handles/**: records(键与归一) / load(装载) / sweeps(两段扫尾).
 */
export class SessionHandleStore {
  declare file: any
  declare sessions: any
  declare orphans: any
  declare pendingRefunds: any
  declare refundRetryTimers: any
  declare _orphanSeen: any
  declare loadStatus: any
  declare loadReason: any
  /**
   * @param {string} file e.g. /data/sessions.json
   */
  constructor(file: any) {
    this.file = file
    /** @type {Map<string, {key:string,instanceId:string,model:string,admittedAt?:string|null,expiresAt?:string|null}>} */
    this.sessions = new Map()
    /** @type {Array<{key:string,instanceId:string,model?:string|null,admittedAt?:string|null,expiresAt?:string|null,note?:string}>} */
    this.orphans = []
    /**
     * 待结算退款队列:{"<key>\0<instanceId>": {key, instanceId, model, attempts,
     * firstSeenAt, lastTriedAt}}.上游回 freebucksRefundPending 时入队,拿到终态
     * 回执(含 0)才出队.
     *
     * 与 orphans 的分工:orphans 记"这个句柄得删"(槽位),本队列记"这笔钱得追"
     * (退款).两者高度重叠但现在都有独立用途----启动扫尾按 orphans 删,周期扫尾
     * 按本队列追问退款.
     */
    this.pendingRefunds = new Map()
    /** 装载结果('ok' | 'missing' | 'invalid').损坏 = 句柄索引丢失 = 上游会话
     * 变成无法寻址的计费孤儿(删不掉,也释放不了槽位,退款也无从追起),必须在启动横幅里点名. */
    this.loadStatus = 'missing'
    this.loadReason = null
    this.load()
  }

  load() {
    return loadHandles(this)
  }

  /**
   * 处理 SessionManager 上报的事件(track / clear / orphan / refund_pending / drop).
   * 实现见 ./session/handles/store-ops.ts 的 handleEvent.
   * @param {any} ev 事件
   * @returns {void} 无返回
   */
  handleEvent(ev: any) {
    handleEvent(this, ev)
  }

  /** 当前活会话(本进程持有). */
  list() {
    return [...this.sessions.values()]
  }

  /** 待清理句柄(含本次与上次进程遗留). */
  listOrphans() {
    return [...this.orphans]
  }

  /** 待结算退款队列(含上次进程遗留). */
  listPendingRefunds() {
    return [...this.pendingRefunds.values()]
  }

  /**
   * 记下一条待结算退款(上游回 freebucksRefundPending).幂等: 只累加 attempts.
   * @param {any} key 账号 key
   * @param {any} instanceId 会话实例 id
   * @param {any} [model] 该会话绑定的模型
   * @returns {void} 无返回
   */
  notePendingRefund(key: any, instanceId: any, model = null) {
    notePendingRefund(this, key, instanceId, model)
  }

  /**
   * 出队(只在拿到终态回执后调用----含退款 0).
   * @param {any} key 账号 key
   * @param {any} instanceId 会话实例 id
   * @returns {boolean} 是否真的移除了记录
   */
  dropPendingRefund(key: any, instanceId: any) {
    return dropPendingRefund(this, key, instanceId)
  }

  /**
   * 移除一条孤儿记录(清理成功后调用).
   * @param {any} instanceId 会话实例 id
   * @returns {void} 无返回
   */
  dropOrphan(instanceId: any) {
    dropOrphan(this, instanceId)
  }

  /**
   * 启动扫尾:对所有遗留句柄发 DELETE 拿退款.失败的原样留在索引里等下次.
   * @param {(key: string) => any} resolveUpstream key → upstream client(可为空)
   * @param {{budgetMs?: number}} [opts] 本次扫尾的总预算(默认 15s)
   * @returns {Promise<{cleaned: number, failed: number, skipped: number, deferred: number}>} 逐类计数
   */
  async cleanupOrphans(resolveUpstream: any, opts: any = {}) {
    return cleanupOrphans(this, resolveUpstream, opts)
  }

  /**
   * 周期扫尾:追问所有待结算退款,拿到终态回执才出队.
   * @param {(key: string) => any} resolveUpstream key → upstream client(可为空)
   * @param {{budgetMs?: number, onSettled?: (info: {key: string, instanceId: string, refund: number | null}) => void}} [opts] 预算与结算回调
   * @returns {Promise<{settled: number, pending: number, failed: number, skipped: number, deferred: number}>} 逐类计数
   */
  async sweepPendingRefunds(resolveUpstream: any, opts: any = {}) {
    return sweepRefunds(this, resolveUpstream, opts)
  }

  /** 把三张表落盘(原子写: tmp + rename, 0o600). 实现见 ./session/handles/store-ops.ts. */
  save() {
    saveHandles(this)
  }
}
