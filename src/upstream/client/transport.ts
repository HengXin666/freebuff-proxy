/**
 * 出网传输层:代理解析 + 带[池内回落 + 单次尝试超时]的 fetch.
 *
 * 这一层只回答两个问题:这次请求从哪个出口出去,以及出口坏了换谁.
 * 它不知道任何上游协议(路径/头/签名),所以上游改 API 时这一层不用动.
 *
 * 从 src/upstream/client.js 拆出(原 1499 行单文件).
 */
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { logger } from '../../util/log.js'

/**
 * TLS 层对齐官方 CLI:ALPN 只 offer http/1.1.
 *
 * 真机抓包(mitmproxy 拦本地官方 CLI 进程)确认:
 *   Bun/1.3.14 → TLSv1.3, alpn=http/1.1, cipher=TLS_AES_256_GCM_SHA384
 * 而 undici 默认会同时 offer h2 与 http/1.1  --  与官方客户端不同,
 * 是一个可检测的 TLS 层差异.
 *
 * 注:Node 与 Bun 都用系统 OpenSSL 栈,cipher 本就一致(实测两侧都是
 * TLS_AES_256_GCM_SHA384).所以[Node 无法对齐指纹]只成立于浏览器
 * 目标(GREASE 是保留数值,OpenSSL 名字字符串表达不了);对齐 Bun 完全可行.
 */
const ALPN_TLS = Object.freeze({
  requestTls: { ALPNProtocols: ['http/1.1'] },
})

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
    // 不要等 20s 超时 -- 否则池内每个代理都要空等一轮.
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

/**
 * 解析出网代理配置,返回统一结构:
 *   { kind: 'none', agent: null, url: null }
 *   { kind: 'single', agent: ProxyAgent|EnvHttpProxyAgent, url: string }
 *   { kind: 'pool', agents: ProxyAgent[], urls: string[], indexFor(key) }   // 全局代理池
 * 优先级:账号显式 proxy > upstream.proxies(全局池) > upstream.proxy > HTTP(S)_PROXY env.
 *
 * @param {any} config 已加载配置
 * @param {string | null} [accountProxy] 账号显式代理
 * @param {string} [accountId] 池内稳定分配用的 key(不参与单代理分支)
 * @returns {{ kind: string, url?: string | null, agent?: any, urls?: string[],
 *   agents?: any[], indexFor: (key: string) => number }}
 *   代理解析结果
 */
function resolveProxy(config: any, accountProxy?: string | null, accountId?: string): any {
  // 最后一道防线:代理值可能是脏数据(数字 / 对象 / 畸形 URL),直接喂给
  // new ProxyAgent({uri}) 会抛 ERR_INVALID_URL  --  那发生在启动后的第一次
  // 出网调用(启动扫尾/首次请求),用户看到的就是"起不来/一用就崩".
  // 这里统一过一遍校验,非法值一律当作"没有这个代理".
  const clean = (v: unknown): string | null => {
    if (typeof v !== 'string') return null
    const s = v.trim()
    if (!s) return null
    try {
      const u = new URL(s)
      return ['http:', 'https:', 'socks5:', 'socks:'].includes(u.protocol) ? s : null
    } catch {
      return null
    }
  }
  const explicit = clean(accountProxy) || clean(config?.upstream?.proxy)
  if (explicit) {
    return {
      kind: 'single',
      url: explicit,
      agent: new ProxyAgent({ uri: explicit, ...ALPN_TLS }),
      indexFor: () => 0,
    }
  }
  const pool = (config?.upstream?.proxies || []).map(clean).filter(Boolean)
  if (pool.length) {
    return {
      kind: 'pool',
      urls: pool,
      agent: undefined,
      agents: pool.map((u: string) => new ProxyAgent({ uri: u, ...ALPN_TLS })),
      /** 稳定哈希:同一账号始终落到同一代理(保持 session IP 稳定) */
      indexFor: (key: string) => hashIndex(key, pool.length),
    }
  }
  const envSet = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some((k) =>
    Boolean(process.env[k]),
  )
  if (envSet) {
    return {
      kind: 'single',
      url: '(env HTTP(S)_PROXY)',
      agent: new EnvHttpProxyAgent({ ...ALPN_TLS }),
      indexFor: () => 0,
    }
  }
  return { kind: 'none', agent: null, url: null, indexFor: () => 0 }
}

/**
 * djb2 字符串哈希 → 池内下标(同一 key 稳定落同一下标).
 *
 * @param {string} key 分配 key(账号 id / 邮箱)
 * @param {number} n 池大小
 * @returns {number} [0, n) 的下标
 */
function hashIndex(key: any, n: number): number {
  let h = 5381
  for (const ch of String(key || '')) {
    h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  }
  return (h >>> 0) % n
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
 * 构造带代理池的 fetch(供 createUpstreamClient / createProxyFetch 共用).
 *  - 无代理 / 单代理 / env:直接走对应 dispatcher
 *  - 全局池:优先分配到的代理,连接级失败(fetch 抛错)时依次回落到池内下一个;
 *    单次尝试带超时(fetchWithAttemptTimeout) -- 代理"连接成功但永不响应"
 *    (网络波动/黑洞)也会被视为失败并回落下一个,而不是干等到全局 timeoutMs.
 *
 * 重要:单代理池也必须走 pool 分支.resolveProxy 的 pool 分支只返回 agents
 * 数组,没有 agent 字段;若把 <=1 的池当"非池"处理,agent 恒为 undefined →
 * 走 globalThis.fetch 直连,代理被整个绕过(上游拿到宿主真实出口 IP,账号被
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

/**
 * 供非上游 API 的出网请求使用的代理感知 fetch(如 catalog 自动同步拉 GitHub 源).
 * 复用与上游调用完全相同的代理解析与池回落逻辑,避免旁路直连.
 * 优先级:账号显式 proxy(可传) > upstream.proxies(全局池) > upstream.proxy > HTTP(S)_PROXY env > 直连.
 * 池分配 key 默认 'catalog'(池内稳定固定一个出口),可传 accountId 覆盖.
 *
 * @param {import('../../config.js').ProxyConfig} config 已加载配置
 * @param {{ proxy?: string | null, accountId?: string }} [opts] 覆盖项
 * @returns {{ fetch: (url: string, init?: any) => Promise<Response>, proxyUrl: string | null }}
 *   代理感知 fetch 与其生效的出口 URL
 */
export function createProxyFetch(
  config: any,
  opts: ProxyFetchOpts = {},
): ProxyFetchResult {
  const proxyRes = resolveProxy(config, opts.proxy, undefined)
  const poolIndex =
    proxyRes.kind === 'pool' ? proxyRes.indexFor(opts.accountId || 'catalog') : 0
  const proxyUrl = proxyRes.kind === 'pool' ? proxyRes.urls[poolIndex] : proxyRes.url
  return {
    fetch: buildFetchWithProxy(proxyRes, poolIndex),
    proxyUrl: proxyUrl || null,
  }
}

export { ALPN_TLS, buildFetchWithProxy, resolveProxy, hashIndex }
