/**
 * 路由处理器共用的权限与路径段小工具.
 *
 * handle 返回 true 表示"这条请求我已处理完(含 4xx/5xx)",
 * 由 dispatcher 用来决定是否继续往下试别的域.把它收在一处,
 * 免得某个域改了自己的返回语义,dispatcher 却按旧语义判断.
 */
import { sendJson } from '../../../util/http.js'
import type { ServerResponse } from 'node:http'

/**
 * 管理员闸门:非 admin 立刻 403 并返回 true(已处理).
 *
 * @param {any} user 当前用户
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} true = 已处理(非管理员已被拒)
 */
export function denyUnlessAdmin(user: any, res: ServerResponse) {
  if (user?.role === 'admin') return false
  sendJson(res, 403, { error: '需要管理员权限' })
  return true
}

/**
 * 解析路径参数(decodeURIComponent 失败时回落原值,避免 500).
 *
 * @param {string} raw 原始路径段
 * @returns {string} 解码后的段
 */
export function decodeSegment(raw: any) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
