/**
 * 请求级日志上下文 ---- 给一次下游请求一个全链路 id.
 *
 * 为什么单独成一个模块:src/server.js 要满足 ≤300 行的体量红线,而它是本仓
 * 最容易继续膨胀的装配点(每接一个路由就往里塞一段).把"与具体路由无关的
 * 横切关注点"先搬出来,装配层才留得住.
 *
 * 实测背景(控制台[日志]页的可用性):此前每条日志只有 ts/level/msg/fields,
 * 多账号池并发时完全交织,排障只能靠猜.有了 reqId,一次请求的选号 / 会话 /
 * 上游调用会自动归成一组.账号在选号后由 patchLogContext 补上.
 */
import { randomUUID } from 'node:crypto'

import { runWithLogContext } from '../util/log.js'

/**
 * 在带 reqId 的日志上下文里执行一次请求处理.
 * @param {import('node:http').IncomingMessage} req 下游请求
 * @param {import('node:http').ServerResponse} res 下游响应
 * @param {(req: object, res: object) => Promise<void>} handler 真正的处理逻辑
 * @returns {Promise<void>} 处理完成
 */
export function withRequestId(req, res, handler) {
  const reqId = randomUUID().slice(0, 8)
  return runWithLogContext({ reqId }, () => handler(req, res))
}
