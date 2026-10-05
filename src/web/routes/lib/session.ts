/**
 * 身份解析 ---- cookie 会话 或 API Key,两条路都认.
 *
 *
 * 而 /v1/* 那条路认 API Key(由 server.js 的 apiKeys / userStore 校验),
 * 同一个 key 在 /v1/models 上是 200,在 /api/logs 上是 401 ----
 * 同一个凭据两套口径,用户无从理解,也无法自助排障.
 *
 * 这里把两条路统一:先从 cookie 取会话;取不到再按 Authorization: Bearer
 * 里的 API Key 反查用户.命中即视为该用户(沿用其 role,权限检查不变).
 *
 * 安全性:API Key 本就是该用户的长期凭据(前端"用户管理"里可见,
 * 可重置),拿它读自己账号池的状态与日志不扩大暴露面.未认证仍然 401.
 */
import { parseCookies } from '../../../util/http.ts'
import type { IncomingMessage } from 'node:http'

export const SESSION_COOKIE = 'fb_session'

/**
 * 解析当前请求的身份.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{userStore: any, webSessions: any, config: any}} ctx 路由上下文
 * @returns {any | null} 用户对象;未认证为 null
 */
export function getSessionUser(req: IncomingMessage, ctx: any) {
  const { userStore, webSessions, config } = ctx
  const cookies = parseCookies(req.headers.cookie)
  const token = cookies[SESSION_COOKIE]
  const username = token ? webSessions.get(token) : null
  if (username) return userStore.getByUsername(username)

  // 回落:Authorization: Bearer <API Key>(与 /v1/* 同一凭据口径)
  const auth = req.headers.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(String(auth).trim())
  if (!m) return null
  const key = m[1].trim()
  if (!key) return null
  // 先按 Web 用户的 apiKey 反查(控制台"用户管理"里那把)
  const byKey = userStore.getByApiKey?.(key)
  if (byKey) return byKey
  // 再认 server.api_keys(config.yaml 里的超级 Key):它没有对应用户,
  // 按 admin 对待 ---- 能配这个 key 的人本来就掌控整台服务.
  const superKeys = config?.server?.apiKeys || []
  if (superKeys.length && superKeys.includes(key)) {
    return { username: 'api-key', role: 'admin', apiKey: key }
  }
  return null
}
