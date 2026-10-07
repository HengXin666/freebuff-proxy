/**
 * 出网代理的解析 ---- 全进程唯一的出口判据.
 *
 * 任何要发请求的地方都不许自己读配置,不许自己看环境变量:出口只有这一处
 * 说了算. 上层拿到的是 resolveProxy 的结果,不是散落的 proxy 字符串.
 *
 * 优先级(高到低):
 *   1. 账号显式 proxy          (data/credentials/<账号>.json 的 proxy 字段)
 *   2. upstream.proxies        (控制台[代理设置]里的全局池)
 *   3. upstream.proxy          (单代理配置)
 *   4. HTTP(S)_PROXY 环境变量  (容器/宿主的 env 代理)
 *   5. 直连
 *
 * 池内分配是稳定哈希: 同一账号始终落在同一出口, 保持 session IP 稳定;
 * 某代理连接失败时由 fetch 层回落到池内下一个.
 *
 * 见 .agents/notes/implemented/architecture/2026-10-07-unified-upstream-egress.md
 */
import { ProxyAgent, EnvHttpProxyAgent } from 'undici'

/**
 * TLS 层对齐官方 CLI:ALPN 只 offer http/1.1.
 *
 * 真机抓包(mitmproxy 拦本地官方 CLI 进程)确认:
 *   Bun/1.3.14 -> TLSv1.3, alpn=http/1.1, cipher=TLS_AES_256_GCM_SHA384
 * 而 undici 默认会同时 offer h2 与 http/1.1  --  与官方客户端不同,
 * 是一个可检测的 TLS 层差异.
 *
 * Node 与 Bun 都用系统 OpenSSL 栈, cipher 一致
 * (TLS_AES_256_GCM_SHA384).
 */
const ALPN_TLS = Object.freeze({
  requestTls: { ALPNProtocols: ['http/1.1'] },
})

/**
 * 参与代理解析的环境变量(按此顺序取第一个非空值).
 *
 * http_proxy 必须排在 HTTPS_PROXY 之后: 本仓历史上出现过只设 http_proxy
 * 却把 HTTPS 流量也送进同一条代理的配置, 那种配法对小写变量优先的
 * 实现会得到与预期相反的出口.
 */
const PROXY_ENV_KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']

/** 代理解析结果的 kind 取值. */
type ProxyKind = 'none' | 'single' | 'pool'

/** 出口来源:配置里写的出口与 env 出口在 bun 侧的处理方式不同. */
type ProxySource = 'account' | 'pool' | 'single' | 'env' | 'none'

/** 代理解析结果. */
interface ProxyResolution {
  kind: ProxyKind
  source: ProxySource
  url: string | null
  agent?: any
  urls?: string[]
  agents?: any[]
  indexFor: (key: string) => number
}

/**
 * 代理地址校验:非 URL / 空 / 协议不认识的值一律当作"没有这个代理".
 *
 * 最后一道防线: 代理值可能是脏数据(数字 / 对象 / 畸形 URL), 直接喂给
 * new ProxyAgent({uri}) 会抛 ERR_INVALID_URL  --  那发生在启动后的第一次
 * 出网调用(启动扫尾/首次请求), 用户看到的就是"起不来/一用就崩".
 *
 * @param {unknown} v 待校验的值
 * @returns {string | null} 可用的代理地址;不可用为 null
 */
function cleanProxy(v: unknown): string | null {
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

/**
 * 环境变量里的代理(未配置为 null).
 *
 * @param {Record<string, any>} [env] 环境变量表(默认 process.env)
 * @returns {string | null} 代理地址;未配置或非法为 null
 */
function envProxyOf(env: Record<string, any> = process.env): string | null {
  for (const k of PROXY_ENV_KEYS) {
    const v = cleanProxy(env[k])
    if (v) return v
  }
  return null
}

/**
 * djb2 字符串哈希转池内下标(同一 key 稳定落同一下标).
 *
 * @param {any} key 分配 key(账号 id / 邮箱)
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

/**
 * 解析出网代理配置.
 *
 * @param {any} config 已加载配置
 * @param {string | null} [accountProxy] 账号显式代理
 * @param {string} [accountId] 池内稳定分配用的 key(不参与单代理分支)
 * @returns {ProxyResolution} 代理解析结果
 */
function resolveProxy(config: any, accountProxy?: string | null, accountId?: string): ProxyResolution {
  const explicit = cleanProxy(accountProxy) || cleanProxy(config?.upstream?.proxy)
  if (explicit) {
    return {
      kind: 'single',
      source: cleanProxy(accountProxy) ? 'account' : 'single',
      url: explicit,
      agent: new ProxyAgent({ uri: explicit, ...ALPN_TLS }),
      indexFor: () => 0,
    }
  }
  const pool = (config?.upstream?.proxies || []).map(cleanProxy).filter(Boolean) as string[]
  if (pool.length) {
    return {
      kind: 'pool',
      source: 'pool',
      url: pool[hashIndex(accountId || 'catalog', pool.length)],
      urls: pool,
      agent: undefined,
      agents: pool.map((u: string) => new ProxyAgent({ uri: u, ...ALPN_TLS })),
      indexFor: (key: string) => hashIndex(key, pool.length),
    }
  }
  const envUrl = envProxyOf()
  if (envUrl) {
    return {
      kind: 'single',
      source: 'env',
      url: envUrl,
      agent: new EnvHttpProxyAgent({ ...ALPN_TLS }),
      indexFor: () => 0,
    }
  }
  return { kind: 'none', source: 'none', url: null, agent: null, indexFor: () => 0 }
}

/**
 * 某个出口地址能否交给 bun 运行时使用.
 *
 * bun 只支持 http / https 代理: 实测 socks5 与 socks 一律抛
 * UnsupportedProxyProtocol(见 note 的实测记录). 因此 socks 出口必须留在
 * Node 侧执行  --  undici 的 SOCKS5 支持已实测可用(握手到 CONNECT 阶段).
 *
 * 绝不允许"bun 用不了就直连": 那会把宿主的真实出口 IP 暴露给上游,
 * 正是 issue #5 里 session_model_mismatch 的根因.
 *
 * @param {string | null} url 出口地址(null = 直连)
 * @returns {boolean} true 表示 bun 可以承载这个出口
 */
function bunCanUseProxy(url: string | null): boolean {
  if (!url) return true
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 本次出口交给 bun 时应该带的 proxy 参数.
 *
 * 两条规则:
 *   1. 配置里写的出口(账号 / 池 / 单代理)必须显式传给 bun  --  它优先于
 *      NO_PROXY, 与 Node 侧 ProxyAgent 的行为一致;
 *   2. env 出口返回 null  --  让 bun 自己读环境变量, 从而保留 NO_PROXY 语义
 *      (EnvHttpProxyAgent 同样遵守 NO_PROXY, 两侧判据因此一致).
 *
 * @param {ProxyResolution} res 代理解析结果
 * @returns {string | null} 交给 bun 的 proxy 参数;null 表示由 bun 自行判定
 */
function bunProxyArg(res: ProxyResolution): string | null {
  if (res.source === 'env' || res.source === 'none') return null
  return res.url
}

export {
  ALPN_TLS,
  PROXY_ENV_KEYS,
  bunCanUseProxy,
  bunProxyArg,
  cleanProxy,
  envProxyOf,
  hashIndex,
  resolveProxy,
}
