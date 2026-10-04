/**
 * 会话端点:/api/v1/freebuff/session 的 GET / POST(admission) / DELETE.
 *
 * 拆分为三个文件(本文件 + session-headers.js + session-result.js),
 * 但保持一条请求的线性顺序可读:取头 → 发送(含 legacy 回落)→ 归一.
 *
 * 从 src/upstream/client.js 拆出(原 1499 行单文件).
 */
import { logger } from '../../../util/log.js'
import { SESSION_ADMISSION_ENDPOINT, SESSION_ENDPOINT } from '../../official-fingerprint.js'
import { parseRetryAfterMs } from '../errors.ts'
import { apiFetch } from '../http.ts'
import { normalizeSessionResult } from './session-result.ts'
import { sessionHeaders } from './session-headers.ts'

/**
 * 发一次 session 请求,POST 命中 404/405 时回落 legacy /session.
 *
 * 官方 POST 打 .../session/admission,GET/DELETE 打 .../session.优先用官方
 * 端点对齐指纹;老部署没有 /admission 时回落 legacy  --  绝不因为"对齐"丢掉
 * 可用性(官方自己把 404/405 当作 session_admission_unavailable,我们回落即可).
 *
 * @param {object} ctx 出站依赖
 * @param {'GET'|'POST'|'DELETE'} method 方法
 * @param {object} init apiFetch 的 init
 * @returns {Promise<Response>} 上游响应
 */
async function sendSession(ctx: any, method: string, init: any): Promise<Response> {
  const res = await apiFetch(
    ctx,
    method === 'POST' ? SESSION_ADMISSION_ENDPOINT : SESSION_ENDPOINT,
    init,
  )
  if (method === 'POST' && (res.status === 404 || res.status === 405)) {
    logger.warn('session admission endpoint unavailable; falling back', {
      status: res.status,
      fallback: SESSION_ENDPOINT,
    })
    return apiFetch(ctx, SESSION_ENDPOINT, init)
  }
  return res
}

/**
 * 会话端点(GET 读 / POST admission / DELETE 释放).
 *
 * @param {object} ctx 出站依赖(含 config / sessionViaBun / releaseViaBun)
 * @param {'GET'|'POST'|'DELETE'} method 方法
 * @param {{ model?: string, displayName?: string, instanceId?: string, compact?: boolean,
 *   signal?: AbortSignal, timeoutMs?: number, walletSpendLimit?: number,
 *   takeoverInstanceId?: string, heartbeat?: boolean }} [opts] 会话参数
 * @returns {Promise<any>} 会话回执体(404 → { status: 'none' })
 */
export async function freebuffSession(ctx: any, method: string, opts: any = {}): Promise<any> {
  const { config, sessionViaBun, releaseViaBun } = ctx
  /**
   * 只读查询(GET)优先交给 bun 通道执行.
   *
   * 为什么:Node 的内置 fetch 强制带 accept-language 与 sec-fetch-mode
   * (forbidden header,设不掉),客户端(bun)不带  --  在主服务里补头/删头
   * 永远补不到一致,只能换运行时.官方形态的实现只有一份(cli-bridge),
   * 这里只做端口调用.见 docs/reverse/21 §21.5.
   */
  if (method === 'GET') {
    // sessionViaBun() 已直接返回会话体(或 null),不是 {ok,body} 包装.
    //  必须透传 instanceId/heartbeat  --  否则 bun 侧 GET /session 永远不带
    // 实例标识,也永远不发持有心跳(admission 后 25 秒被退款的事故根因).
    const viaBun = await sessionViaBun({
      instanceId: opts.instanceId || null,
      heartbeat: opts.heartbeat === true,
    })
    if (viaBun && typeof viaBun === 'object') return viaBun
  }
  /**
   * DELETE 同样走 bun:它必须带 x-freebuff-instance-id,否则上游 400
   * instance_required,槽位退不掉(账号会一直被占).
   */
  if (method === 'DELETE' && opts.instanceId) {
    const released = await releaseViaBun(opts.instanceId)
    if (released != null) return released
  }
  const headers = await sessionHeaders(ctx, method, opts)
  const init = {
    method,
    headers,
    signal: opts.signal,
    // 调用方可给单次超时(启动扫尾用它把等待压进总预算):不带就沿用
    // admitTimeoutMs.启动路径不允许被一个连不通的上游拖住.
    timeoutMs:
      Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : config.session.admitTimeoutMs,
    includeAuth: false, // already set
  }
  const res = await sendSession(ctx, method, init)
  if (res.status === 404) {
    return { status: 'none' }
  }
  const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
  const text = await res.text()
  // 调试:打印上游原文,用于定位 admission 失败的真因(错误码被上层
  // sanitize 精简后看不出所以然).
  if (process.env.FB_DEBUG_SESSION_HEADERS === '1') {
    logger.info('session response raw', {
      method,
      status: res.status,
      text: String(text || '').slice(0, 600),
    })
  }
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  return normalizeSessionResult({ res, body, method, retryAfterMs })
}
