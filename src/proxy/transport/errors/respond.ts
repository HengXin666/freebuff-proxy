/**
 * 失败归类与下游错误响应 ---- 从 stream-pipe.js 按职责切出.
 *
 * 都是"把一次失败翻成 HTTP 响应"这一件事:管道失败归类,两类流错误,错误体映射.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { sendJson } from '../../../util/http.ts'
import { UpstreamError } from '../../../upstream/client.ts'

/** 管道失败归类后交给调用方的处置结论. */
export interface StreamPipeFailure {
  /** 恒为 false:归类结果表示"这条请求已经失败". */
  ok: false
  /** 是否已经把字节写给下游(决定还能不能整体重试). */
  wrote: boolean
  /** 是否值得整体重试. */
  recoverable: boolean
  /** 是否应冷却当前账号并换号. */
  switchAccount: boolean
  /** 归类出的 gate 码(写日志与统计用). */
  gateCode: string
  /** 建议回给下游的 HTTP 状态码. */
  status: number
  /** 可选的错误体. */
  body?: unknown
  /** 可选的额外响应头. */
  headers?: Record<string, string>
}

/**
 * 上游流式 body 透传失败的处理(幽灵连接/客户端断开):
 * - 上游卡死(idle 超时)→ 200 响应头已提交(writeHead 在 pipe 之前),无法整体
 *   重试;直接销毁连接,让客户端感知截断后自行重试.不冷却账号(session 可能
 *   正常,只是那次传输卡了),下一请求仍可复用该 session.
 * - 客户端主动断开 → 静默终止:不重试,不冷却,不写错误.
 * @param {unknown} err 管道失败原因(stalled / client_gone 等标记挂在它身上)
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {StreamPipeFailure} 交给调用方的处置结论(见该接口定义)
 */
export function handleStreamPipeFailure(
  err: unknown,
  req: IncomingMessage,
  res: ServerResponse,
): StreamPipeFailure {
  const e = (err ?? {}) as { stalled?: boolean; code?: string; name?: string }
  const stalled = Boolean(e.stalled || e.code === 'stream_idle_timeout')
  if (stalled) {
    return {
      ok: false,
      wrote: true,
      recoverable: false,
      switchAccount: false,
      gateCode: 'stream_idle_timeout',
      status: 504,
      body: {
        error: {
          message: 'upstream stream idle timeout',
          type: 'upstream_error',
          code: 'stream_idle_timeout',
        },
      },
      headers: {},
    }
  }
  // 客户端主动断开(pipe 内 res.destroy 是我们自己触发的,不能用来判断客户端状态)
  if (req.destroyed || e.name === 'AbortError' || e.code === 'client_gone') {
    return {
      ok: false,
      wrote: true,
      recoverable: false,
      switchAccount: false,
      gateCode: 'client_disconnected',
      status: 499,
    }
  }
  throw err
}

/** 客户端在流式传输过程中断开(code 固定为 client_gone). */
export class ClientGoneError extends Error {
  /** 稳定业务码:上层按它判定"客户端已断". */
  code: string

  constructor() {
    super('client disconnected while streaming upstream response')
    this.name = 'ClientGoneError'
    this.code = 'client_gone'
  }
}

/**
 * 上游流式响应在 idleTimeoutMs 内没有新数据(幽灵连接).
 * @param idleTimeoutMs 判定卡死的静默时长(毫秒)
 */
export class StreamStallError extends Error {
  /** 稳定业务码:上层按它判定"上游卡死". */
  code: string

  /** 确定性 stall 标记(不依赖 race 谁先拒绝). */
  stalled: boolean

  constructor(idleTimeoutMs: number) {
    super(
      `upstream stream idle for ${idleTimeoutMs}ms without data; terminating`,
    )
    this.name = 'StreamStallError'
    this.code = 'stream_idle_timeout'
    this.stalled = true
  }
}

/**
 * 按上游原状态码写错误响应;响应头已发出时只能 end,不能再改状态.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status HTTP 状态码(0/缺省按 502 处理)
 * @param {unknown} body 上游错误体(对象原样下发;字符串包成 error.message)
 * @param {Record<string, string>} [headers] 额外响应头
 */
export async function writeUpstreamError(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  if (res.headersSent) {
    res.end()
    return
  }
  if (body && typeof body === 'object') {
    sendJson(res, status || 502, body, headers)
    return
  }
  sendJson(res, status || 502, {
    error: {
      message: typeof body === 'string' ? body : 'Upstream error',
      type: 'upstream_error',
    },
  })
}

/**
 * 把任意抛出物映射成下游可读的错误响应(UpstreamError 保留 code 与 Retry-After).
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} err 抛出的错误(UpstreamError 走它自带的 status/code/retryAfterMs)
 */
export function mapAndSendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      // ignore
    }
    return
  }
  if (err instanceof UpstreamError) {
    // UpstreamError 的字段声明在 src/upstream/client/errors.ts(.ts 迁移进行中,
    // 尚未补显式字段),因此这里显式收窄一次,避免整条错误映射链失去检查.
    const ue = err as UpstreamError & {
      status?: number
      code?: string
      body?: unknown
      retryAfterMs?: number
    }
    const status = ue.status || 502
    const body =
      ue.body && typeof ue.body === 'object'
        ? Reflect.get(ue.body as object, 'error')
          ? err.body
          : {
              error: {
                message: err.message,
                type: 'freebuff_error',
                code: ue.code,
                details: ue.body as Record<string, unknown>,
              },
            }
        : {
            error: {
              message: ue.message,
              type: 'freebuff_error',
              code: ue.code,
            },
          }
    const headers: Record<string, string> = {}
    if (ue.retryAfterMs != null) {
      headers['retry-after'] = String(Math.ceil(ue.retryAfterMs / 1000))
    }
    sendJson(res, status, body, headers)
    return
  }
  sendJson(res, 500, {
    error: {
      message: err instanceof Error ? err.message : String(err),
      type: 'proxy_error',
    },
  })
}
