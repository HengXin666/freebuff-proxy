/**
 * models 域的门面:把"清单侧"与"自定义侧"两个文件合成一个 handle.
 *
 */
import { handleList } from './list.ts'
import { handleCustom } from './custom.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * models 域入口.
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
  if (await handleList(method, route, res, ctx)) return true
  if (await handleCustom(method, route, req, res, user, ctx)) return true
  return false
}
