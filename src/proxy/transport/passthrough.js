/**
 * 非 chat 的 /v1 透传处理器 -- 从 src/proxy.js 搬出.
 *
 * 它把 /v1/* 里除 chat 之外的请求原样转发到上游 /api/v1/*, 只带 Freebuff 鉴权,
 * 不做 session admit(chat 有自己的一套). 与前后逻辑无共享可变状态, 因此可以
 * 整体搬出.
 *
 * 口径: 纯搬移, 行为零改动.
 */

import { readRequestBody, sendJson } from '../../util/http.js'
import { filterRequestHeaders, filterResponseHeaders } from '../../util/http.js'
import { freebuffAuthHeaders } from '../../auth-store.js'
import { logger } from '../../util/log.js'
import { mapAndSendError } from './errors/respond.ts'
import { methodHasBody, pipeWebStreamToNode, reqToAbortSignal } from './stream/stream-pipe.ts'

/**
 - Non-chat /v1/* → upstream /api/v1/* with Freebuff auth only.
 - No session admit (chat has its own handler).
 */
export async function handleGenericPassthrough(ctx, req, res, url) {
  if (
    url.pathname === '/v1/chat/completions' ||
    url.pathname.startsWith('/v1/chat/completions/')
  ) {
    sendJson(res, 404, {
      error: {
        message: 'Use POST /v1/chat/completions',
        type: 'invalid_request_error',
        code: 'not_found',
      },
    })
    return
  }

  const rt = ctx.runtimes.getAny()
  const upstreamPath = `/api/v1${url.pathname.slice('/v1'.length)}${url.search}`
  const rawBuf = methodHasBody(req.method)
    ? await readRequestBody(req)
    : null

  const headers = {
    ...filterRequestHeaders(req.headers),
    ...freebuffAuthHeaders(rt.upstream.token),
  }
  if (rawBuf?.length && !headers['content-type']) {
    headers['content-type'] = 'application/json'
  }

  let upstreamRes
  try {
    const abortCtrl = reqToAbortSignal(req)
    try {
      upstreamRes = await rt.upstream.raw(upstreamPath, {
        method: req.method || 'GET',
        headers,
        body: rawBuf?.length ? rawBuf : undefined,
        signal: abortCtrl.signal,
      })
    } finally {
      abortCtrl.cleanup()
    }
  } catch (err) {
    mapAndSendError(res, err)
    return
  }

  const respHeaders = filterResponseHeaders(upstreamRes.headers)
  res.writeHead(upstreamRes.status, respHeaders)
  if (!upstreamRes.body) {
    res.end()
    return
  }
  try {
    await pipeWebStreamToNode(upstreamRes.body, res, req, {
      idleTimeoutMs: (ctx.config.limits.streamIdleTimeoutSec || 0) * 1000,
    })
  } catch (err) {
    // 上游卡死/客户端断开:透传没有换号语义,直接掐断连接(客户端自行重试)
    if (!res.destroyed) {
      try {
        res.destroy()
      } catch {
        // ignore
      }
    }
    logger.warn('passthrough stream failed', {
      path: upstreamPath,
      error: err instanceof Error ? err.message : String(err),
      stalled: Boolean(err?.stalled),
    })
  }
}
