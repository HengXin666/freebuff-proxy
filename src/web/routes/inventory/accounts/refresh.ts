/**
 * accounts 域(刷新侧):/probe 与 /refresh 的逐账号只读探测.
 *
 * ! 全部只读(sessions.refresh() 走 GET),不创建,不释放任何计费会话.
 *
 * ! 探测结果的额度在 quota.byModel 上,不在 refresh() 返回的本地快照上
 * (那是 extractQuota 解析出来的).取错字段的表现是"永远 0 个模型".
 */
import { sendJson } from '../../../../util/http.ts'
import { overviewModelNames, probeErrorFields } from '../../lib/helpers.ts'
import { ACCOUNT_LEVEL_PROBE_CODES, probeAllAccountsSession } from '../../lib/probe.ts'
import type { ServerResponse } from 'node:http'

/**
 * 逐账号只读刷新(GET session),账号级故障落冷却.
 *
 * 冷却只标记,绝不释放:冷却到期自动恢复,已购买的会话句柄原样保留.
 *
 * @param {any} runtimes
 * @returns {Promise<any[]>} 每账号结果
 */
async function refreshEach(runtimes: any) {
  const results = []
  for (const row of runtimes.list()) {
    try {
      const rt = runtimes.get(row.key)
      const session = await rt.sessions.refresh()
      const snap = rt.sessions.getSnapshot()
      const limits = snap?.quota?.byModel || {}
      results.push({
        key: row.key,
        email: row.email,
        ok: true,
        status: session?.status ?? null,
        modelCount: Object.keys(limits).length,
        // 有在途请求时 refresh() 主动跳过探测(不能顶掉活跃会话): 如实标出来,
        // 否则界面上就是"刷了但数字没变", 而用户无从知道为什么.
        skipped: snap?.probeSkipped || null,
      })
    } catch (err) {
      const { code, status } = probeErrorFields(err)
      // 账号级故障落冷却:让"刷新后的显示"和"调度器的真实判断"同源.
      if (code && ACCOUNT_LEVEL_PROBE_CODES.has(code)) {
        try {
          runtimes.markCooldown(row.key, err, null)
        } catch {
          // 冷却失败不影响刷新结果
        }
      }
      results.push({
        key: row.key,
        email: row.email,
        ok: false,
        code,
        status,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return results
}

/**
 * POST /api/accounts/probe ---- 逐账号 GET session,刷新 session/额度缓存.
 *
 * 不创建 session,不占免费额度;fresh 账号若上游无使用记录则额度仍为空.
 *
 * @param {any} res
 * @param {any} ctx
 * @returns {Promise<void>}
 */
export async function probeAll(res: ServerResponse, ctx: any) {
  const { runtimes } = ctx
  const results = []
  for (const a of runtimes.list()) {
    try {
      const rt = runtimes.get(a.key)
      const session = await rt.sessions.refresh()
      // 额度在 quota.byModel(本地快照 session 上没有这个字段)
      const snap = rt.sessions.getSnapshot()
      const limits = snap?.quota?.byModel || {}
      results.push({
        key: a.key,
        email: a.email,
        ok: true,
        status: session?.status ?? null,
        modelCount: Object.keys(limits).length,
        models: Object.keys(limits),
        // 同上: 在途期间跳过探测要如实报出, 不要把旧快照当成新值.
        skipped: snap?.probeSkipped || null,
      })
    } catch (err) {
      const { code, status } = probeErrorFields(err)
      results.push({
        key: a.key,
        email: a.email,
        ok: false,
        code,
        status,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  sendJson(res, 200, {
    ok: true,
    results,
    accounts: runtimes.list(),
    // 统计卡/负载均衡条/账号池计数都要这几项. 少了它们, 前端只能拿 accounts
    // 凑出一份局部数字 ---- 同一屏上统计卡与账号表显示两套口径.
    accountCount: runtimes.allKeys().length,
    modelNames: overviewModelNames(runtimes),
    slots: ctx.requestSlotStats ? ctx.requestSlotStats() : null,
  })
}

/**
 * "一键刷新"(控制台顶部按钮)----只读,但比 /probe 更彻底:
 *   1) 逐账号 GET session -> 刷新额度,探测状态(ban / 风控 / 限流 / 凭证失效);
 *   2) 顺手刷新上游模型目录(多账号并集),让"模型列表只有一个"这类时滞问题
 *      一次刷新就消失;
 *   3) 探测到账号级故障时落冷却(与调度同一套 code).
 *
 * ! 关键约束(用户明确要求):刷新只做只读探测.
 *   不做 admit,不 DELETE,不动 session 句柄----已购买的会话一小时是实付的.
 *
 * @param {any} res
 * @param {any} ctx
 * @returns {Promise<void>}
 */
export async function refreshAll(res: ServerResponse, ctx: any) {
  const { runtimes } = ctx
  const results = await refreshEach(runtimes)
  // 显式标注:string[] ---- 不标的话 [] 推成 never[],后面两次使用点
  // (三元内 / sendJson 参数)各推一次,TS 报 TS7034 + TS7005.
  let modelIds: string[] = []
  /**
   * "一键刷新"= 用户主动 -> 允许探测,且目录与会话一起刷新.
   * 而"同步上游模型"又只抓目录 ---- 用户必须点两个按钮才凑得齐数据.
   * 目录失败不拖累账号刷新(两者的失败是独立的).
   */
  let catalogInfo = { rows: [], issuedAt: null, version: null }
  try {
    await runtimes.refreshCatalogs?.({ force: true })
    catalogInfo = runtimes.catalogRows?.() || catalogInfo
  } catch {
    // 目录刷新失败不影响账号刷新结果
  }
  try {
    const { session } = await probeAllAccountsSession(runtimes)
    modelIds = Object.keys(session?.rateLimitsByModel || {})
  } catch {
    // 额度拿不到不影响账号刷新结果
  }
  const failed = results.filter((r) => !r.ok)
  /**
   * 上游模型清单同时给两种口径.
   *
   * upstreamModelIds 以前直接给目录 key(m-096e75164d),下游把它当模型名就什么
   * 都认不出 ---- 它是"哪些模型有额度"的判据表, 展示与选用的入口应给对外 id.
   * 现在这个字段统一给无空白 id(catalogId 优先), 服务端真值仍以
   * upstreamModels[].key 并列透出.
   */
  const upstreamKeys = results.length ? modelIds : []
  const aliased = runtimes.modelAliases(upstreamKeys)
  const readableIds = aliased.map((a: any) => a.publicId || a.key)
  sendJson(res, 200, {
    ok: true,
    results,
    failures: failed.length,
    accounts: runtimes.list(),
    modelNames: overviewModelNames(runtimes),
    upstreamModelIds: readableIds,
    upstreamModels: aliased,
    // 目录侧:让前端一次点击就能同时更新清单与额度
    catalogRows: catalogInfo.rows?.length || 0,
    catalogVersion: catalogInfo.version || null,
    catalogIssuedAt: catalogInfo.issuedAt || null,
    note: '只读刷新：未创建 / 未释放任何会话，已购买的付费时段不受影响',
  })
}
