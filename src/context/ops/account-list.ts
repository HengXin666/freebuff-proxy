/**
 * 控制台账号列表: 每行把账本(生命周期/时间轴/退款), 运行时(会话/额度),
 * 调度状态(负载/预留)合成一份只读视图.
 *
 * 从 app-context.js 按职责切出. 它与 candidateKeys 是同一个账号池的两种视角:
 * 这边给人看, 那边给调度用. 两边必须用同一套判据(available / banned /
 * unavailable), 因此分档逻辑集中在这里, 调度侧只取冷却状态.
 */
import { listAccounts } from '../../auth-store.ts'
import {
  DEFAULT_COOLDOWN_MS,
  UNAVAILABLE_COOLDOWN_CODES,
} from '../state/codes.ts'

/**
 * 该账号当前会话的展示视图(控制台账号行的 session 字段).
 *
 * 从 buildAccountRow 抽出(原对象字面量里的 session 段 42 行). 这一段的每个字段
 * 都对应一个前端判定: expiresAt 供付费时段判定, inPaidWindow 供"这一小时已买给
 * 哪个模型"标注, inventory 供跨部署可见的会话清单.
 * @param {any} self 账号池(runtimes)
 * @param {any} rt 账号 runtime(可能未创建)
 * @param {any} snap 会话快照(getSnapshot 的结果)
 * @returns {any | null} 会话展示视图; 无会话时 null
 */
function sessionViewOf(self: any, rt: any, snap: any): any {
  return snap
    ? {
    status: snap.status,
    model: snap.model,
    // 回执里的 model 是目录 key(m-00032eaeec);控制台要显示
    // 人能认的名字(MiMo 2.6 Flash).这个字段只用于展示 ----
    // 请求/寻址仍必须用 snap.model(key 本身).
    // 桥接依据见
    // .agents/notes/implemented/bug-fix/2026-10-02-catalog-key-display-name-bridge.md
    modelDisplayName: snap.model
      ? self._modelDisplayName(snap.model)
      : null,
    remainingMs: snap.remainingMs,
    live: snap.live,
    // 付费时段的终点:一次 admit = 买断一小时,控制台据此区分
    // "rem=0 但仍可用(已付款)"与"真的用尽",别再误报额度不足.
    expiresAt: snap.expiresAt || null,
    admittedAt: snap.admittedAt || null,
    /**
     *  仍在这一小时已付费时段内.
     *
     * 控制台此前只暴露 status/live/expiresAt,于是这条会话显示成
     * "正常" ---- 但它只服务于它绑定的那个模型,换任何别的模型
     * 都会被拒(实测 purchase_claim_released,且接不回来).
     *
     * 带上这个布尔,前端才能在账号行上如实标注"这一小时已买给
     * 模型 X",而不是让用户对着 status=ok 去查一个根本没坏的东西.
     * 判不出来的会话(无 expiresAt)返回 false = 不标注.
     */
    inPaidWindow: rt?.sessions?.inPaidWindow?.() === true,
    /**
     *  上游的会话清单(跨部署可见)---- 用户诉求:[即便分布式部署,
     * 你在本地建的会话,我在远程也能读到].
     *
     * 数据来自 GET /session 回执的 desktopPurchases /
     * desktopSessionCounts(每次 admit/refresh 都会随回执刷新).
     * 前端据此显示"哪个模型被谁占着,什么时候到期".
     */
    inventory: snap.inventory || null,
  }
    : null
}

/**
 * 把单个账号的账本/运行时/调度状态合成列表行.
 *
 * 从 list 的 map 回调抽出(原回调 131 行): 一行要合并三处来源(持久化账本,
 * 运行时快照, 调度锁), 抽出来之后 list 只剩"取账号 -> 逐行构建".
 * @param {any} this 账号池(runtimes)
 * @param {any} self 账号池(runtimes)
 * @param {any} a 凭据行({ key, email, ... })
 * @param {number} now 当前时间戳(冷却判定基准)
 * @returns {any} 控制台用的账号行
 */
function buildAccountRow(self: any, a: any, now: number): any {

    const cd = self.cooldowns.get(a.key)
    const cooling = Boolean(cd && cd.until > now)
    // 三档: banned(不可自恢复) / unavailable(暂时被拒) / ok.
    const coolingCode = cooling ? cd.code || null : null
    const banned =
Boolean(self.accountState.account(a.key)?.bannedAt) || coolingCode === 'banned'
    const unavailable =
banned || (cooling && UNAVAILABLE_COOLDOWN_CODES.has(coolingCode))
    const rt = self.byKey.get(a.key)
    const snap = rt?.sessions?.getSnapshot?.()
    const chatLock = self.chatLocks.get(a.key)
    // 账本记录(生命周期/时间轴):account() 会按需创建并盖上导入时间.
    const rec = self.accountState.account(a.key, self._importedAtHint(a.key))
    return {
...a,
lastUsed: self._lastSuccessKey === a.key,
// available 保持原语义; banned / unavailable 是更细粒度分档.
available: !cooling,
banned,
unavailable,
status: banned ? 'banned' : unavailable ? 'unavailable' : 'ok',
cooldownUntil: cooling ? new Date(cd.until).toISOString() : null,
cooldownCode: cooling ? cd.code : null,
requests: self.stats.byKey.get(a.key) || 0,
// 生命周期(持久化): 加入时间 / 封禁时间.
firstSeenAt:
  self.accountState.account(a.key, self._importedAtHint(a.key))
    ?.firstSeenAt || null,
bannedAt: self.accountState.account(a.key)?.bannedAt || null,
refunds: self.accountState.refunds(a.key).slice(0, 20),
refundTotal: self.accountState.account(a.key)?.refundTotal ?? 0,
refundExpectedTotal:
  self.accountState.account(a.key)?.refundExpectedTotal ?? 0,
refundPendingCount:
  self.accountState.account(a.key)?.refundPendingCount ?? 0,
// units 口径应退(与 Freebucks 的 expectedTotal 是两本账).
refundUnitsExpectedTotal:
  self.accountState.account(a.key)?.refundUnitsExpectedTotal ?? 0,
// 是否用过(粘性调度: 未用过的排最后) + 最近使用时间.
used: self.everUsed(a.key),
lastUsedAt: self._lastUsedAt.has(a.key)
  ? new Date(self._lastUsedAt.get(a.key)).toISOString()
  : null,
// 时间轴(持久化): importedAt / credentialUpdatedAt / scheduledMs.
importedAt: rec?.importedAt || rec?.firstSeenAt || null,
credentialUpdatedAt: rec?.credentialUpdatedAt || null,
scheduledMs: Number(rec?.scheduledMs) || 0,
schedulingSince: rec?.schedulingSince || null,
lastScheduledAt: rec?.lastScheduledAt || null,
currentSchedulingMs: rt?.sessions?.currentSchedulingMs?.() || 0,
// 负载均衡监控: 在途 SSE 流数 / 并发上限.
inFlight: chatLock?.inFlight || 0,
reserved: self.reservedCount(a.key),
effectiveLoad: (chatLock?.inFlight || 0) + self.reservedCount(a.key),
concurrency: chatLock?.capacity || self._accountConcurrency(),
effectiveProxy: rt?.effectiveProxy || null,
// 最近一次探测结果(为什么刷新失败).
lastProbe: snap?.lastProbe || null,
    session: sessionViewOf(self, rt, snap),
quota: snap?.quota || null,
// Freebucks 计量: 余额 / 每日池 / 每模型单价.
freebucks: snap?.freebucks || null,
lastRefund: snap?.lastRefund || null,
// 复用率证据: reuseCount / (reuseCount + admitCount).
admitCount: snap?.admitCount ?? 0,
reuseCount: snap?.reuseCount ?? 0,
  }
}

/**
 * 控制台账号列表(只读视图).
 *
 * 每行由 buildAccountRow 合成: 账本(生命周期/时间轴/退款) + 运行时(会话/额度)
 * + 调度状态(负载/预留). 它与选号是同一账号池的两种视角, 共用同一份冷却表.
 * @param {any} this 账号池(runtimes)
 * @returns {any[]} 账号行数组
 */
export function list(this: any): any[] {
  const now = Date.now()
  return listAccounts(this.dir).map((a: any) => buildAccountRow(this, a, now))
}
