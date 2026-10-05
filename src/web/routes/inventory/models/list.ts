/**
 * models 域(清单侧):/api/models 与 /api/models/upstream.
 *
 * ! 这两个端点与 /v1/models(src/proxy.ts)必须同源:清单以上游
 * (只有 6 个键),于是额度满,未封禁的账号照样报"上游暂无可用模型".
 * 见 docs/reverse/19-catalog-is-the-model-list.md.
 *
 * ! 零自动探测(docs/reverse/20 §20.3):GET /api/models 只读本地缓存;
 * GET /api/models/upstream 是"同步上游模型"按钮的后端,属用户主动触发,
 * 允许抓目录.
 */
import { sendJson } from '../../../../util/http.ts'
import {
  buildModelsListResponse,
  CATALOG_UNIFIED_AGENT_ID,
  catalogDisplayName,
} from '../../../../model.ts'
import { buildCatalogDrivenModelsResponse } from '../../../../catalog-models.ts'
import { catalogIdForKey } from '../../lib/helpers.ts'
import { probeAllAccountsSession } from '../../lib/probe.ts'
import type { ServerResponse } from 'node:http'

/**
 * 构造上游目录行 -> 控制台模型行(名称走单一真源 catalogDisplayName).
 *
 * @param {any} row 目录行
 * @param {any} quota 目录额度/单价
 * @param {any} runtimes 账号运行时集合
 * @returns {Record<string, any>} 模型行
 */
function modelRow(row: any, quota: any, runtimes: any) {
  const key = row.key
  const name = catalogDisplayName(row)
  const info = quota.rateLimits[key] ?? null
  const price = quota.prices[key]
  return {
    key,
    // ! id 是可读模型名(与 /v1/models 同源),不再是 m-xxx.
    id: name,
    displayName: name,
    // catalogId 保留字段(旧消费方读它做反查);目录新增的模型没有
    // legacyDigests(如 Ling 3.1 Flash / Laguna S 2.1),此处为 null,
    // 前端回落到 id 即可, 不得因此丢掉整行.
    catalogId: catalogIdForKey(runtimes, key) || null,
    premium: row.premium === true,
    access: row.access ?? null,
    multimodal: row.multimodal === true,
    ...(Array.isArray(row.efforts) ? { efforts: row.efforts } : {}),
    ...(Number.isFinite(row.contextWindow) ? { contextWindow: row.contextWindow } : {}),
    limit: info?.limit ?? null,
    recentCount: info?.recentCount ?? null,
    freebucksPerHour: Number.isFinite(price) ? Number(price) : null,
    pool: info?.pool ?? null,
    poolLabel: info?.poolLabel ?? null,
    resetAt: info?.resetAt ?? null,
    resetTimeZone: info?.resetTimeZone ?? null,
    // agent 一律统一目录 agent(目录模式下官方就用一个 root agent);
    // 按 key 推导出的 base2-free-m-xxx 上游根本不存在.
    agentId: CATALOG_UNIFIED_AGENT_ID,
    fallbackAgentId: CATALOG_UNIFIED_AGENT_ID,
  }
}

/**
 * /api/models ---- 读本地缓存的目录(不发任何上游请求).
 *
 * @param {any} res
 * @param {any} ctx
 * @returns {void}
 */
function listModels(res: ServerResponse, ctx: any) {
  const { runtimes, modelStore } = ctx
  const catalog = runtimes.catalogRows?.() || { rows: [], issuedAt: null }
  const quota = runtimes.catalogQuota?.() || {
    rateLimits: {},
    prices: {},
    accessTier: null,
  }
  if (catalog.rows.length) {
    const payload = buildCatalogDrivenModelsResponse({
      rows: catalog.rows,
      rateLimits: quota.rateLimits,
      prices: quota.prices,
      accessTier: quota.accessTier,
      issuedAt: catalog.issuedAt,
      hiddenModels: modelStore ? modelStore.hidden() : [],
    })
    // 兼容字段:老的前端消费方读 upstreamModelIds / upstreamModels 标 .
    // 现在清单以目录为准,这两项只表示"当前有额度/有单价的 key".
    const aliased = runtimes.modelAliases(catalog.rows.map((r: any) => r.key))
    sendJson(res, 200, {
      ...payload,
      accessTier: quota.accessTier || null,
      // 可读名口径:下游把 upstreamModelIds 当模型名用,不能给裸目录 key.
      upstreamModelIds: aliased.map((a: any) => a.displayName || a.key),
      upstreamModels: aliased,
    })
    return
  }
  // 目录未缓存:返回空清单 + notProbed(不回落 2026-08 的静态快照,
  // 那份数据本身就是错的来源,见 docs/reverse/20 §20.2).
  sendJson(res, 200, {
    object: 'list',
    data: [],
    accessTier: quota.accessTier || null,
    notProbed: true,
    note: '尚未探测上游目录：请点「一键刷新」',
  })
}

/**
 * /api/models/upstream ---- 抓目录(force)+ 顺带刷会话补额度/单价.
 *
 * @param {any} res
 * @param {any} ctx
 * @returns {Promise<void>}
 */
async function upstreamModels(res: ServerResponse, ctx: any) {
  const { runtimes } = ctx
  const accounts = runtimes.list()
  if (!accounts.length) {
    sendJson(res, 200, { models: [], note: '没有账号，无法探测上游' })
    return
  }
  try {
    // 本接口 = "同步上游模型"按钮的后端,是用户主动触发,所以允许抓目录.
    await runtimes.refreshCatalogs?.({ force: true })
    const catalog = runtimes.catalogRows?.() || { rows: [], issuedAt: null }
    // 抓到目录后顺带刷一次会话补额度/单价:用户点的是"同步上游模型",
    // 要的是一份能用的清单(名字 + 价格 + 额度),不是只有名字的空壳.
    if (catalog.rows.length) {
      try {
        await probeAllAccountsSession(runtimes)
      } catch {
        // 额度拿不到也照常返回清单
      }
    }
    if (!catalog.rows.length) {
      sendJson(res, 200, {
        models: [],
        upstreamModelIds: [],
        upstreamModels: [],
        catalogError: true,
        notProbed: true,
        note: '尚未探测：请先点「一键刷新」拉取上游目录',
      })
      return
    }
    const quota = runtimes.catalogQuota?.() || {
      rateLimits: {},
      prices: {},
      accessTier: null,
    }
    const aliased = runtimes.modelAliases(catalog.rows.map((r: any) => r.key))
    sendJson(res, 200, {
      models: catalog.rows.map((row: any) => modelRow(row, quota, runtimes)),
      accessTier: quota.accessTier || null,
      // 同上: 判据真值在 upstreamModels[].key, 这个字段给可读名.
      upstreamModelIds: aliased.map((a: any) => a.displayName || a.key),
      upstreamModels: aliased,
      catalogVersion: catalog.version || null,
      catalogIssuedAt: catalog.issuedAt || null,
      note: '清单来自上游目录；额度与单价来自只读探测（不创建 session）',
    })
  } catch (err) {
    sendJson(res, 502, {
      models: [],
      error: err instanceof Error ? err.message : String(err),
      note: '上游探测失败（可能未登录/网络问题）',
    })
  }
}

/**
 * /api/models 与 /api/models/upstream 的共用入口.
 *
 * @param {string} method HTTP 方法
 * @param {string} route 规范化路径
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleList(method: string, route: string, res: ServerResponse, ctx: any) {
  if (method === 'GET' && route === '/api/models') {
    listModels(res, ctx)
    return true
  }
  if (method === 'GET' && route === '/api/models/upstream') {
    await upstreamModels(res, ctx)
    return true
  }
  return false
}
