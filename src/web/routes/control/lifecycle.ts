/**
 * system 域的生命周期入口:全部断开重连 + 重启服务.
 *
 * 两者都会动上游计费会话,所以共用一条纪律:先严格释放会话,释放失败也
 * 如实回报并把句柄留在 sessions.json 等下次启动扫尾退款 ---- 绝不谎报"已经干净".
 */
import { sendJson } from '../../../util/http.js'
import { logger } from '../../../util/log.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 严格释放全部会话的结果(与 AccountRuntimes.releaseAllStrict() 的返回一致).
 *
 * 必须在 .ts 里显式声明:JSDoc 的 @type 在 TypeScript 文件里不参与推导
 * (类型一律从初始化式推),所以 failed: [] 会被推成 never[].
 */
interface ReleaseAllResult {
  ok: boolean
  released: number
  failed: Array<{ key: string, instanceId?: string, error?: string }>
}

/**
 * 前端"全部断开重连":比重启更轻量.释放所有账号 session,清理死任务,
 * 下一个请求自动 admit 全新 session;进程不重启.
 *
 * 严格释放:有任何一条没删掉就如实告诉用户(并已留在 sessions.json
 * 等下次启动扫尾重试),绝不谎报"已全部断开".
 *
 * @param {ServerResponse} res
 * @param {any} runtimes 账号运行时集合
 * @returns {Promise<void>}
 */
async function reconnectAll(res: ServerResponse, runtimes: any) {
  const accounts = await runtimes.reconnectAll()
  const failed = accounts.filter((a: any) => !a.ok)
  sendJson(res, 200, {
    ok: failed.length === 0,
    message: failed.length
      ? `已释放 ${accounts.length - failed.length}/${accounts.length} 条会话，${failed.length} 条取消失败（已记录句柄，服务下次启动会自动重试退款）`
      : '已断开全部 session，下次请求将自动重建；正在传输的连接可能被中断',
    accounts,
    failed,
  })
}

/**
 * 重启前严格释放所有上游会话;失败也不阻塞重启.
 *
 * 进程一退出内存里的 instanceId 就没了,不放就会留下无法寻址的孤儿:
 * 既白占上游会话槽位,那笔已预扣的钱也追不回来.释放失败时句柄已落盘
 * sessions.json,新进程启动扫尾.
 *
 * 显式标注返回类型:初始化式里的 failed: [] 会被推成 never[],
 * 把真实的 { key, error } 明细赋进来就报 TS2322.
 *
 * @param {any} runtimes 账号运行时集合
 * @returns {Promise<ReleaseAllResult>} 释放明细(失败时带回一条 '*' 记录)
 */
async function releaseBeforeRestart(runtimes: any): Promise<ReleaseAllResult> {
  try {
    return await runtimes.releaseAllStrict({ waitInFlightMs: 3_000 })
  } catch (err) {
    logger.warn('pre-restart session release failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      ok: false,
      released: 0,
      failed: [
        { key: '*', error: err instanceof Error ? err.message : String(err) },
      ],
    }
  }
}

/**
 * 前端"重启服务":admin 专属,彻底解决幽灵连接等进程级问题.
 *
 * @param {ServerResponse} res
 * @param {any} runtimes 账号运行时集合
 * @param {() => void} restart 自重启回调
 * @returns {Promise<void>}
 */
async function restartService(res: ServerResponse, runtimes: any, restart: () => void) {
  const release = await releaseBeforeRestart(runtimes)
  sendJson(res, 200, {
    ok: true,
    message: release.failed.length
      ? `已释放 ${release.released} 条会话（${release.failed.length} 条待新进程启动后重试退款）；服务正在重启，约几秒后恢复`
      : '会话已全部释放退款，服务正在重启，约几秒后恢复',
    release,
  })
  // 先让响应完整落地到客户端,再触发自重启
  setTimeout(() => {
    try {
      restart()
    } catch (err) {
      logger.error('system restart failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, 300)
}

/**
 * 生命周期端点(admin 专属).
 *
 * @param {string} method HTTP 方法
 * @param {string} route 规范化路径
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
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
  const { runtimes, restart } = ctx
  if (route !== '/api/system/reconnect' && route !== '/api/system/restart') return false
  if (user.role !== 'admin') {
    sendJson(res, 403, { error: '需要管理员权限' })
    return true
  }

  if (method === 'POST' && route === '/api/system/reconnect') {
    logger.info('reconnect-all requested via web console', { by: user.username })
    await reconnectAll(res, runtimes)
    return true
  }

  if (method === 'POST' && route === '/api/system/restart') {
    if (typeof restart !== 'function') {
      sendJson(res, 501, { error: '当前进程未启用重启功能' })
      return true
    }
    logger.info('system restart requested via web console', { by: user.username })
    await restartService(res, runtimes, restart)
    return true
  }
  return false
}
