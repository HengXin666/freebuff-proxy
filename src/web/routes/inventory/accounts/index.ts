/**
 * accounts 域的门面:把"存储侧 / 刷新侧 / 单账号动作侧"合成一个 handle.
 *
 * ! 顺序有语义:login 前缀必须先于 :key 匹配,否则
 * /api/accounts/login 会被当成 key 为 login 的账号 ---- 这是显式返回
 * (而不是落到 404)的原因.
 */
import { handle as handleStore } from './store.ts'
import { probeAll, refreshAll } from './refresh.ts'
import { handle as handleActions } from './actions.ts'
import { handle as handleLoginFlows } from '../login-flows.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * accounts 域入口.
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
  // login 流程是一族子路径,先交给它;未命中它会自己 404(与原实现一致).
  if (route.startsWith('/api/accounts/login')) {
    return handleLoginFlows(method, route, req, res, user, ctx)
  }
  if (method === 'POST' && route === '/api/accounts/probe') {
    await probeAll(res, ctx)
    return true
  }
  if (method === 'POST' && route === '/api/accounts/refresh') {
    await refreshAll(res, ctx)
    return true
  }
  if (await handleActions(method, route, req, res, user, ctx)) return true
  if (await handleStore(method, route, req, res, user, ctx)) return true
  return false
}
