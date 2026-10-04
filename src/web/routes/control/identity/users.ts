/**
 * users 域:控制台用户管理(admin 专属).
 *
 * 建/删/改角色/改密码/重置 API Key.删除自己是被禁止的 ---- 把自己删掉之后
 * 就再没有管理员能登进来了,这个锁不是"防误操作",是防"整个部署失去管理入口".
 */
import { sendJson } from '../../../../util/http.js'
import { sanitize } from '../../lib/helpers.ts'
import { denyUnlessAdmin, decodeSegment } from '../../lib/http-codes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

const USER_RE = /^\/api\/users\/([^/]+)(?:\/([^/]+))?$/

/**
 * 建号(POST /api/users)---- 校验失败统一回 400 带原因.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {Promise<void>}
 */
async function createUser(req: IncomingMessage, res: ServerResponse, ctx: any) {
  const { userStore, readJson } = ctx
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return
  }
  try {
    const created = userStore.create({
      username: body.username,
      password: body.password,
      role: body.role,
    })
    sendJson(res, 200, { ok: true, user: created })
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * 改角色(PATCH /api/users/:name)---- body.role 未传则什么都不做.
 *
 * @param {string} username 目标用户名
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {Promise<void>}
 */
async function patchUser(username: string, req: IncomingMessage, res: ServerResponse, ctx: any) {
  const { userStore, readJson } = ctx
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return
  }
  try {
    if (body.role !== undefined) userStore.setRole(username, body.role)
    sendJson(res, 200, { ok: true, user: sanitize(userStore.getByUsername(username)) })
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * 改密码(POST /api/users/:name/password).
 *
 * @param {string} username 目标用户名
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {Promise<void>}
 */
async function setUserPassword(username: string, req: IncomingMessage, res: ServerResponse, ctx: any) {
  const { userStore, readJson } = ctx
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return
  }
  try {
    userStore.setPassword(username, body.password)
    sendJson(res, 200, { ok: true })
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * 用户管理端点.
 *
 * @param {string} method HTTP 方法
 * @param {string} route 规范化路径
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} user 当前用户
 * @param {any} ctx 路由上下文
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handle(
  method: string,
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  user: any,
  ctx: any,
) {
  const { userStore } = ctx
  // ! 先判路由形状,再判权限:反过来的话,一个非管理员打
  // /api/users/<不存在的形状> 会拿到 403,而拆分前那一档是 404
  // ---- "没这条路由"和"你没权限"是两件事,混起来会让排障指向错误方向.
  const isCollection = route === '/api/users'
  const match = route.match(USER_RE)
  if (!isCollection && !match) return false
  if (denyUnlessAdmin(user, res)) return true

  if (isCollection && method === 'GET') {
    sendJson(res, 200, { object: 'list', data: userStore.all().map(sanitize) })
    return true
  }

  if (isCollection && method === 'POST') {
    await createUser(req, res, ctx)
    return true
  }

  if (!match) return false
  const username = decodeSegment(match[1])
  const action = match[2]
  const target = userStore.getByUsername(username)
  if (!target) {
    sendJson(res, 404, { error: '用户不存在' })
    return true
  }

  if (!action && method === 'PATCH') {
    await patchUser(username, req, res, ctx)
    return true
  }

  if (!action && method === 'DELETE') {
    if (target.username === user.username) {
      sendJson(res, 400, { error: '不能删除自己' })
      return true
    }
    userStore.delete(username)
    sendJson(res, 200, { ok: true })
    return true
  }

  if (action === 'reset-key' && method === 'POST') {
    const key = userStore.resetApiKey(username)
    sendJson(res, 200, { ok: true, apiKey: key })
    return true
  }

  if (action === 'password' && method === 'POST') {
    await setUserPassword(username, req, res, ctx)
    return true
  }

  sendJson(res, 404, { error: '未知操作' })
  return true
}
