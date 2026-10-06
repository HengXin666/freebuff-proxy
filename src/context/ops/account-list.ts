/**
 * 控制台账号列表: 每行把账本(生命周期/时间轴/退款), 运行时(会话/额度),
 * 调度状态(负载/预留)合成一份只读视图.
 *
 * 它与 candidateKeys 是同一个账号池的两种视角: 这边给人看, 那边给调度用.
 * 两边使用同一套判据(available / banned / unavailable), 因此分档逻辑集中在这里,
 * 调度侧只取冷却状态.
 */
import { listAccounts } from '../../auth-store.ts'
import {
  DEFAULT_COOLDOWN_MS,
  UNAVAILABLE_COOLDOWN_CODES,
} from '../state/codes.ts'

/**
 * 该账号当前会话的展示视图(控制台账号行的 session 字段).
 *
 * 每个字段都对应一个前端判定: expiresAt 供付费时段判定, inPaidWindow 供"这一小时
 * 已买给哪个模型"标注, inventory 供跨部署可见的会话清单.
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
     * 仍在这一小时已付费时段内.
     *
     * 这条会话只服务于它绑定的那个模型, 换任何别的模型都会被拒.
     * 带上这个布尔, 前端才能在账号行上如实标注"这一小时已买给模型 X".
     * 判不出来的会话(无 expiresAt)返回 false = 不标注.
     */
    inPaidWindow: rt?.sessions?.inPaidWindow?.() === true,
    /**
     * 上游的会话清单(跨部署可见).
     *
     * 数据来自 GET /session 回执的 desktopPurchases /
     * desktopSessionCounts(每次 admit/refresh 都会随回执刷新).
     * 前端据此显示"哪个模型被谁占着, 什么时候到期".
     */
    inventory: snap.inventory || null,
  }
    : null
}

/**
 * 只来自持久化账本的那批字段: 生命周期 / 时间轴 / 退款流水.
 *
 * 单独成函数是为了把 row 装配留在 buildAccountRow 里, 而账本口径集中在一处
 * (账本字段与运行时字段是两类来源, 混在一张长对象字面量里读不出边界).
 * @param {any} self 账号池(runtimes)
 * @param {string} key 账号 key
 * @param {any} rec 该账号的账本记录
 * @returns {any} 账本字段块
 */
function ledgerFields(self: any, key: any, rec: any): any {
  return {
    firstSeenAt: rec?.firstSeenAt || null,
    bannedAt: rec?.bannedAt || null,
    refunds: self.accountState.refunds(key).slice(0, 20),
    refundTotal: rec?.refundTotal ?? 0,
    refundExpectedTotal: rec?.refundExpectedTotal ?? 0,
    refundPendingCount: rec?.refundPendingCount ?? 0,
    refundUnitsExpectedTotal: rec?.refundUnitsExpectedTotal ?? 0,
    importedAt: rec?.importedAt || rec?.firstSeenAt || null,
    credentialUpdatedAt: rec?.credentialUpdatedAt || null,
    scheduledMs: Number(rec?.scheduledMs) || 0,
    schedulingSince: rec?.schedulingSince || null,
    lastScheduledAt: rec?.lastScheduledAt || null,
  }
}

/**
 * 把单个账号的账本/运行时/调度状态合成列表行.
 *
 * 一行要合并三处来源(持久化账本, 运行时快照, 调度锁).
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
    /**
     * 用 runtimeFor 而不是 byKey.get: 后者是裸读 Map, 绕过懒创建, 于是
     * freebucks / quota / lastProbe(由 _hydrateRuntime 从账本回灌)在服务重启
     * 后的首屏全是 null ---- 用户要手动刷新一次才看得到上次缓存的账号状态.
     * runtimeFor 会按需建 runtime 并完成回灌, 且拿不到凭据时返回 null 而不是抛.
     * 见 src/context/ops/account-runtime.ts 的 runtimeFor.
     */
    /**
     * 参与调度开关: 读账本(不是 runtime), 与选号时的判据同一个字段.
     * 关掉它的账号在 accounts 列表里排在分区末尾, 但仍按原有分区逻辑归类.
     */
    const schedulingOn = self.schedulingEnabled(a.key)
    const rt = self.runtimeFor(a.key)
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
// 参与调度开关(控制台每个账号一行): false 表示用户手动把它排除在选号之外.
schedulingEnabled: schedulingOn,
status: banned ? 'banned' : unavailable ? 'unavailable' : 'ok',
cooldownUntil: cooling ? new Date(cd.until).toISOString() : null,
cooldownCode: cooling ? cd.code : null,
requests: self.stats.byKey.get(a.key) || 0,
// 账本口径(生命周期 / 时间轴 / 退款流水).
...ledgerFields(self, a.key, rec),
// 是否用过(粘性调度: 未用过的排最后) + 最近使用时间.
used: self.everUsed(a.key),
lastUsedAt: self._lastUsedAt.has(a.key)
  ? new Date(self._lastUsedAt.get(a.key)).toISOString()
  : null,
currentSchedulingMs: rt?.sessions?.currentSchedulingMs?.() || 0,
// 负载均衡监控: 在途 SSE 流数 / 并发上限.
inFlight: chatLock?.inFlight || 0,
reserved: self.reservedCount(a.key),
effectiveLoad: (chatLock?.inFlight || 0) + self.reservedCount(a.key),
concurrency: chatLock?.capacity || self._accountConcurrency(),
effectiveProxy: rt?.effectiveProxy || null,
// 最近一次探测结果.
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
