/**
 * 请求级日志上下文 ---- 给一次下游请求一个全链路 id.
 *
 * 有了 reqId,一次请求的选号 / 会话 / 上游调用会自动归成一组;账号在选号后
 * 由 patchLogContext 补上.
 */
import { randomUUID } from 'node:crypto'

import { runWithLogContext } from '../util/log.ts'

/**
 * 在带 reqId 的日志上下文里执行一次请求处理.
 * @param {import('node:http').IncomingMessage} req 下游请求
 * @param {import('node:http').ServerResponse} res 下游响应
 * @param {(req: object, res: object) => Promise<void>} handler 真正的处理逻辑
 * @returns {Promise<void>} 处理完成
 */
export function withRequestId(req: any, res: any, handler: any) {
  const reqId = randomUUID().slice(0, 8)
  return runWithLogContext({ reqId }, () => handler(req, res))
}
