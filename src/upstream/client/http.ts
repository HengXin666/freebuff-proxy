/**
 * 上游 HTTP 出站层:统一装配头(UA / Bearer / 目录头 / 设备签名)与超时.
 *
 * 本文件不使用任何闭包变量:所有从 createUpstreamClient 传进来的依赖都走显式
 * ctx 参数, 避免依赖未声明的外层名字(那类错误只在运行时抛 ReferenceError).
 */
import { logger } from '../../util/log.ts'
import { freebuffAuthHeaders } from '../../auth-store.ts'
import { safeText, UpstreamError } from './errors/index.ts'

/**
 * @typedef {object} UpstreamCtx
 * @property {string} apiBase 上游 API 主机
 * @property {string} token 上游 token
 * @property {any} config 已加载配置
 * @property {{ fetch: () => Promise<boolean>, ready: boolean, fetchId: string | null,
 *   headers: () => any, fetchOnlyHeaders: () => any }} catalog 目录持有者
 * @property {{ headersFor: (args: object) => Promise<any> } | null} deviceSigner 设备签名器
 * @property {(url: string, init?: any) => Promise<Response>} fetchWithProxy 代理感知 fetch
 */

/**
 * 装配并发出一个上游请求(头集逐字对齐官方形态).
 *
 * - 默认 UA 用 Bun/<version>(官方 CLI 非 chat 调用即如此),调用方可覆盖;
 * - 鉴权只发 Bearer(客户端 165 条抓包里 x-codebuff-api-key 出现 0 次);
 * - 目录头 best-effort(抓不到就不带,走 legacy 路径);
 * - 设备签名三头 best-effort,且必须在 body 确定之后调用.
 *
 * @param {UpstreamCtx} ctx 出站依赖(由 createUpstreamClient 装配)
 * @param {string} path 端点路径或完整 URL
 * @param {Record<string, any>} [init] 请求初始化(含 includeAuth/catalog/timeoutMs/signal 等开关)
 * @returns {Promise<Response>} 上游响应
 */
export async function apiFetch(ctx: any, path: string, init: any = {}): Promise<Response> {
  const { apiBase, config, fetchWithProxy } = ctx
  const url = path.startsWith('http') ? path : `${apiBase}${path}`
  const headers = await buildHeaders(ctx, url, init)
  const controller = new AbortController()
  const timeoutMs = init.timeoutMs ?? config.limits.upstreamTimeoutSec * 1000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (init.signal) {
    if (init.signal.aborted) controller.abort()
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    return await fetchWithProxy(url, {
      method: init.method || 'GET',
      headers,
      body: init.body,
      signal: controller.signal,
      timeoutMs,
      duplex: init.body && typeof init.body !== 'string' ? 'half' : undefined,
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 装配一个上游请求的头集(UA / Bearer / 目录头 / 设备签名).
 *
 * @param {UpstreamCtx} ctx 出站依赖
 * @param {string} url 完整 URL(设备签名覆盖它)
 * @param {Record<string, any>} init 请求初始化
 * @returns {Promise<Record<string, any>>} 头集
 */
async function buildHeaders(ctx: any, url: string, init: any): Promise<Record<string, any>> {
  const { token, catalog, deviceSigner } = ctx
  const headers = { ...(init.headers || {}) }
  // 官方 CLI 的非 chat 调用(session/agent-runs/me/usage)都是裸 bun fetch,
  // 默认 UA = Bun/<version>. chat 请求由调用方显式传 ai-sdk UA 覆盖
  // (见 proxy.js forwardCompletions).
  if (!headers['user-agent'] && !headers['User-Agent']) {
    headers['user-agent'] = ctx.bunUserAgent
  }
  // 鉴权只发 Bearer: 客户端 165 条抓包里 x-codebuff-api-key 出现 0 次
  // (docs/reverse/20 20.4), 官方形态即只发 Bearer.
  if (token && init.includeAuth !== false) {
    Object.assign(headers, freebuffAuthHeaders(token))
  }
  // 目录头(x-freebuff-catalog-protocol / -fetch):服务端据此把请求认作目录客户端
  // 并使用句柄而非 legacy 模型 id.best-effort:抓不到就不带,走 legacy 路径.
  if (init.catalog !== false) {
    const ok = await catalog.fetch().catch(() => false)
    // chat 只带 catalog-fetch(官方 8 头里没有 catalog-protocol)
    if (ok) {
      Object.assign(headers, init.catalogFetchOnly ? catalog.fetchOnlyHeaders() : catalog.headers())
    }
  }
  // 设备签名三头(x-freebuff-device-{key,ts,sig}).best-effort:没有密钥或注册
  // 失败时返回 {},请求照旧发出(上游退回未签名路径).
  // 必须在 body 确定之后调用 -- 签名覆盖的是实际发送的 body 字节.
  if (deviceSigner) {
    const sigHeaders = await deviceSigner.headersFor({
      method: init.method || 'GET',
      url,
      body: typeof init.body === 'string' ? init.body : null,
      // 签名载荷里的 fetchId 必须与 x-freebuff-catalog-fetch 头完全一致 --
      // 它把请求绑定到签发句柄的那次目录抓取. 传 null 会让签名与头不匹配,
      // 服务端验签失败 -> 等同于未签名.
      fetchId: catalog.ready ? catalog.fetchId : null,
    })
    Object.assign(headers, sigHeaders)
  }
  // 可观测性:把本次实际发出的指纹面记录下来,便于与官方抓包逐头对比.
  if (init.logFingerprint) {
    logger.info('outgoing request fingerprint', {
      url: url.slice(0, 80),
      method: init.method || 'GET',
      headers: Object.keys(headers).sort(),
    })
  }
  return headers
}

/**
 * 登录类请求(/api/auth/cli/code,/api/auth/cli/status)的瞬时故障重试.
 *
 * 适用范围: 代理池回落 + 单次尝试超时只存在于 fetchWithProxy 的 pool 分支;
 * resolveProxy 在[无代理且无环境变量]时返回 kind:'none', fetchWithProxy 直接走
 * 裸 fetch 一次性返回, 没有任何回落. 所以这里补[同代理重试一次].
 *
 * 只重试瞬时错误(中止/网络层失败/常见 socket 码); 4xx/5xx 走 UpstreamError 不重试.
 * 不改变换号/换出口语义: loginCode/loginStatus 幂等或可重复, 重试不会多买会话,
 * 不动账号账本.
 *
 * @param {UpstreamCtx} ctx 出站依赖
 * @param {string} url 完整 URL
 * @param {Record<string, any>} init 请求初始化
 * @param {string} label 日志标签(login/code,login/status)
 * @returns {Promise<Response>} 上游响应
 * @throws {UpstreamError} 重试后仍失败时,带稳定错误码(upstream_timeout / upstream_network)
 */
export async function fetchLoginUpstream(ctx: any, url: string, init: any, label: string): Promise<Response> {
  const attempts = 2
  let lastErr: any
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await apiFetch(ctx, url, init)
    } catch (err) {
      lastErr = err
      const name = (err as any)?.name
      const code = (err as any)?.code
      const transient =
        name === 'AbortError' ||
        name === 'TypeError' || // undici 网络层失败(fetch failed)
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN' ||
        code === 'ENOTFOUND' ||
        code === 'ECONNREFUSED' ||
        code === 'EPIPE'
      if (!transient || attempt === attempts) break
      logger.warn('login upstream transient failure; retrying same route', {
        label,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // 给出可诊断的错误码, 不把 AbortError 原文甩给前端
  if (lastErr?.name === 'AbortError') {
    throw new UpstreamError(
      `上游登录请求超时（${init.timeoutMs ?? '?'}ms），请重试`,
      // 超时没有底层 socket 码,cause 给一个稳定的字面量,保持字段不缺
      { code: 'upstream_timeout', cause: 'timeout' },
    )
  }
  if (lastErr?.name === 'TypeError') {
    /**
     * code 必须是稳定的业务码, 不能透 Node 底层码.
     *
     * 本仓的 code 是业务判据: 多处按集合匹配(SLOT_BUSY_CODES /
     * UNAVAILABLE_COOLDOWN_CODES / EXHAUST_CODES ...). 透出裸 socket 码会让这些
     * 匹配被误命中.
     *
     * 底层码仍要可见, 两处都给:
     *   1. message 里带一份(前端弹窗直接显示);
     *   2. cause 字段带一份(结构化, 供前端程序化判断与后端排障).
     * code 保持稳定的 upstream_network.
     */
    throw new UpstreamError(
      `上游登录请求网络失败：${lastErr.message}（${lastErr.code ?? 'unknown'}）`,
      { code: 'upstream_network', cause: lastErr.code ?? undefined },
    )
  }
  throw lastErr
}

export { safeText }
