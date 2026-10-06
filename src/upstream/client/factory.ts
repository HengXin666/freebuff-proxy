/**
 * 上游客户端装配:把传输,签名,目录,端点接成一个对象.
 *
 * 所有依赖显式声明并显式传参, 不用闭包捕获(拼错名字只在运行时抛
 * ReferenceError,静态检查抓不到).
 */
import { logger } from '../../util/log.ts'
import { DeviceSigner } from '../device/device-signing.ts'
import { CatalogHolder } from '../catalog-protocol.ts'
import { BUN_USER_AGENT } from '../fingerprint/official-fingerprint.ts'
import { buildFetchWithProxy, resolveProxy } from './transport.ts'
import { makeBunFetcher, makeDeviceKeysViaBun, makeReleaseViaBun, makeSessionViaBun } from './bun-channel.ts'
import { buildEndpoints } from './endpoints/misc.ts'
import { freebuffSession } from './endpoints/session.ts'

/** 账号级参数. */
interface UpstreamClientOpts {
  accountId?: string
  deviceKeyPath?: string
  proxy?: string | null
}

/** 设备签名器依赖. */
interface SignerDeps {
  apiBase: string
  token: string
  accountId?: string
  deviceKeyPath?: string
  fetchWithProxy: Function
}

/**
 * 构造目录持有者(CatalogHolder).
 *
 * 先 GET /api/v1/freebuff/models 拿 fetchId 与模型句柄.服务端据此把请求认作
 * 目录客户端.没有它就只能走 legacy 路径,在受限出口下会被直接拒绝.
 * 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-protocol.md
 *
 * catalog 这一跳不带设备签名:抓包真值(2026-10-03,165 条)显示客户端只有
 * /session 带签名三头(13 次),/models 与 /device-keys 都不带;给 catalog
 * 也签名会换成另一份响应.见 docs/reverse/19 19.2.
 * 见 .agents/notes/implemented/bug-fix/2026-10-03-catalog-fetch-unsigned.md
 *
 * @param {{ apiBase: string, token: string, fetchWithProxy: Function }} deps 依赖
 * @returns {any} 目录持有者
 */
function makeCatalog({ apiBase, token, fetchWithProxy }: { apiBase: string, token: string, fetchWithProxy: Function }) {
  return new (CatalogHolder as any)({
    apiHost: apiBase,
    token,
    // bun 通道:catalog 这一跳交给官方同一个运行时发,做到头集逐字节一致
    //(Node 会自动加 accept-language / sec-fetch-mode,且后者设不掉).
    // 懒加载 cli-bridge,失败时为 null -> 自动退回 Node 路径.见 docs/reverse/19 19.10
    // 与 .agents/notes/implemented/bug-fix/2026-10-03-catalog-request-via-bun.md.
    bunFetch: makeBunFetcher(apiBase),
    fetchImpl: async (url: string, init?: any) => {
      const headers = { ...(init?.headers || {}) }
      return fetchWithProxy(url, { ...init, headers })
    },
  })
}

/**
 * 构造设备签名器(上游判定"是不是注册过的真客户端"的核心判据).
 *
 * 真机抓包确认官方每个 catalog / session / completions 请求都带
 * x-freebuff-device-{key,ts,sig} 三头.best-effort:拿不到签名就原样发(不阻塞请求).
 * 见 .agents/notes/implemented/bug-fix/2026-10-01-device-signing.md
 *
 * 注册请求本身不能依赖签名(鸡蛋问题),但必须经过代理.
 *
 * @param {SignerDeps} deps 依赖
 * @returns {any} 设备签名器;缺 accountId/deviceKeyPath 时为 null
 */
function makeDeviceSigner({ apiBase, token, accountId, deviceKeyPath, fetchWithProxy }: SignerDeps) {
  if (!deviceKeyPath || !accountId) {
    logger.warn('device signer NOT created', {
      hasDeviceKeyPath: !!deviceKeyPath,
      hasAccountId: !!accountId,
    })
    return null
  }
  // 注册请求走 bun:客户端这一跳由 bun 发出,Node 会多带 accept-language /
  // sec-fetch-mode,且 UA 是 node.这里不重写注册逻辑(DeviceSigner 内部不变),
  // 只把传输层换成 bun:拦截 device-keys 路径,其余仍走 fetchWithProxy.
  const signer = new DeviceSigner({
    storePath: deviceKeyPath,
    apiHost: apiBase,
    accountId,
    token,
    fetchImpl: makeDeviceKeysViaBun(token, apiBase, fetchWithProxy as any),
  })
  logger.info('device signer created', { accountId, storePath: deviceKeyPath })
  return signer
}

/**
 * 构造一个账号的上游客户端.
 *
 * @param {object} config 已加载配置
 * @param {string} token 上游 token
 * @param {{ accountId?: string, deviceKeyPath?: string, proxy?: string | null }} [opts] 账号级参数
 * @returns {Record<string, any>} 上游客户端
 */
export function createUpstreamClient(config: any, token: string, opts: UpstreamClientOpts = {}): Record<string, any> {
  const apiBase = config.upstream.apiBase
  const loginBase = config.upstream.loginBase
  logger.info('createUpstreamClient called', {
    hasDeviceKeyPath: !!opts.deviceKeyPath,
    hasAccountId: !!opts.accountId,
    deviceKeyPath: opts.deviceKeyPath,
    accountId: opts.accountId,
    apiBase,
  })
  const proxyRes = resolveProxy(config, opts.proxy, opts.accountId)
  const poolIndex = proxyRes.kind === 'pool' ? proxyRes.indexFor(opts.accountId || token) : 0
  /** 该账号实际生效的代理 URL(用于控制台展示) */
  const proxyUrl = proxyRes.kind === 'pool' ? proxyRes.urls[poolIndex] : proxyRes.url
  // 带代理池的 fetch(无池/单代理/池回落/单次尝试超时都在 transport.ts).
  // 注意:单代理池也必须走池分支(见 buildFetchWithProxy 的说明).
  const fetchWithProxy = buildFetchWithProxy(proxyRes, poolIndex)
  const deviceSigner = makeDeviceSigner({
    apiBase,
    token,
    accountId: opts.accountId,
    deviceKeyPath: opts.deviceKeyPath,
    fetchWithProxy,
  })
  const catalog = makeCatalog({ apiBase, token, fetchWithProxy })
  const ctx = makeCtx({ config, token, opts, apiBase, loginBase, catalog, deviceSigner, fetchWithProxy, proxyRes })
  return {
    apiBase,
    loginBase,
    token,
    proxyUrl,
    /**
     * 账号 user id -- 官方 chat 的 x-freebuff-acting-user-id 用的就是它.
     * 与 device-keys 注册作用域里的那个 id 同源(凭据文件的 id 字段).
     */
    accountId: opts.accountId || null,
    /**
     * 设备密钥落盘路径(每账号一个文件).暴露给上层是为了让 official 通道
     * 能把它交给副仓库(cli-bridge)做设备签名 -- 避免主服务再实现一遍.
     */
    deviceKeyPath: opts.deviceKeyPath || null,
    /**
     * 目录持有者:暴露给上层把模型 id 映射成服务端句柄.
     * 官方 chat 的 model 字段用的是句柄(fbm1.xxx)而非 deepseek/deepseek-v4-flash.
     * 句柄是服务端签名的,客户端造不出来,只能先抓目录.
     */
    catalog,
    /**
     * 注意:/api/v1/me 已从本客户端移除.
     *
     * 客户端 165 条抓包里该端点出现 0 次(docs/reverse/20 20.2):官方客户端从不查它.
     * 它曾被用于"身份自检",但那是我们凭空多出来的上游流量 -- 本身就是
     * "非客户端"信号源.需要账号身份时读本地凭据,需要额度/状态时用
     * freebuffSession('GET')(客户端 17 次).
     */
    ...buildEndpoints(ctx),

    /**
     * 会话端点(GET 读 / POST admission / DELETE 释放).
     *
     * @param {'GET'|'POST'|'DELETE'} method 方法
     * @param {object} [sessionOpts] 会话参数
     * @returns {Promise<any>} 会话回执体
     */
    freebuffSession(method: string, sessionOpts: any = {}) {
      return freebuffSession(ctx, method, sessionOpts)
    },
  }
}

/**
 * 组装出站上下文(所有拆出去的函数都从它取依赖,不再依赖闭包).
 *
 * @param {{ config: object, token: string, opts: object, apiBase: string, loginBase: string,
 *   catalog: any, deviceSigner: any, fetchWithProxy: Function, proxyRes: any }} d 依赖
 * @returns {Record<string, any>} 上下文
 */
function makeCtx({ config, token, opts, apiBase, loginBase, catalog, deviceSigner, fetchWithProxy, proxyRes }: any) {
  return {
    apiBase,
    loginBase,
    token,
    config,
    catalog,
    deviceSigner,
    fetchWithProxy,
    proxyRes,
    // 经 bun 读/释放会话的通道(官方形态实现在 cli-bridge,这里只调端口).
    sessionViaBun: makeSessionViaBun(token, opts.accountId, apiBase, opts.deviceKeyPath),
    releaseViaBun: makeReleaseViaBun(token, opts.accountId, apiBase, opts.deviceKeyPath),
    bunUserAgent: BUN_USER_AGENT,
  }
}
