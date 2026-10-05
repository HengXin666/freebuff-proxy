/**
 * 账号池的目录行聚合与额度/单价快照.
 *
 * 从 app-context.js 按职责切出. 与 account-catalog 的分工: 那边做标识归一,
 * 这边把多个账号各自持有的目录合成本服务对外的一份清单, 并从 session 回执
 * 里取额度与单价.
 */
import { logger } from '../../util/log.js'

/**
 * 模型清单(权威):聚合所有账号已抓取的目录行.
 *
 * 为什么不能用 modelAliases(rateLimitsByModel) 代替:
 * 会话回执的 rateLimitsByModel 只是"今日给了会话额度的子集" ---- 实测同一份
 * session 响应里目录有 13 行,rateLimits 只有 6 个键.把模型清单建在那上面,
 * 表现就是[账号额度是满的,但一个模型都没有].
 *
 * 为什么取并集:目录是逐账号持有的(每个 runtime 各抓一次),任一账号
 * 抓失败都不该让清单退化成空.并集按 key 去重,同 key 取第一条.
 *
 * @param {any} this 账号池(runtimes)
 * @returns {{ rows: any[], issuedAt: number | null, version: string | null, accountCount: number, readyCount: number }}
 */
export function catalogRows(this: any) {
  /** @type {Map<string, any>} */
  const byKey = new Map()
  let issuedAt = null
  let version = null
  let readyCount = 0
  for (const rt of this.byKey.values()) {
    const cat = rt?.upstream?.catalog
    if (!cat?.ready) continue
    readyCount++
    if (!version && typeof cat.version === 'string') version = cat.version
    if (issuedAt === null && Number.isFinite(cat.issuedAt)) issuedAt = cat.issuedAt
    for (const row of cat.rows?.() || []) {
      if (!row || typeof row.key !== 'string' || !row.key) continue
      if (!byKey.has(row.key)) byKey.set(row.key, row)
    }
  }
  return {
    rows: [...byKey.values()].sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    issuedAt,
    version,
    accountCount: this.byKey.size,
    readyCount,
  }
}

/**
 * 确保所有账号都抓过目录(模型清单的前置条件).
 *
 * 为什么需要:目录是懒加载的(第一次用到才抓),而 /v1/models 常常是
 * 服务启动后的第一个请求 ---- 那一刻 catalogRows() 必然是空的,清单会退化成
 * [没有任何可用模型].所以清单接口必须先补一次抓取.
 *
 * 逐账号 best-effort:任一账号失败不影响其它账号(多账号池里不同号的出口
 * 信誉不同,抓不通是常态).
 *
 * @param {any} this 账号池(runtimes)
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ ok: number, failed: number }>}
 */
export async function refreshCatalogs(this: any, opts: any = {}) {
  let ok = 0
  let failed = 0
  const jobs = []
  /**
   *  冷启动时 byKey 是空的(runtime 懒创建),直接遍历它等于"一次都不抓"
   * ---- 实测(2026-10-04 容器端到端):新部署第一个请求拿不到目录 →
   * 全部模型被判 model_not_allowed(400).
   *
   * 所以先按凭据文件列表把 runtime 建出来(this.get() 会懒创建),
   * 再抓.这与"零自动探测"不冲突:调用方只在用户正在发真实请求时走到这里
   * (目录是该请求的必要前置,admission 要用目录句柄).
   */
  try {
    for (const row of this.list()) this.get(row.key)
  } catch {
    // 取账号失败不阻塞：下面按现有 byKey 尽力抓
  }
  for (const rt of this.byKey.values()) {
    const cat = rt?.upstream?.catalog
    if (!cat) continue
    jobs.push(
      cat
        .fetch(opts)
        .then((done: any) => {
          if (done) ok++
          else failed++
        })
        .catch(() => {
          failed++
        }),
    )
  }
  await Promise.all(jobs)
  return { ok, failed }
}

/**
 * 账号池此刻的额度与单价(目录 key → 信息),逐账号取并集.
 *
 * 与 catalogRows() 分工:清单来自目录,额度/单价来自 session 回执.
 * 两者是三张不同的表(目录 13 行 / prices 17 键 / rateLimits 6 键),
 * 合并展示但不互相顶替.
 *
 * @param {any} this 账号池(runtimes)
 * @returns {{ rateLimits: Map<string, any>, prices: Map<string, number>, accessTier: string | null }}
 */
export function catalogQuota(this: any) {
  /**
   *  两张表都用普通对象,不用 Map.
   * 实测:把这批数据以 Map 形式传进 model.js 并在循环里取值,会出现
   * "第一条有值,批量全 undefined" 的不可复现行为(同一份数据换成普通
   * 对象下标取值则全部正确).统一用对象口径,行为确定.
   */
  /** @type {Record<string, any>} */
  const rateLimits: Record<string, any> = {}
  /** @type {Record<string, number>} */
  const prices: Record<string, number> = {}
  let accessTier = null
  for (const rt of this.byKey.values()) {
    const snap = rt?.sessions?.getSnapshot?.()
    const byModel: Record<string, any> = snap?.quota?.byModel || {}
    for (const [id, info] of Object.entries(byModel)) {
      // 同 key 取 limit 更大的那份(多账号池里不同号被授予的额度不同)
      const cur = rateLimits[id]
      if (!cur || (info?.limit ?? 0) > (cur?.limit ?? 0)) rateLimits[id] = info
    }
    const p = snap?.freebucks?.prices || {}
    for (const [id, v] of Object.entries(p)) {
      if (Number.isFinite(v) && prices[id] === undefined) prices[id] = Number(v)
    }
    // accessTier 在 snapshot.session 上(不是 snapshot 顶层)----
    // _apply 里写的是 this.session = { status, ..., accessTier }.
    const tier = snap?.session?.accessTier || snap?.accessTier
    if (!accessTier && (tier === 'full' || tier === 'limited')) accessTier = tier
  }
  return { rateLimits, prices, accessTier }
}
