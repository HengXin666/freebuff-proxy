/**
 * 出网传输层:带[池内回落 + 单次尝试超时]的 fetch.
 *
 * 出口判据不在这里 ---- 它只有一个真源, 在 ./egress/resolve.ts. 这一层只回答
 * "这次请求怎么发, 出口坏了换谁", 不回答"从哪个出口出去".
 * 它不知道任何上游协议(路径/头/签名).
 */
import { fetch as undiciFetch } from 'undici'
import { logger } from '../../util/log.ts'

/**
 * 带单次超时的 undici fetch:超时主动 abort 本次尝试.用独立的子 AbortController
 * 级联父 signal -- 单次尝试超时只拆掉这一次请求(回落池内下一个),不会把整个
 * 请求/其他代理尝试一起 abort;父 signal(客户端断开 / 全局超时)abort 时本次
 * 尝试立即随之失败.
 *
 * @param {string} url 请求 URL
 * @param {Record<string, any>} init undici fetch 初始化对象(可含 signal)
 * @param {number} timeoutMs 本次尝试的超时毫秒
 * @returns {Promise<Response>} 上游响应
 */
async function fetchWithAttemptTimeout(url: string, init: Record<string, any>, timeoutMs: number): Promise<any> {
  if (!(timeoutMs > 0)) return undiciFetch(url, init)
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (init.signal?.aborted) {
    // 父 signal 已中止(客户端断开/全局超时已发生):本次尝试立即失败,
    // 不等 20s 超时, 免得池内每个代理都空等一轮.
    controller.abort()
  } else {
    init.signal?.addEventListener('abort', onParentAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (timer.unref) timer.unref()
  try {
    return await undiciFetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onParentAbort)
  }
}

/** 代理感知 fetch 的签名. */
type ProxyAwareFetch = (url: string, init?: Record<string, any>) => Promise<any>

/** createProxyFetch 的返回. */
interface ProxyFetchResult {
  fetch: ProxyAwareFetch
  proxyUrl: string | null
}

/** createProxyFetch 的选项. */
interface ProxyFetchOpts {
  proxy?: string | null
  accountId?: string
}

/**
 * 构造带代理池的 fetch(供统一出口 createEgress 使用).
 *  - 无代理 / 单代理 / env:直接走对应 dispatcher
 *  - 全局池:优先分配到的代理,连接级失败(fetch 抛错)时依次回落到池内下一个;
 *    单次尝试带超时(fetchWithAttemptTimeout) -- 代理"连接成功但永不响应"
 *    (网络波动/黑洞)也会被视为失败并回落下一个, 可少于全局 timeoutMs 就放弃本次.
 *
 * 重要:单代理池也必须走 pool 分支.resolveProxy 的 pool 分支只返回 agents
 * 数组,没有 agent 字段;若把 <=1 的池当"非池"处理,agent 恒为 undefined →
 * 走 globalThis.fetch 直连, 代理被整个绕过(上游拿到宿主真实出口 IP, 账号被
 * 按地区判定,报 session_model_mismatch/limited 等 -- issue #5 根因).
 * 单代理池走同一循环:dispatcher=池内唯一代理,连接失败仍走兜底重试.
 *
 * @param {ReturnType<typeof resolveProxy>} proxyRes 代理解析结果
 * @param {number} poolIndex 本账号分配到的池内下标(稳定哈希)
 * @returns {(url: string, init?: Record<string, any>) => Promise<Response>} 代理感知 fetch
 */
function buildFetchWithProxy(proxyRes: any, poolIndex: number): ProxyAwareFetch {
  return async function fetchWithProxy(url, init) {
    if (proxyRes.kind !== 'pool') {
      const agent = proxyRes.agent
      return (agent ? undiciFetch : globalThis.fetch)(url, {
        ...init,
        ...(agent ? { dispatcher: agent } : {}),
      })
    }
    // 单代理尝试超时:取调用方超时与 20s 的较小值(代理 CONNECT + TLS + 响应头
    // 正常数秒内完成,20s 足够;整体请求的超时仍由调用方 signal 兜底).
    const callerMs =
      Number.isFinite(init?.timeoutMs) && (init as any).timeoutMs > 0 ? (init as any).timeoutMs : 30_000
    const attemptMs = Math.min(callerMs, 20_000)
    let lastErr
    for (let i = 0; i < proxyRes.agents.length; i++) {
      const idx = (poolIndex + i) % proxyRes.agents.length
      try {
        return await fetchWithAttemptTimeout(
          url,
          { ...init, dispatcher: proxyRes.agents[idx] },
          attemptMs,
        )
      } catch (err) {
        lastErr = err
        logger.warn('proxy failed; trying next in pool', {
          proxy: proxyRes.urls[idx],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    throw lastErr
  }
}

export { buildFetchWithProxy }
