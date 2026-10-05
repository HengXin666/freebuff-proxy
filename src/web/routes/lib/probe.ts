/**
 * 会话/额度探测的共享实现(控制面各域共用).
 *
 * ! 已删除 upstreamSessionCache(60s)+ probeUpstreamSession() +
 * probeUpstreamSessionFresh() ---- 与 proxy.js 那份是同一类死缓存
 * (2026-10-04 盲审发现漏删).
 *
 * 证据(可复核):
 *   - probeUpstreamSessionFresh 全仓无调用者,只被定义;
 *   - probeUpstreamSession 只被前者调用;
 *   - 所以 upstreamSessionCache 只被写,从不被读 ---- 唯一读点在那两个
 *     死函数里.probeAllAccountsSession 的写入是纯无用功.
 *
 * 用户裁决:只有对外/内部/上游三层,中间不允许缓存层.
 * 会话探测的唯一合法时机是用户主动刷新(docs/reverse/20 §20.3),
 * 那时数据由 probeAllAccountsSession 直接返回,不需要经过缓存中转.
 */
import {
  C_BANNED,
  C_IP_CAPPED,
  C_PREMIUM_SLOT_TAKEN,
  C_RATE_LIMITED,
  C_SPEND_LIMITED,
} from '../../../upstream/response-contract.ts'
import { probeErrorFields } from './helpers.ts'

/**
 * 刷新(只读探测)时,哪些 code 意味着"账号级故障,必须落冷却".
 * 与 app-context.js 的 ACCOUNT_COOLDOWN_CODES 同源语义:这些 code 命中后
 * 账号既不该被调度,也不该在控制台显示成正常.
 * 注意不含 model_unavailable(那是单模型级,不能拿它封整个账号).
 *
 * 判据码一律从 src/upstream/response-contract.ts 取常量,不写字面量:
 * 上游改码时只改真源一处.门禁 scripts/gates/checks/guard/response-contract.ts
 * 会把真源之外的裸字面量判成新增债务.
 */
export const ACCOUNT_LEVEL_PROBE_CODES = new Set([
  C_BANNED,
  'country_blocked',
  C_RATE_LIMITED,
  C_SPEND_LIMITED,
  C_IP_CAPPED,
  'free_mode_rate_limited',
  C_PREMIUM_SLOT_TAKEN,
])

/**
 * 逐账号探测把各自的 rateLimitsByModel 取并集,得到"整个账号池此刻
 * 被授予了哪些模型"的合并视图(多账号池里不同号被授予的模型不同,只看一个号
 * 会漏).
 * 单个账号失败不影响其它账号:失败记进 failures,不整体报错.
 *
 * @param {any} runtimes 账号运行时集合
 * @returns {Promise<{session: any, failures: any[]}>} 合并会话视图与失败明细
 */
export async function probeAllAccountsSession(runtimes: any) {
  const rows = runtimes.list()
  if (!rows.length) return { session: null, failures: [] }
  const failures = []
  /** @type {Map<string, any>} */
  const limits = new Map()
  let base = null
  for (const row of rows) {
    try {
      const rt = runtimes.get(row.key)
      const s = await rt.sessions.refresh()
      if (!base) base = s
      // ! refresh() 返回的是本地 session 快照(status/instanceId/expiresAt...),
      // 不含上游的 rateLimitsByModel ---- 额度在 quota.byModel 上(_apply 里由
      // extractQuota 解析).取错字段的表现是"永远 0 个模型",正是这里踩到的.
      const byModel = rt.sessions.getSnapshot()?.quota?.byModel || {}
      for (const [id, info] of Object.entries<{ limit?: number }>(byModel)) {
        if (!limits.has(id) || (info?.limit ?? 0) > (limits.get(id)?.limit ?? 0)) {
          limits.set(id, info)
        }
      }
    } catch (err) {
      // 这里原本写的是 err?.code || null(||,不是 ??)---- 保留 ||:空串也当
      // "没有判据码".别换成 ??,那会让空串漏进 failures.
      const code = probeErrorFields(err).code || null
      failures.push({
        key: row.key,
        email: row.email,
        code,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (!base && !limits.size) return { session: null, failures }
  const session = {
    ...(base || {}),
    rateLimitsByModel: Object.fromEntries(limits),
    model: base?.model || [...limits.keys()][0] || null,
  }
  return { session, failures }
}
