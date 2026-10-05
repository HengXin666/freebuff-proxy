/**
 * 由 src/proxy.ts 搬出的路由处理器 -- 见 docs/code-quality 的拆分记录.
 *
 * 这些处理器之间无共享可变状态, 只有对 config / runtimes / userStore /
 * settingsStore 的读取, 依赖通过显式 ctx 参数传入.
 * 每个函数的 JSDoc 原样保留.
 */

import { buildCatalogDrivenModelsResponse } from '../../catalog-models.ts'
import { sendJson } from '../../util/http.ts'
import { logger } from '../../util/log.ts'

export function customModels(ctx: any) {
  return typeof ctx.modelStore?.list === 'function' ? ctx.modelStore.list() : []
}

/**
 * 前端[模型管理]删除(隐藏)的模型 id,实时生效.
 * @param {object} ctx 依赖集合(含 modelStore)
 * @returns {string[]} 被隐藏的模型 id
 */
export function hiddenModels(ctx: any) {
  return typeof ctx.modelStore?.hidden === 'function' ? ctx.modelStore.hidden() : []
}

/**
 * 一键屏蔽收费模型开关(前端[模型管理],实时生效).
 * @param {object} ctx 依赖集合(含 settingsStore)
 * @returns {boolean} 是否屏蔽收费模型
 */
export function blockPremiumModels(ctx: any) {
  return ctx.settingsStore?.get()?.blockPremiumModels === true
}


export async function handleModels(ctx: any, res: any) {
  /**
   - 清单 = 目录行(权威,13 行);额度/单价 = 会话回执(只挂元数据).
   *
   - 此前这里把 rateLimitsByModel 当成了模型清单 ---- 它只是"今日给了
   - 会话额度的子集"(实测 6 个键 vs 13 行目录),于是额度满,未封禁的账号
   - 照样对外报[没有任何可用模型].见 docs/reverse/19-catalog-is-the-model-list.md.
   *
   - 目录抓取失败(网络/未登录)时回落到旧的静态表,绝不返回空列表 ----
   - 空列表会让下游 Agent 直接判定"这个代理没有任何模型".
   */
  /**
   - 零自动探测(用户裁决,docs/reverse/20 §20.3).
   *
   - 本接口只读本地缓存:目录缓存(catalog-cache / 各 runtime 已抓的
   - 目录)与账号会话快照里的额度/单价.拿不到就如实返回空并带
   - notProbed: true ---- 由控制台提示用户点[一键刷新],
   - 绝不为填空而自动发一次上游请求.
   *
   - 以前的写法会在这里补一次 GET(catalog 也好,session 也好),
   - 于是"下游刷新一次页面"就等于"上游看见一次我们主动发起的探测",
   - 这正是要消灭的流量.
   */
  const catalog = ctx.runtimes.catalogRows?.() || { rows: [], issuedAt: null }
  const quota =
    ctx.runtimes.catalogQuota?.() || {
      rateLimits: {},
      prices: {},
      accessTier: null,
    }
  if (catalog.rows.length) {
    sendJson(
      res,
      200,
      buildCatalogDrivenModelsResponse({
        rows: catalog.rows,
        rateLimits: quota.rateLimits,
        prices: quota.prices,
        accessTier: quota.accessTier,
        issuedAt: catalog.issuedAt,
        hiddenModels: hiddenModels(ctx),
        blockPremium: blockPremiumModels(ctx),
      }),
    )
    return
  }
  /**
   - 目录未缓存 → 返回空清单 + notProbed,不回落静态表.
   *
   - 以前回落内置静态 catalog,而那份是 2026-08 的快照(13 行目录只命中
   - 3 行)---- 拿它当清单等于给下游一份错的模型表,比给空更糟:
   - 下游会照着它发请求,然后被 model_not_allowed 或上游拒掉.
   - 按 docs/reverse/20 §20.2[没从客户端对齐过的一律作废],
   - 真实清单只有上游目录一个来源.
   *
   - 用户点控制台[一键刷新]即触发探测(那是被允许的时机).
   */
  logger.warn('models: catalog not cached; returning empty + notProbed', {
    accounts: ctx.runtimes.allKeys().length,
    readyCatalogs: catalog.readyCount ?? 0,
  })
  sendJson(res, 200, {
    object: 'list',
    data: [],
    notProbed: true,
    note: '尚未探测上游目录：请在控制台点「一键刷新」',
  })
}

/**
 * /v1/freebuff/status -- 纯本地快照, 不发任何上游请求(见 docs/reverse/20 §20.2).
 * @param {object} ctx 依赖集合
 * @param {object} res 响应对象
 * @returns {Promise<void>} 无返回
 */
export async function handleStatus(ctx: any, res: any) {
  const accounts = ctx.runtimes.list()
  let session = null
  let account = null
  if (accounts.length) {
    const rt = ctx.runtimes.getAny()
    account = rt.email
    session = rt.sessions.getSnapshot()
  }
  sendJson(res, 200, {
    upstream: {
      apiBase: ctx.config.upstream.apiBase,
      loginBase: ctx.config.upstream.loginBase,
    },
    account,
    accounts,
    session,
  })
}

/**
 * 目录行的全部可寻址口径(目录 key + 可读显示名),供白名单判定.
 *
 * 客户端可能照着 /v1/models 的可读名填,也可能用我们透出的 freebuff_key.
 * 两个都收, 不设缓存: 启动时目录尚未加载, 缓存空数组会让一段时间内所有模型
 * 都被 model_not_allowed 拒掉.
 *
 * @param {object} ctx 依赖集合(含 runtimes)
 * @returns {string[]} 可寻址的模型标识
 */
export function catalogModelKeys(ctx: any) {
  const keys = []
  try {
    const { rows } = ctx.runtimes.catalogRows?.() || {}
    for (const row of rows || []) {
      if (typeof row?.key === 'string' && row.key) keys.push(row.key)
      if (typeof row?.displayName === 'string' && row.displayName.trim()) {
        keys.push(row.displayName.trim())
      }
    }
  } catch {
    // 目录不可用时不阻塞白名单（退回其它三层判定）
  }
  return keys
}
