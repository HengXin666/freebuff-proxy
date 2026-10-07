/**
 * 会话快照与上游清单吸收: 控制台读的那份只读视图.
 *
 * 从 session-manager.js 的 getSnapshot / knownInstances / inFlightCount /
 * hasInventorySnapshot / _absorbInventory / holderFor 切出.
 *
 * 这一层是只读的(除了 _absorbInventory 写入清单快照), 因此与 admit/release
 * 分开后, "谁占着槽位"这条跨部署可见的链路可以单独审查.
 */
import type { DesktopPurchase } from '../state.ts'

/**
 * 控制台读的会话快照.
 * @returns {any} 快照对象
 * @param {any} this 会话实例
 */
export function getSnapshot(this: any): any {
  const s = this.session
  // admit/reuse 计数: 让控制台能显示"这个号买了几条, 复用了几次" --
  // 复用是零成本的(买断的一小时内), 这个比例直接就是省下的重买次数.
  const counts = {
    admitCount: this.admitCount,
    reuseCount: this.reuseCount,
  }
  /**
   * 上游的会话清单一并带进快照 -- 前端据此显示"这一小时买给了谁,
   * 什么时候到期", 从而分布式部署下能看到对方建的会话(用户诉求).
   * 见 _absorbInventory 与 holderFor.
   */
  const inventory = {
    purchases: this.desktopPurchases || [],
    sessionCounts: this.desktopSessionCounts || null,
  }
  /**
   * 最近一次刷新是否因[有在途请求]被跳过.
   *
   * 带出去是为了让控制台把"这次刷新没真的问上游"如实告诉用户 ----
   * 否则界面只是显示一份旧快照, 用户以为拿到了新值(两次刷新两个版本).
   */
  const probeSkipped = this.lastProbeSkipped || null
  if (!s) {
    return {
      status: 'none',
      quota: this.quota,
      freebucks: this.freebucks,
      lastRefund: this.lastRefund,
      lastProbe: this.lastProbe,
      probeSkipped,
      inventory,
      ...counts,
    }
  }
  const remainingMs =
    s.expiresAt != null
      ? Math.max(0, Date.parse(s.expiresAt) - Date.now())
      : s.remainingMs
  return {
    ...s,
    remainingMs,
    live: this.hasLiveSlot(s),
    quota: this.quota,
    freebucks: this.freebucks,
    lastRefund: this.lastRefund,
    lastProbe: this.lastProbe,
    probeSkipped,
    inventory,
    ...counts,
  }
}

/**
 * 当前在途请求数(监控/优雅释放用).
 * @returns {number} 在途请求数
 * @param {any} this 会话实例
 */
export function inFlightCount(this: any): number {
  return this._inFlight
}

/**
 * 该账号当前仍活着的上游 instance id(含一次也没删掉的句柄).
 * @returns {string[]} 活跃 instance id 列表
 * @param {any} this 会话实例
 */
export function knownInstances(this: any): string[] {
  const s = this.session
  if (!this.hasLiveSlot(s)) return []
  return [s.instanceId]
}

/**
 * 本进程是否已经拿到过上游会话清单快照.
 *
 * 用于区分"从没对过账"与"对过账但这次没命中" -- 前者不该为了让某个
 * 尚未决定购买的请求去探测(那个 GET 在官方建会话路径上会建出会话).
 * @returns {boolean} 拿到过清单则为真
 * @param {any} this 会话实例
 */
export function hasInventorySnapshot(this: any): boolean {
  return this._inventorySeen === true
}

/**
 * 吸收上游回执里的会话清单(官方 absorbRefunds / desktopPurchases 同源).
 *
 * 上游 GET /session(任何 status, 包括 none)都会带:
 *   desktopPurchases     -- 谁占着哪个模型的槽位(含 holderInstanceId / expiresAt)
 *   desktopSessionCounts -- 活跃会话计数(premium / unlimited / nextExpiryAt)
 *   desktopRefunds       -- 退款记录(对账用)
 *
 * 这是跨部署可见的唯一真源: 本地账本各记各的, 而这份清单列出全部
 * 持有者(含别的部署建的会话) -- 于是"我在本地建的会话, 远程也能看到".
 * 见 .agents/notes/implemented/architecture/2026-10-04-session-inventory-from-upstream.md.
 * @param {any} this 会话实例
 * @param {any} body 上游回执
 * @returns {void}
 */
export function _absorbInventory(this: any, body: any): void {
  if (!body || typeof body !== 'object') return
  // 只要收到过上游回执(任何 status), 就说明"对过账"了 -- 见 hasInventorySnapshot.
  if (Array.isArray(body.desktopPurchases)) this._inventorySeen = true
  const purchases = Array.isArray(body.desktopPurchases)
    ? body.desktopPurchases.filter(
        (p: any) =>
          p &&
          typeof p === 'object' &&
          typeof p.holderInstanceId === 'string' &&
          p.holderInstanceId,
      )
    : null
  if (purchases) this.desktopPurchases = purchases
  if (body.desktopSessionCounts && typeof body.desktopSessionCounts === 'object') {
    this.desktopSessionCounts = body.desktopSessionCounts
  }
  if (Array.isArray(body.desktopRefunds)) this.desktopRefunds = body.desktopRefunds
}

/**
 * 上游此刻谁占着这个模型的槽位(官方 knownHolder).
 *
 * 上游清单里的 model 是上游模型 id(deepseek/deepseek-v4-flash),
 * 而我们调用方传的是目录 key(m-096e75164d) -- 两套标识不同, 严格相等
 * 匹配不上, 表现为"面板能显示那条已付费会话, 调度却看不见".
 *
 * 所以这里复用仓库既有的唯一映射真源(SessionManager 不认识 AppContext,
 * 故由构造时注入的 resolveModelAlias 提供; 缺失时退回严格相等):
 * 把两侧都归一成目录 key 再比.
 * @param {any} this 会话实例
 * @param {string} model 目录 key / 上游 id / 可读名, 任一形式
 * @returns {string | null} 占用者 instanceId; 无人占用返回 null
 */
export function holderFor(this: any, model: string): string | null {
  if (!model || !Array.isArray(this.desktopPurchases)) return null
  const now = Date.now()
  const norm = (v: any) =>
    typeof this.resolveModelAlias === 'function'
      ? this.resolveModelAlias(v)
      : String(v ?? '')
  const want = norm(model)
  const hit = this.desktopPurchases.find(
    (p: DesktopPurchase) =>
      p &&
      p.model &&
      norm(p.model) === want &&
      typeof p.holderInstanceId === 'string' &&
      p.holderInstanceId &&
      (!p.expiresAt || Date.parse(p.expiresAt) > now),
  )
  return hit?.holderInstanceId || null
}
