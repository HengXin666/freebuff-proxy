/**
 * models 域(自定义侧):模型管理页的读/存/隐藏/移除/恢复.
 *
 * 隐藏(hidden)与移除(remove)是两件事,别合并:
 *   - hide  : 把 id 记进隐藏集,内置目录条目也一起从列表/调度里消失,可 unhide 恢复;
 *   - remove: 只从自定义列表里删掉,回退到内置目录(不是隐藏,也无需恢复).
 */
import { sendJson } from '../../../../util/http.ts'
import { logger } from '../../../../util/log.ts'
import { buildModelsListResponse } from '../../../../model.ts'
import { denyUnlessAdmin } from '../../lib/http-codes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

const CUSTOM_PREFIX = '/api/models/custom'
/**
 * 逐字常量而不是模板串:路由对账门禁(check-docs)与源码级自检都靠
 * route === '<字面量>' 抽注册表,拼出来的路径会让它看不见这条路由.
 */
const CUSTOM_ROUTES = new Set([
  CUSTOM_PREFIX,
  `${CUSTOM_PREFIX}/hide`,
  `${CUSTOM_PREFIX}/remove`,
  `${CUSTOM_PREFIX}/unhide`,
])

/**
 * 单 id 动作(hide / remove / unhide)的公共前半段:闸门 + 取 id.
 *
 * @param {any} user
 * @param {any} ctx
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<string | null>} 合法 id;已写过响应时为 null
 */
async function requireModelId(user: any, ctx: any, req: IncomingMessage, res: ServerResponse) {
  if (denyUnlessAdmin(user, res)) return null
  if (!ctx.modelStore) {
    sendJson(res, 501, { error: '当前进程未启用模型存储' })
    return null
  }
  const body = await ctx.readJson(req).catch(() => null)
  const id = body && typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) {
    sendJson(res, 400, { error: '缺少模型 id' })
    return null
  }
  return id
}

/**
 * 前端"模型管理":读取自定义模型列表(覆盖/扩展内置 catalog,全局生效).
 *
 * @param {ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {void}
 */
function listCustomModels(res: ServerResponse, ctx: any) {
  const { modelStore } = ctx
  sendJson(res, 200, {
    models: modelStore ? modelStore.list() : [],
    hidden: modelStore ? modelStore.hidden() : [],
    // 内置 catalog 供前端参考(含 agent 映射,只读;已过滤被隐藏模型)
    catalog: buildModelsListResponse({
      includeAllCatalog: true,
      hiddenModels: modelStore ? modelStore.hidden() : [],
    }).data,
  })
}

/**
 * 保存自定义模型列表(POST /api/models/custom).
 *
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {Promise<void>}
 */
async function saveCustomModels(req: IncomingMessage, res: ServerResponse, ctx: any) {
  const { modelStore, readJson } = ctx
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return
  }
  const models = modelStore.save(body.models)
  logger.event('modelFetch', 'info', 'custom models updated via web', { count: models.length })
  sendJson(res, 200, {
    ok: true,
    models,
    note: models.length
      ? '已保存并立即生效（自定义模型优先于内置目录）'
      : '已清空自定义模型（回退到内置目录）',
  })
}

/**
 * 自定义模型端点.
 *
 * @param {string} method HTTP 方法
 * @param {string} route 规范化路径
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {any} user 当前用户
 * @param {any} ctx 路由上下文
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleCustom(
  method: string,
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  user: any,
  ctx: any,
) {
  const { modelStore } = ctx
  if (!CUSTOM_ROUTES.has(route)) return false

  if (method === 'GET' && route === '/api/models/custom') {
    listCustomModels(res, ctx)
    return true
  }

  if (method === 'POST' && route === '/api/models/custom') {
    if (denyUnlessAdmin(user, res)) return true
    if (!modelStore) {
      sendJson(res, 501, { error: '当前进程未启用模型存储' })
      return true
    }
    await saveCustomModels(req, res, ctx)
    return true
  }

  // 前端"模型管理"删除模型:把 id 加入 hidden(含内置目录的),彻底从列表/调度隐藏.
  if (method === 'POST' && route === '/api/models/custom/hide') {
    const id = await requireModelId(user, ctx, req, res)
    if (!id) return true
    modelStore.hide(id)
    logger.event('modelFetch', 'info', 'model hidden via web', { model: id })
    sendJson(res, 200, { ok: true, hidden: modelStore.hidden(), note: `已隐藏模型 ${id}` })
    return true
  }

  // 前端"模型管理"彻底移除一个自定义模型(不加入 hidden,回退 catalog).
  if (method === 'POST' && route === '/api/models/custom/remove') {
    const id = await requireModelId(user, ctx, req, res)
    if (!id) return true
    modelStore.remove(id)
    logger.event('modelFetch', 'info', 'custom model removed via web', { model: id })
    sendJson(res, 200, {
      ok: true,
      models: modelStore.list(),
      note: `已移除自定义模型 ${id}（回退内置目录）`,
    })
    return true
  }

  // 前端"模型管理"恢复被隐藏的模型.
  if (method === 'POST' && route === '/api/models/custom/unhide') {
    const id = await requireModelId(user, ctx, req, res)
    if (!id) return true
    modelStore.unhide(id)
    logger.event('modelFetch', 'info', 'model unhidden via web', { model: id })
    sendJson(res, 200, { ok: true, hidden: modelStore.hidden(), note: `已恢复模型 ${id}` })
    return true
  }
  return false
}
