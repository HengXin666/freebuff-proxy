/**
 * auth 域:登录 / 登出 / 当前身份.
 *
 * 登录是唯一的公开端点(不需要 fb_session),所以它单独走
 * handlePublic,在 dispatcher 拿到 user 之前调用;其余两个要求已认证.
 */
import { sendJson, serializeCookie } from '../../../../util/http.js'
import { sanitize } from '../../lib/helpers.ts'
import { SESSION_COOKIE } from '../../lib/session.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 公开端点:POST /api/auth/login.
 *
 * @param {string} method HTTP 方法
 * @param {string} route 规范化路径
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handlePublic(method: string, route: string, req: IncomingMessage, res: ServerResponse, ctx: any) {
  const { config, userStore, webSessions, readJson } = ctx
  if (!(method === 'POST' && route === '/api/auth/login')) return false
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return true
  }
  const user = userStore.verifyPassword(body.username, body.password)
  if (!user) {
    sendJson(res, 401, { error: '用户名或密码错误' })
    return true
  }
  const token = webSessions.create(user.username)
  res.setHeader(
    'set-cookie',
    serializeCookie(SESSION_COOKIE, token, {
      maxAge: config.web.sessionTtlHours * 3600,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: Boolean(config.web.cookieSecure),
    }),
  )
  sendJson(res, 200, { ok: true, user })
  return true
}

/**
 * 已认证端点:POST /api/auth/logout,GET /api/me.
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
  const { userStore, webSessions, parseCookies } = ctx
  if (method === 'POST' && route === '/api/auth/logout') {
    const cookies = parseCookies(req.headers.cookie)
    if (cookies[SESSION_COOKIE]) webSessions.destroy(cookies[SESSION_COOKIE])
    res.setHeader(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, '', {
        maxAge: 0,
        path: '/',
        httpOnly: true,
      }),
    )
    sendJson(res, 200, { ok: true })
    return true
  }

  if (method === 'GET' && route === '/api/me') {
    const apiKey = userStore.getByUsername(user.username)?.apiKey
    sendJson(res, 200, { user: { ...sanitize(user), apiKey } })
    return true
  }
  return false
}
