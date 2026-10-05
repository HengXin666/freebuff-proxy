/**
 * login-flows 域:浏览器登录回调流程(admin 专属)+ 登录回执的结构化判据.
 *
 * 起点是 POST /api/accounts/login 发起一次上游登录,然后前端轮询
 * GET /api/accounts/login/:id 拿状态,必要时 POST .../:id/cancel.
 */
import { sendJson } from '../../../util/http.ts'
import { logger } from '../../../util/log.ts'
import { denyUnlessAdmin, decodeSegment } from '../lib/http-codes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

const FLOW_RE = /^\/api\/accounts\/login\/([^/]+)(?:\/([^/]+))?$/

/**
 *
 * ! 除 error(给人看)之外,还要把结构化判据传给前端:
 *
 *   - code  稳定业务码:upstream_timeout / upstream_network
 *     (来自 fetchLoginUpstream,见 src/upstream/client.ts).
 *     前端据此给出对应的提示/重试引导(不匹配中文文案).
 *   - cause 底层原始错误码(如 ECONNREFUSED / ENOTFOUND / ETIMEDOUT).
 *     error 字符串里已经带了它供人阅读,这里单独给一份供程序读取.
 *
 * 只给 error 字符串的后果:前端想区分"DNS 挂了"和"超时"只能解析中文,
 * 文案一改就崩.两个字段都给,人和程序各自取用.
 *
 * @param {any} res
 * @param {any} err 抛出的错误
 * @returns {void}
 */
function sendStartFailure(res: ServerResponse, err: any) {
  sendJson(res, 502, {
    error: `发起登录失败: ${err instanceof Error ? err.message : String(err)}`,
    code: err?.code ?? null,
    cause: err?.cause ?? null,
  })
}

/**
 * login-flows 域入口.
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
  const { loginFlows } = ctx
  if (!route.startsWith('/api/accounts/login')) return false
  if (denyUnlessAdmin(user, res)) return true
  if (method === 'POST' && route === '/api/accounts/login') {
    try {
      const flow = await loginFlows.start()
      logger.event('loginFlow', 'info', 'web login flow started', { id: flow.id })
      sendJson(res, 200, { ok: true, flow })
    } catch (err) {
      sendStartFailure(res, err)
    }
    return true
  }

  if (method === 'GET' && route === '/api/accounts/login') {
    sendJson(res, 200, { object: 'list', data: loginFlows.list() })
    return true
  }

  const m = route.match(FLOW_RE)
  if (m) {
    const id = decodeSegment(m[1])
    const action = m[2]
    if (!action && method === 'GET') {
      const flow = loginFlows.get(id)
      if (!flow) {
        sendJson(res, 404, { error: '流程不存在' })
        return true
      }
      sendJson(res, 200, { flow })
      return true
    }
    if (action === 'cancel' && method === 'POST') {
      loginFlows.cancel(id)
      sendJson(res, 200, { ok: true })
      return true
    }
  }
  sendJson(res, 404, { error: '未知登录流程操作' })
  return true
}
