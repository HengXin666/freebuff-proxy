import { freebuffAuthHeaders } from '../auth-store.js'
import { logger } from '../util/log.js'
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { DeviceSigner } from './device-signing.js'
import { CatalogHolder, isModelHandle } from './catalog-protocol.js'
import { FREEBUFF_AVAILABLE_MODELS } from '../model.js'
import {
  BUN_USER_AGENT,
  HEADER_INSTANCE_ID as FREEBUFF_INSTANCE_HEADER,
  HEADER_MODEL as FREEBUFF_MODEL_HEADER,
  SESSION_ADMISSION_ENDPOINT,
  SESSION_ENDPOINT,
  officialSessionHeaders,
} from './official-fingerprint.js'

// 常量真源在 ./official-fingerprint.js（逐字取自官方二进制）。这里 re-export
// 只是为兼容既有 import 点，不要在本文件另立取值。
export {
  BUN_USER_AGENT,
  FREEBUFF_INSTANCE_HEADER,
  FREEBUFF_MODEL_HEADER,
}

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, body?: any, retryAfterMs?: number, fatal?: boolean, cause?: string }} [extra]
   */
  constructor(message, extra = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = extra.status
    this.code = extra.code
    this.body = extra.body
    this.retryAfterMs = extra.retryAfterMs
    /**
     * 底层原始错误码（ECONNREFUSED / ENOTFOUND / ETIMEDOUT …）。
     *
     * ⚠️ 与 `code` 分工：`code` 是**稳定的业务码**（多处按集合匹配，
     * 不能透裸 socket 码）；`cause` 保留**原始**错误码供排障与前端细提示。
     * 两者同时给出，`message` 里也带一份给人读。
     */
    this.cause = extra.cause
    // 出口级故障（地理封锁）：调度层据此**立即停止换号** —— 它是出口属性，
    // 换号只会把每个账号的额度依次买断却拿不到答案。
    // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
    this.fatal = extra.fatal === true
  }
}

function parseRetryAfterMs(value) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined
}

/**
 * 带单次超时的 undici fetch：超时主动 abort 本次尝试。用独立的子 AbortController
 * 级联父 signal——单次尝试超时只拆掉这一次请求（回落池内下一个），不会把整个
 * 请求/其他代理尝试一起 abort；父 signal（客户端断开 / 全局超时）abort 时本次
 * 尝试立即随之失败。
 * @param {string} url
 * @param {{ signal?: AbortSignal, [k: string]: any }} init
 * @param {number} timeoutMs
 */
async function fetchWithAttemptTimeout(url, init, timeoutMs) {
  if (!(timeoutMs > 0)) return undiciFetch(url, init)
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (init.signal?.aborted) {
    // 父 signal 已中止（客户端断开/全局超时已发生）：本次尝试立即失败，
    // 不要等 20s 超时——否则池内每个代理都要空等一轮。
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
 * 解析出网代理配置，返回统一结构：
 *   { kind: 'none', agent: null, url: null }
 *   { kind: 'single', agent: ProxyAgent|EnvHttpProxyAgent, url: string }
 *   { kind: 'pool', agents: ProxyAgent[], urls: string[], indexFor(key) }   // 全局代理池
 * 优先级：账号显式 proxy > upstream.proxies（全局池） > upstream.proxy > HTTP(S)_PROXY env。
 */
/**
 * TLS 层对齐官方 CLI：ALPN 只 offer `http/1.1`。
 *
 * 真机抓包（mitmproxy 拦本地官方 CLI 进程）确认：
 *   Bun/1.3.14 → TLSv1.3, alpn=http/1.1, cipher=TLS_AES_256_GCM_SHA384
 * 而 undici 默认会同时 offer h2 与 http/1.1 —— 与官方客户端不同，
 * 是一个可检测的 TLS 层差异。
 *
 * 注：Node 与 Bun 都用系统 OpenSSL 栈，cipher 本就一致（实测两侧都是
 * TLS_AES_256_GCM_SHA384）。所以「Node 无法对齐指纹」只成立于**浏览器**
 * 目标（GREASE 是保留数值，OpenSSL 名字字符串表达不了）；对齐 Bun 完全可行。
 */
const ALPN_TLS = Object.freeze({
  requestTls: { ALPNProtocols: ['http/1.1'] },
})

function resolveProxy(config, accountProxy, accountId) {
  // 最后一道防线：代理值可能是脏数据（数字 / 对象 / 畸形 URL），直接喂给
  // `new ProxyAgent({uri})` 会抛 ERR_INVALID_URL —— 那发生在启动后的第一次
  // 出网调用（启动扫尾/首次请求），用户看到的就是"起不来/一用就崩"。
  // 这里统一过一遍校验，非法值一律当作"没有这个代理"。
  const clean = (v) => {
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
      agents: pool.map((u) => new ProxyAgent({ uri: u, ...ALPN_TLS })),
      /** 稳定哈希：同一账号始终落到同一代理（保持 session IP 稳定） */
      indexFor: (key) => hashIndex(key, pool.length),
    }
  }
  const envSet = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some(
    (k) => Boolean(process.env[k]),
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

function hashIndex(key, n) {
  let h = 5381
  for (const ch of String(key || '')) {
    h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  }
  return (h >>> 0) % n
}

/**
 * 构造带代理池的 fetch（供 createUpstreamClient / createProxyFetch 共用）。
 *  - 无代理 / 单代理 / env：直接走对应 dispatcher
 *  - 全局池：优先分配到的代理，连接级失败（fetch 抛错）时依次回落到池内下一个；
 *    单次尝试带超时（`fetchWithAttemptTimeout`）——代理"连接成功但永不响应"
 *    （网络波动/黑洞）也会被视为失败并回落下一个，而不是干等到全局 timeoutMs。
 *
 * 重要：**单代理池也必须走 pool 分支**。resolveProxy 的 pool 分支只返回 agents
 * 数组、没有 agent 字段；若把 <=1 的池当"非池"处理，agent 恒为 undefined →
 * 走 globalThis.fetch 直连，代理被整个绕过（上游拿到宿主真实出口 IP，账号被
 * 按地区判定、报 session_model_mismatch/limited 等——issue #5 根因）。
 * 单代理池走同一循环：dispatcher=池内唯一代理，连接失败仍走兜底重试。
 * @param {ReturnType<typeof resolveProxy>} proxyRes
 * @param {number} poolIndex 本账号分配到的池内下标（稳定哈希）
 */
function buildFetchWithProxy(proxyRes, poolIndex) {
  return async function fetchWithProxy(url, init) {
    if (proxyRes.kind !== 'pool') {
      const agent = proxyRes.agent
      return (agent ? undiciFetch : globalThis.fetch)(url, {
        ...init,
        ...(agent ? { dispatcher: agent } : {}),
      })
    }
    // 单代理尝试超时：取调用方超时与 20s 的较小值（代理 CONNECT + TLS + 响应头
    // 正常数秒内完成，20s 足够；整体请求的超时仍由调用方 signal 兜底）。
    const callerMs =
      Number.isFinite(init.timeoutMs) && init.timeoutMs > 0 ? init.timeoutMs : 30_000
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
 * 供非上游 API 的出网请求使用的代理感知 fetch（如 catalog 自动同步拉 GitHub 源）。
 * 复用与上游调用完全相同的代理解析与池回落逻辑，避免旁路直连。
 * 优先级：账号显式 proxy（可传） > upstream.proxies（全局池） > upstream.proxy > HTTP(S)_PROXY env > 直连。
 * 池分配 key 默认 'catalog'（池内稳定固定一个出口），可传 accountId 覆盖。
 * @param {import('../config.js').ProxyConfig} config
 * @param {{ proxy?: string | null, accountId?: string }} [opts]
 * @returns {{ fetch: (url: string, init?: any) => Promise<Response>, proxyUrl: string | null }}
 */
export function createProxyFetch(config, opts = {}) {
  const proxyRes = resolveProxy(config, opts.proxy, null)
  const poolIndex = proxyRes.kind === 'pool'
    ? proxyRes.indexFor(opts.accountId || 'catalog')
    : 0
  const proxyUrl =
    proxyRes.kind === 'pool' ? proxyRes.urls[poolIndex] : proxyRes.url
  return {
    fetch: buildFetchWithProxy(proxyRes, poolIndex),
    proxyUrl: proxyUrl || null,
  }
}

/**
 * @param {import('../config.js').ProxyConfig} config
 * @param {string} token
 * @param {{ proxy?: string | null, accountId?: string }} [opts]
 *   proxy: 账号显式代理覆盖；accountId: 用于全局代理池的稳定分配（如账号邮箱）
 */

/**
 * 构造 bun 执行通道（**同步返回**，内部惰性解析）。
 *
 * catalog 那一跳要"与客户端完全一致"就必须跑在 bun 上 —— Node 的内置
 * fetch 会自动加 `accept-language` 与 `sec-fetch-mode`（后者是 forbidden
 * header，设不掉），而客户端（bun）不带这两个。
 *
 * 不做成必需依赖：bun 未随镜像分发 / 执行失败时静默退回 Node 路径
 * （功能不降级，只是头集差两项）。
 *
 * 为什么同步返回：createUpstreamClient 不是 async，改成 await 会破坏签名。
 * 真正的加载推迟到第一次抓取时，不阻塞客户端构造。
 * @returns {((input: object) => Promise<any>) | null}
 */
function makeBunFetcher(apiBase) {
  let loader = null
  return async (input) => {
    if (bunEnabled() === false) return null
    if (loader === null) {
      loader = import('../../cli-bridge/bridge.mjs')
        .then((m) => (m.hasBun() ? m.callBun : null))
        .catch(() => null)
    }
    const callBun = await loader
    if (!callBun) return null
    // 统一补 apiHost：无论调用方是否显式给，都以主服务配置为准
    const withHost = {
      ...input,
      cfg: { ...(input?.cfg || {}), apiHost: input?.cfg?.apiHost || apiBase || null },
    }
    return callBun(withHost, 30_000)
  }
}


/**
 * 经 bun 通道读一次会话（官方形态实现在 cli-bridge）。
 * 失败返回 null，调用方回落 Node 实现。
 */

/**
 * 经 bun 通道释放会话（官方形态实现在 cli-bridge）。
 * 失败返回 null，调用方回落 Node 实现。
 */
function makeReleaseViaBun(token, accountId, apiBase, deviceKeyPath) {
  let loader = null
  return async (instanceId) => {
    try {
      if (!bunEnabled()) return null
      if (loader === null) loader = import('./official-rpc.js').catch(() => null)
      const mod = await loader
      if (!mod?.rpcReleaseSession || !mod?.buildRpcCfg) return null
      const cfg = await mod.buildRpcCfg(
        { token, accountId, deviceKeyPath },
        { upstream: { timeZone: 'Asia/Shanghai', apiBase } },
      )
      if (!cfg) return null
      cfg.installId = installIdFromClientState() || null
      cfg.apiHost = apiBase || null
      const r = await mod.rpcReleaseSession({ cfg, instanceId })
      if (!r?.ok) return null
      // 上游释放成功返回空体；构造一个最小对象供调用方判定
      try {
        return r.text ? JSON.parse(r.text) : {}
      } catch {
        return {}
      }
    } catch {
      return null
    }
  }
}


/**
 * 包装 fetchImpl：device-keys 那一跳交给 bun（官方形态），其余原样。
 *
 * 只换传输层，不动 DeviceSigner 的注册/重试/落盘逻辑。
 * bun 不可用或失败时回落到传入的 fallback（可用性优先）。
 */
function makeDeviceKeysViaBun(token, apiBase, fallback) {
  let loader = null
  return async (url, init) => {
    const isDeviceKeys =
      typeof url === 'string' && url.includes('/api/v1/freebuff/device-keys')
    if (!isDeviceKeys || (init?.method || 'GET').toUpperCase() !== 'POST') {
      return fallback(url, init)
    }
    try {
      if (!bunEnabled()) return fallback(url, init)
      if (loader === null) loader = import('./official-rpc.js').catch(() => null)
      const mod = await loader
      if (!mod?.rpcRegisterDeviceKey) return fallback(url, init)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      if (!body?.publicKey) return fallback(url, init)
      const cfg = { token, apiHost: apiBase || null }
      const r = await mod.rpcRegisterDeviceKey({ cfg, publicKey: body.publicKey })
      if (!r?.ok) return fallback(url, init)
      // 返回一个最小 Response，让 DeviceSigner 的既有解析逻辑照常工作
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status || 200,
        headers: { 'content-type': 'application/json' },
      })
    } catch {
      return fallback(url, init)
    }
  }
}

/**
 * bun 通道总开关。
 *
 * `FREEBUFF_DISABLE_BUN=1` 时全部走 Node。
 * 测试（mock 上游不响应 catalog，bun 侧动作会因前置 fetchCatalog 失败）
 * 与排障时需要这个开关；生产默认启用 bun。
 */
function bunEnabled() {
  return process.env.FREEBUFF_DISABLE_BUN !== '1'
}

function makeSessionViaBun(token, accountId, apiBase, deviceKeyPath) {
  let loader = null
  /**
   * ⚠️ 必须**接收并透传** `opts.instanceId` / `opts.heartbeat`。
   *
   * 旧签名 `async () => {}` 不收参数 → 调用方传的 instanceId 在 GET 路径被
   * **静默丢弃** → bun 侧的 `/session` GET 从来不带 `x-freebuff-instance-id`、
   * 也从不发 `x-freebuff-heartbeat: 1`。
   *
   * 官方在 admission 成功后**立刻**发一次这形态的心跳、之后每 45 秒一次
   * （orchestrator.js:208918-208957）。我们一次没发 —— 与真实事故吻合：
   * admission 后 25 秒就被上游退款（`session_superseded` + "purchase was refunded"）。
   */
  return async (opts = {}) => {
    try {
      if (!bunEnabled()) return null
      if (loader === null) loader = import('./official-rpc.js').catch(() => null)
      const mod = await loader
      if (!mod?.rpcSession || !mod?.buildRpcCfg) return null
      /**
       * 复用已有的 buildRpcCfg —— 它负责从 deviceKeyPath 读 keyId/privateKey。
       * **不在这里重写凭据装配逻辑**（官方形态的实现只有一份）。
       */
      const cfg = await mod.buildRpcCfg(
        { token, accountId, deviceKeyPath },
        { upstream: { timeZone: 'Asia/Shanghai', apiBase } },
      )
      if (!cfg) return null
      // 会话这一跳客户端是带 install-id 的（chat 不带，故 buildRpcCfg 置 null）
      cfg.installId = installIdFromClientState() || null
      // ⚠️ 主机随主服务配置走，否则本地镜像对照会变成真打上游
      cfg.apiHost = apiBase || null
      const r = await mod.rpcSession({
        cfg,
        instanceId: opts.instanceId || null,
        heartbeat: opts.heartbeat === true,
      })
      /**
       * ⚠️ 401 **绝不静默回落 Node**。
       *
       * 旧行为：`r.ok === false` 就 `return null` → 主服务走 Node 实现
       * **再发一次同样的请求** → 再吃一个 401 → 才抛 `auth_unauthorized`。
       * 后果有两个，都直接误导排障：
       *   1) 控制台点一次「检测」= 上游收到 **两次** 401（账号侧看到的
       *      是同一个坏 token 被连打两遍，本身就是自动化特征）；
       *   2) 日志里只留 Node 那一跳，bun 那一跳的关键字段
       *      （status / hasKeyId）被吞掉 —— 于是"到底签没签名"永远查不到。
       *
       * 401 的语义是确定的：上游不认这个 token。重试换运行时不会改变它，
       * 只会多制造一次被拒记录。所以这里直接把 bun 侧的结果**抛出去**，
       * 并标注本次到底签没签名（`cfg.keyId`）—— 它是「token 真坏了」与
       * 「设备未注册导致被拒」的分流判据：签名齐全仍 401 = token 坏；
       * 没签名就 401 = 先去查设备密钥。
       *
       * 其余失败（网络/bun 本身挂了/status 非 401）保持原样回落 Node：
       * 可用性优先，不能因为通道故障就让功能不可用。
       * 见 docs/reverse/21 §21.5「通道接上 ≠ 通道生效」。
       */
      if (!r?.ok) {
        if (Number(r?.status) === 401) {
          throw new UpstreamError(
            r?.error ||
              (typeof r?.body?.message === 'string' ? r.body.message : null) ||
              'freebuff session GET rejected: 401 unauthorized',
            {
              status: 401,
              code: 'auth_unauthorized',
              body: r?.body ?? null,
              // 本次是否带了设备签名：401 时它是第一分流判据
              // （signed = token 真坏；unsigned = 先查设备密钥注册）
              cause: cfg.keyId ? 'signed' : 'unsigned',
            },
          )
        }
        logger.debug('session via bun failed; falling back to Node', {
          error: r?.error || null,
          status: r?.status ?? null,
          hasKeyId: !!cfg.keyId,
        })
        return null
      }
      return r.body ?? null
    } catch {
      return null
    }
  }
}

/** 读官方客户端登录态里的 installId（只读 best-effort）。 */
function installIdFromClientState() {
  try {
    const p = join(homedir(), '.config/freebuff-desktop/state.json')
    const st = JSON.parse(readFileSync(p, 'utf8'))
    return typeof st?.installId === 'string' ? st.installId : null
  } catch {
    return null
  }
}

export function createUpstreamClient(config, token, opts = {}) {
  const apiBase = config.upstream.apiBase
  /** 经 bun 读会话的通道（官方形态实现在 cli-bridge，这里只调端口）。 */
  const _sessionViaBun = makeSessionViaBun(token, opts.accountId, apiBase, opts.deviceKeyPath)
  const _releaseViaBun = makeReleaseViaBun(token, opts.accountId, apiBase, opts.deviceKeyPath)
  
  logger.info('createUpstreamClient called', {
    hasDeviceKeyPath: !!opts.deviceKeyPath,
    hasAccountId: !!opts.accountId,
    deviceKeyPath: opts.deviceKeyPath,
    accountId: opts.accountId,
    apiBase,
  })
  const loginBase = config.upstream.loginBase
  const proxyRes = resolveProxy(config, opts.proxy, opts.accountId)
  const poolIndex = proxyRes.kind === 'pool'
    ? proxyRes.indexFor(opts.accountId || token)
    : 0
  /** 该账号实际生效的代理 URL（用于控制台展示） */
  const proxyUrl =
    proxyRes.kind === 'pool' ? proxyRes.urls[poolIndex] : proxyRes.url

  /**
   * 带代理池的 fetch：
   *  - 无代理 / 单代理 / env：直接走对应 dispatcher
   *  - 全局池：优先本账号分配的代理，连接级失败（fetch 抛错）时依次回落到池内下一个；
   *    单次尝试带超时（`fetchWithAttemptTimeout`）——代理"连接成功但永不响应"
   *    （网络波动/黑洞）也会被视为失败并回落下一个，而不是干等到全局 timeoutMs。
   * 注意：**单代理池也必须走 pool 分支**（见 buildFetchWithProxy）。
   */
  const fetchWithProxy = buildFetchWithProxy(proxyRes, poolIndex)

  /**
   * 设备签名器：上游判定「是不是注册过的真客户端」的核心判据。
   * 真机抓包确认官方每个 catalog / session / completions 请求都带
   * x-freebuff-device-{key,ts,sig} 三头；我们此前一个都没有。
   * best-effort：拿不到签名就原样发（绝不阻塞请求）。
   * 见 .agents/notes/implemented/bug-fix/2026-10-01-device-signing.md
   *
   * ⚠️ 注册请求本身**不能**依赖签名（鸡蛋问题），但必须经过代理。
   */
  const deviceSigner =
    opts.deviceKeyPath && opts.accountId
      ? new DeviceSigner({
          storePath: opts.deviceKeyPath,
          apiHost: apiBase,
          accountId: opts.accountId,
          token,
          /**
           * 注册请求**走 bun**：客户端这一跳由 bun 发出，Node 会多带
           * `accept-language` / `sec-fetch-mode`，且 UA 是 `node`。
           *
           * 这里不重写注册逻辑（DeviceSigner 内部不变），只把**传输层**
           * 换成 bun：拦截 device-keys 路径，其余仍走 fetchWithProxy。
           */
          fetchImpl: makeDeviceKeysViaBun(token, apiBase, fetchWithProxy),
        })
      : null
  
  if (deviceSigner) {
    logger.info('device signer created', {
      accountId: opts.accountId,
      storePath: opts.deviceKeyPath,
    })
  } else {
    logger.warn('device signer NOT created', {
      hasDeviceKeyPath: !!opts.deviceKeyPath,
      hasAccountId: !!opts.accountId,
    })
  }

  /**
   * 目录持有者：先 GET /api/v1/freebuff/models 拿 fetchId 与模型句柄。
   * 服务端据此把请求认作**目录客户端**（官方原话："Its presence is what tells
   * the session endpoints to answer with catalog keys instead of model ids"）。
   * 没有它就只能走 legacy 路径，在受限出口下会被直接拒绝。
   * 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-protocol.md
   *
   * ⚠️ 目录抓取必须带设备签名（否则 401）。传入带签名的 fetch 实现。
   */
  const catalog = new CatalogHolder({
    apiHost: apiBase,
    token,
    /**
     * bun 通道：catalog 这一跳交给官方同一个运行时发，做到头集逐字节一致
     * （Node 会自动加 accept-language / sec-fetch-mode，且后者设不掉）。
     * 懒加载 cli-bridge，失败时为 null → 自动退回 Node 路径。
     * 见 docs/reverse/19 §19.10。
     */
    bunFetch: makeBunFetcher(apiBase),
    /**
     * ⚠️ catalog 这一跳**不带设备签名**。
     *
     * 抓包真值（2026-10-03，165 条）：客户端只有 `/api/v1/freebuff/session`
     * 带签名三头（13 次），`/models` 与 `/device-keys` **都不带**。
     * 官方时序是：catalog（无签名）→ device-keys → session（开始签名）。
     *
     * 以前这里给 catalog 也签了名 —— 后果是**拿到的行数不一样**：
     * 同一账号同一时刻，不签名 13 行（与客户端 UI 菜单逐项一致），
     * 带签名 53 行。53 行不是"更全的清单"，而是**我们多带了一个客户端
     * 没有的特征后换来的另一份响应**，不能拿它当真值。
     * 见 docs/reverse/19 §19.2。
     */
    fetchImpl: async (url, init) => {
      const headers = { ...(init?.headers || {}) }
      return fetchWithProxy(url, { ...init, headers })
    },
  })

  async function apiFetch(path, init = {}) {
    const url = path.startsWith('http') ? path : `${apiBase}${path}`
    const headers = {
      ...(init.headers || {}),
    }
    // 官方 CLI 的非 chat 调用（session/agent-runs/me/usage）都是裸 bun fetch，
    // 默认 UA = `Bun/<version>`（对齐 trefeon bunUserAgent = Bun/1.3.14，
    // 匹配 pinned reference/freebuff/.bun-version）。chat 请求由调用方显式传
    // ai-sdk UA 覆盖（见 proxy.js forwardCompletions）。
    if (!headers['user-agent'] && !headers['User-Agent']) {
      headers['user-agent'] = BUN_USER_AGENT
    }
    /**
     * 鉴权**只发 Bearer**。
     *
     * ⚠️ 以前的注释写着 "Login-issued tokens require x-codebuff-api-key
     * (Bearer alone → 401)" —— 那是**未做单变量对照**的结论：当时同时换了
     * token 来源与出口，401 的真实原因从未被证实是这个头。
     * 客户端 165 条抓包里 `x-codebuff-api-key` 出现 **0 次**
     * （docs/reverse/20 §20.4），所以按官方形态只发 Bearer。
     */
    if (token && init.includeAuth !== false) {
      Object.assign(headers, freebuffAuthHeaders(token))
    }
    // 目录头（x-freebuff-catalog-protocol / -fetch）：服务端据此把请求认作
    // 目录客户端并使用句柄而非 legacy 模型 id。best-effort：抓不到就不带，
    // 走 legacy 路径（可用性不受影响）。
    if (init.catalog !== false) {
      const ok = await catalog.fetch().catch(() => false)
      // chat 只带 catalog-fetch（官方 8 头里没有 catalog-protocol）
      if (ok) {
        Object.assign(
          headers,
          init.catalogFetchOnly ? catalog.fetchOnlyHeaders() : catalog.headers(),
        )
      }
    }
    // 设备签名三头（x-freebuff-device-{key,ts,sig}）。best-effort：
    // 没有密钥或注册失败时返回 {}，请求照旧发出（上游退回未签名路径）。
    // ⚠️ 必须在 body 确定之后调用 —— 签名覆盖的是**实际发送的 body 字节**。
    if (deviceSigner) {
      const sigHeaders = await deviceSigner.headersFor({
        method: init.method || 'GET',
        url,
        body: typeof init.body === 'string' ? init.body : null,
        // ⚠️ 签名载荷里的 fetchId 必须与 x-freebuff-catalog-fetch 头**完全一致**
        // —— 它把请求绑定到签发句柄的那次目录抓取。传 null 会让签名与头不匹配，
        // 服务端验签失败 → 等同于未签名（实测表现为照旧被拒）。
        fetchId: catalog.ready ? catalog.fetchId : null,
      })
      Object.assign(headers, sigHeaders)
    }
    // 可观测性：把本次实际发出的指纹面记录下来，便于与官方抓包逐头对比。
    if (init.logFingerprint) {
      logger.info('outgoing request fingerprint', {
        url: url.slice(0, 80),
        method: init.method || 'GET',
        headers: Object.keys(headers).sort(),
      })
    }
    const controller = new AbortController()
    const timeoutMs = init.timeoutMs ?? config.limits.upstreamTimeoutSec * 1000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (init.signal) {
      if (init.signal.aborted) controller.abort()
      else {
        init.signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        })
      }
    }
    try {
      const res = await fetchWithProxy(url, {
        method: init.method || 'GET',
        headers,
        body: init.body,
        signal: controller.signal,
        timeoutMs,
        duplex: init.body && typeof init.body !== 'string' ? 'half' : undefined,
      })
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 登录类请求（/api/auth/cli/code、/api/auth/cli/status）的瞬时故障重试。
   *
   * 为什么需要：代理池回落 + 单次尝试超时**只存在于 fetchWithProxy 的 pool 分支**
   * （见 buildFetchWithProxy）。而 resolveProxy 在「无代理且无环境变量」时返回
   * `kind:'none'`，fetchWithProxy 直接走裸 fetch 一次性返回——**没有任何回落**。
   * 官方推荐的家庭部署恰恰就是「代理设置留空」，于是这条最推荐的路径上一次
   * 网络抖动 = 一次硬失败，前台表现为「发起登录失败: This operation was aborted」
   * （AbortError 的原文，用户无法判断是超时/DNS/TLS）。
   *
   * 这里只补「同代理重试一次」，不改变换号/换出口语义：loginCode/loginStatus
   * 都是幂等或可重复的，重试不会多买会话、不会动账号账本。
   * 非瞬时错误（4xx/5xx 走 UpstreamError）不重试。
   */
  async function fetchLoginUpstream(url, init, label) {
    const attempts = 2
    let lastErr
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await apiFetch(url, init)
      } catch (err) {
        lastErr = err
        const name = err?.name
        const code = err?.code
        const transient =
          name === 'AbortError' ||
          name === 'TypeError' || // undici 网络层失败（fetch failed）
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
    // 给出可诊断的原因码，而不是把 AbortError 原文甩给前端
    if (lastErr?.name === 'AbortError') {
      throw new UpstreamError(
        `上游登录请求超时（${init.timeoutMs ?? '?'}ms），请重试`,
        // 超时没有底层 socket 码，cause 给一个稳定的字面量，保持字段不缺
        { code: 'upstream_timeout', cause: 'timeout' },
      )
    }
    if (lastErr?.name === 'TypeError') {
      /**
       * ⚠️ `code` 必须是**稳定的业务码**，不能透 Node 底层码。
       *
       * 本仓的 `code` 是业务判据：多处按集合匹配（`SLOT_BUSY_CODES` /
       * `UNAVAILABLE_COOLDOWN_CODES` / `EXHAUST_CODES` …）。若把
       * `ECONNREFUSED` / `ETIMEDOUT` 这类裸 socket 码透出去，
       * 一来违背这里"给可诊断原因码"的承诺（前端拿到的是不稳定原语），
       * 二来将来任何按 code 匹配的逻辑都可能被误命中。
       *
       * 底层码仍要可见 —— 两处都给：
       *   1. `message` 里带一份（前端弹窗直接显示，用户/运维肉眼可见）；
       *   2. `cause` 字段带一份（结构化，供前端程序化判断与后端排障）。
       * `code` 保持稳定的 `upstream_network`，不透裸 socket 码。
       */
      throw new UpstreamError(
        `上游登录请求网络失败：${lastErr.message}（${lastErr.code ?? 'unknown'}）`,
        { code: 'upstream_network', cause: lastErr.code ?? undefined },
      )
    }
    throw lastErr
  }

  return {
    apiBase,
    loginBase,
    token,
    proxyUrl,
    /**
     * 账号 user id —— 官方 chat 的 x-freebuff-acting-user-id 用的就是它。
     * 与 device-keys 注册作用域里的那个 id 同源（凭据文件的 id 字段）。
     */
    accountId: opts.accountId || null,
    /**
     * 设备密钥落盘路径（每账号一个文件）。暴露给上层是为了让 official 通道
     * 能把它交给副仓库（cli-bridge）做设备签名 —— 避免主服务再实现一遍。
     */
    deviceKeyPath: opts.deviceKeyPath || null,
    /**
     * 目录持有者：暴露给上层把模型 id 映射成服务端句柄。
     * 官方 chat 的 model 字段用的是句柄（fbm1.xxx）而非 deepseek/deepseek-v4-flash。
     * 句柄是服务端签名的，客户端造不出来，只能先抓目录。
     */
    catalog,

    /**
     * ⚠️ `/api/v1/me` 已从本客户端**移除**。
     *
     * 客户端 165 条抓包里该端点出现 **0 次**（docs/reverse/20 §20.2）：
     * 官方客户端从不查它。它曾被用于"身份自检"，但那是我们凭空多出来的
     * 上游流量 —— 本身就是"非客户端"信号源。需要账号身份时读本地凭据，
     * 需要额度/状态时用 `freebuffSession('GET')`（客户端 17 次）。
     */

    async loginCode(fingerprintId) {
      // 用 apiFetch（带超时 + 代理池回落）而不是裸 fetchWithProxy：
      // freebuff.com 网络波动/被墙时裸 fetch 会永远挂起，轮询/弹窗
      // 无限堆积 socket，把整个服务拖死（前台表现为「系统崩溃、只能重启」）。
      // ⚠️ 无代理部署（kind:'none'）下 apiFetch 没有池内回落，靠
      // fetchLoginUpstream 补一次重试——见 .agents/notes/implemented/bug-fix/
      // 2026-10-03-login-transient-retry.md
      const res = await fetchLoginUpstream(
        `${loginBase}/api/auth/cli/code`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fingerprintId }),
          includeAuth: false,
          timeoutMs: 15_000,
        },
        'login/code',
      )
      if (!res.ok) {
        throw new UpstreamError(`login code failed: ${res.status}`, {
          status: res.status,
          body: await safeText(res),
        })
      }
      return res.json()
    },

    async loginStatus({ fingerprintId, fingerprintHash, expiresAt }) {
      const qs = new URLSearchParams({
        fingerprintId,
        fingerprintHash,
        expiresAt,
      })
      // 同上：必须带超时。登录轮询每 4s 一轮，若 status 永远挂起（上游
      // 不可达），每轮都泄漏一个永不结束的 fetch/socket，服务最终被拖死。
      const res = await fetchLoginUpstream(
        `${loginBase}/api/auth/cli/status?${qs}`,
        {
          method: 'GET',
          includeAuth: false,
          timeoutMs: 15_000,
        },
        'login/status',
      )
      if (res.status === 401) return { pending: true }
      if (!res.ok) {
        throw new UpstreamError(`login status failed: ${res.status}`, {
          status: res.status,
          body: await safeText(res),
        })
      }
      return res.json()
    },

    /**
     * @param {'GET'|'POST'|'DELETE'} method
     * @param {{ model?: string, instanceId?: string, compact?: boolean, signal?: AbortSignal, timeoutMs?: number, walletSpendLimit?: number, firstTabDiscount?: boolean }} [opts]
     */
    async freebuffSession(method, opts = {}) {
      /**
       * 只读查询（GET）优先交给 **bun 通道**执行。
       *
       * 为什么：Node 的内置 fetch 强制带 `accept-language` 与
       * `sec-fetch-mode`（forbidden header，设不掉），客户端（bun）不带
       * —— 在主服务里补头/删头永远补不到一致，只能换运行时。
       * 官方形态的实现只有一份（cli-bridge），这里只做**端口调用**，
       * 不复制它的头构造。见 docs/reverse/21 §21.5。
       *
       * bun 不可用或失败时回落到下面的 Node 实现（可用性优先）。
       */
      if (method === 'GET') {
        // _sessionViaBun() 已直接返回**会话体**（或 null），不是 {ok,body} 包装
        // ⚠️ 把 instanceId/heartbeat 透传下去 —— 不透传的话 bun 侧
        // GET /session 永远不带实例标识、也永远不发持有心跳（见 makeSessionViaBun）
        const viaBun = await _sessionViaBun({
          instanceId: opts.instanceId || null,
          heartbeat: opts.heartbeat === true,
        })
        if (viaBun && typeof viaBun === 'object') return viaBun
      }
      /**
       * DELETE 同样走 bun：它必须带 `x-freebuff-instance-id`，否则上游 400
       * `instance_required`、槽位退不掉（账号会一直被占）。
       * 头与签名交给 bun 侧官方形态实现，不在主服务构造。
       */
      if (method === 'DELETE' && opts.instanceId) {
        const released = await _releaseViaBun(opts.instanceId)
        if (released != null) return released
      }
      // 头集合逐字对齐官方 jg()：Authorization + x-fb-timezone +
      // x-freebuff-first-tab-discount，POST 另带 model / wallet-spend-limit。
      // 见 officialSessionHeaders 与
      // .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
      //
      // 注意：官方 jg() 只用 Authorization + x-fb-timezone + first-tab-discount
      // （POST 另加 model / wallet-spend-limit），**不含** x-codebuff-api-key。
      // 但本项目 token 由网页登录签发，既有实现记录「只带 Bearer 会 401」，
      // 故这里**额外**保留该头（唯一的已知残留差异，理由与待验证项见
      // .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md）。
      // ⚠️ admission 的 x-freebuff-model 必须是**目录句柄**（fbm1.xxx），
      // 不是模型名。真机抓包（从零建会话）确认官方 POST /session/admission 带：
      //   x-freebuff-model: fbm1.AAEAAUPe2Us...（句柄）
      // 我们此前传 deepseek/deepseek-v4-flash —— 服务端认不出，直接拒。
      // 句柄只能从目录拿（服务端签名），所以 POST 前必须先抓一次目录。
      let modelForWire = opts.model
      if (opts.model && !isModelHandle(opts.model)) {
        await catalog.fetch().catch(() => false)
        // 带 displayName 兜底：静态快照的 id 与实时目录会漂移（见
        // catalog-protocol.js handleForModel 的说明）。
        //
        // displayName 由**调用方**给（session-manager 没有模型表的上下文），
        // 这里从内置静态表按 id 查；查不到就只走 legacyDigests 精确匹配。
        const displayName =
          opts.displayName ||
          (FREEBUFF_AVAILABLE_MODELS.find((m) => m?.id === opts.model)
            ?.displayName ?? null)
        modelForWire = catalog.handleForModel(opts.model, displayName)
        // ⚠️ 这里**不要**用 recommendedKey 兜底（曾用，已证伪）：
        // 它会把 deepseek/deepseek-v4-flash 静默映射到服务端"推荐"的
        // m-00032eaeec（MiMo 2.6 Flash）—— 会话绑 MiMo、agent 却是 deepseek，
        // chat 必然 503（实测踩过）。
        // 正确的映射是 legacyDigests（FNV-1a），已在 catalog.handleFor 里实现。
        // 若请求的模型不在本次目录里，就如实保持原值 —— 让上游返回它自己的
        // 判据（模型不可用），而不是我们替它猜一个。
        if (modelForWire === opts.model) {
          logger.warn('requested model not present in this catalog', {
            requested: opts.model,
            catalogRows: catalog.handles.size,
          })
        }
      }
      let headers = {
        ...officialSessionHeaders(method, token, {
          model: modelForWire,
          instanceId: opts.instanceId,
          compact: opts.compact,
          walletSpendLimit: opts.walletSpendLimit,
          /**
           * 槽位被占时显式接管（官方 `x-freebuff-takeover-instance-id`）。
           * 见 session-manager 里"槽位被占 → takeover 重试"的说明。
           */
          takeoverInstanceId: opts.takeoverInstanceId || null,
        }),
        // 既有行为保留：本项目 token 由**网页登录签发**，auth-store 记录
        // 「只带 Bearer 会 401」。测试也把它钉住了（smoke: 删它有打死全部
        // 认证的风险，未验证前不动）。
        //
        // 已知与官方抓包的偏差：官方 session GET / admission POST /
        // agent-runs POST 都不带 x-codebuff-api-key（只用 Bearer）。
        // 但这**不是**主服务 admission 失败的原因 —— 真因曾是我自己引入的
        // `url is not defined`（调试代码引用未定义变量），已修。
        // 是否去掉该头需单独验证后再动。见
        // .agents/notes/implemented/bug-fix/2026-10-03-session-header-and-model-mapping.md
        ...freebuffAuthHeaders(token),
      }

      // 调试：FB_DEBUG_SESSION_HEADERS=1 时打印完整的 admission/session 头部，
      // 用于与官方抓包逐字段对比（官方 admission **不带** x-codebuff-api-key）。
      //
      // ⚠️ 这里曾用 `url`（未在该作用域定义）→ ReferenceError，
      // 导致**每次** admission 抛异常、全部失败（2026-10-03 实测踩到）。
      // 调试代码必须只用确定存在的变量，且开关默认关闭。
      if (process.env.FB_DEBUG_SESSION_HEADERS === '1') {
        logger.info('session request headers', {
          method,
          headers: Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [
              k,
              /authorization|api-key/i.test(k) ? 'Bearer ***' : String(v).slice(0, 60),
            ]),
          ),
        })
      }

      const init = {
        method,
        headers,
        signal: opts.signal,
        // 调用方可给单次超时（启动扫尾用它把等待压进总预算）：不带就沿用
        // admitTimeoutMs。启动路径不允许被一个连不通的上游拖住。
        timeoutMs:
          Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
            ? opts.timeoutMs
            : config.session.admitTimeoutMs,
        includeAuth: false, // already set
      }

      // 官方 POST 打 .../session/admission，GET/DELETE 打 .../session（二进制
      // PN$）。优先用官方端点对齐指纹；老部署没有 /admission 时回落
      // legacy /session —— 绝不因为"对齐"丢掉可用性（官方自己把 404/405 当作
      // session_admission_unavailable，我们回落即可）。
      let res = await apiFetch(
        method === 'POST' ? SESSION_ADMISSION_ENDPOINT : SESSION_ENDPOINT,
        init,
      )
      if (method === 'POST' && (res.status === 404 || res.status === 405)) {
        logger.warn('session admission endpoint unavailable; falling back', {
          status: res.status,
          fallback: SESSION_ENDPOINT,
        })
        res = await apiFetch(SESSION_ENDPOINT, init)
      }

      if (res.status === 404) {
        return { status: 'none' }
      }

      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
      const text = await res.text()
      // 调试：打印上游原文，用于定位 admission 失败的真因（错误码被上层
      // sanitize 精简后看不出所以然）。
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

      if (
        res.status === 403 &&
        body &&
        (body.status === 'country_blocked' || body.status === 'banned')
      ) {
        return body
      }
      // 地理封锁夹在 200 回执里：会话照样建立（status: "active"、额度照扣），
      // 但随后 chat 一律 503 且不带业务体。不归一化就只能归成 http_503，
      // 表现为"所有账号轮流冷却换号"，而每次 admit 都买断一小时 Freebucks ——
      // 烧真钱却永远拿不到答案。上游已经用明文给出了原因，读它即可。
      // 判据与"为什么不硬失败/不归 banned"见
      // .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
      // 只把**真封锁**归一；limited 档位必须原样放行。
      // 官方源码（common/src/constants/freebuff-countries.ts）写明：
      //   "the union of the three full-access groups is the full-access
      //    allowlist; everywhere else, and any VPN, is limited access."
      // 即 JP + VPN 落在 accessTier: limited —— 那是**可用档位**（模型集合变小、
      // Freebucks 25→20），不是封锁。真正的 terminal 是 country_blocked 状态本身。
      // 把 anonymous_network 也判成封锁 = 把可用账号判死，且白烧额度。
      // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
      // ⚠️ 2026-10-01 真机抓包修正（**重要**）：`status: 'active'` 时绝不归一。
      //
      // 官方 CLI 在完全相同的出口（JP / country_not_allowed / region_locked）
      // 下，服务端返回的就是 `status: "active"` + 一个可用的 instanceId。
      // 也就是说 countryBlockReason 是**说明性字段**（解释为什么模型集变小），
      // 不是拒绝信号。把它当拒绝 → 明明拿到可用会话却主动判死。
      // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
      // ⚠️ 关键：只看 **HTTP 403** 才当 terminal。
      //
      // 真机抓包（2026-10-01，从零建会话）证明：**正常的 GET 回执也带
      // countryBlockReason**（status:'none' + countryBlockReason:'country_not_allowed'
      // 是同一台机器的正常响应），官方随后照样用 POST admission 建成了会话。
      // 也就是说这个字段是**纯说明性**的（解释模型集为何变小），出现在成功路径上。
      // 此前我们"见到字段就判死"，把正常流程打断了 ——
      // 表现就是 GET 之后再也走不到 POST admission。
      // 真正的 terminal 判据是 HTTP 403。
      if (
        res.status === 403 &&
        body &&
        body.status !== 'active' &&
        isTerminalCountryBlock(body.countryBlockReason)
      ) {
        logger.warn('upstream reported terminal country block', {
          countryCode: body.countryCode ?? null,
          reason: body.countryBlockReason,
          instanceId: body.instanceId ?? null,
        })
        // ⚠️ 必须**保留原回执的会话字段**（instanceId / expiresAt / model …）：
        // 上游是照常建立会话并照常扣费的（一次 admit = 买断一整小时），
        // 只是随后 chat 会被拒。若这里把整个 body 换掉，那条已付费的会话
        // 就再也无法寻址：DELETE 不掉（腾不出上游槽位）也追不回钱。
        // 所以是"叠加封锁标记"而不是"替换回执" —— 窗口照旧存在。
        // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
        return {
          ...body,
          status: 'country_blocked',
          countryCode: body.countryCode ?? null,
          countryBlockReason: body.countryBlockReason,
          message:
            'Upstream blocked this egress country (' +
            (body.countryCode ?? 'unknown') +
            '): ' +
            body.countryBlockReason,
        }
      }
      // limited 档位（VPN/代理/非 allowlist 国家）：**可用**，但模型集合变小、
      // Freebucks 从 25 降到 20。记一条 warn 让控制台「日志」页能看到，
      // 绝不阻断 —— 判成封锁会把可用账号判死并白烧额度。
      if (body && body.countryBlockReason && !isTerminalCountryBlock(body.countryBlockReason)) {
        logger.warn('session admitted on limited tier (not blocked)', {
          countryCode: body.countryCode ?? null,
          reason: body.countryBlockReason,
          ipPrivacySignals: body.ipPrivacySignals ?? null,
          accessTier: body.accessTier ?? null,
        })
      }

      if (
        res.status === 409 &&
        body &&
        (body.status === 'model_locked' ||
          body.status === 'model_unavailable' ||
          // 以下由真机抓包补齐（官方 409 全集，见二进制 PU$ 分支）：
          //   premium_slot_taken / purchase_claim_released / purchase_in_use /
          //   purchase_capacity / first_tab_discount_changed / consent_required
          // purchase_capacity 实测语义：**该账号的付费槽位已被占**（一个账号
          // slotLimit:1），回执带 currentInstanceId / nextExpiryAt 指明何时空出。
          // 它不该被当成账号故障冷却 —— 等槽位空出即可。
          body.status === 'premium_slot_taken' ||
          body.status === 'purchase_claim_released' ||
          body.status === 'purchase_in_use' ||
          body.status === 'purchase_capacity' ||
          body.status === 'first_tab_discount_changed' ||
          body.status === 'consent_required')
      ) {
        return body
      }
      if (
        res.status === 429 &&
        body &&
        (body.status === 'rate_limited' ||
          body.status === 'spend_limited' ||
          body.status === 'ip_capped' ||
          body.status === 'free_mode_rate_limited')
      ) {
        return body
      }

      /**
       * 401 = 上游**不认这个 token**，与限流/风控/封禁是完全不同的处置路径。
       *
       * 实测（2026-10-04，单变量对照）：
       *   - 有效 token → 200 `{"status":"none", accessTier:"limited", freebucks:{...}}`
       *   - 无效 token → 401 `{"error":"unauthorized","message":"Invalid API key"}`
       *   - 无 token    → 401 `{"error":"unauthorized","message":"Missing or invalid Authorization header"}`
       * 即上游在 401 上已经用明文说清了原因，读它即可。
       *
       * ⚠️ 此前这里只走通用 `!res.ok` 分支，`code` 取 `body.error` = `unauthorized`。
       * 后果：控制台 `probeReason()` 用 `c.includes('unauthorized')` 命中
       * 「凭证无效」，把**网络/出口类 401** 也判成凭证失效 —— 用户看到
       * "凭证无效" 就去重新登录，而真因（token 过期/被吊销）与处置
       * （重新登录导入）都不会被提示。所以这里单独归一，把上游原文带走。
       */
      if (res.status === 401) {
        throw new UpstreamError(
          body?.message ||
            `freebuff session ${method} rejected: 401 unauthorized`,
          {
            status: 401,
            code: 'auth_unauthorized',
            body,
            retryAfterMs,
          },
        )
      }

      if (!res.ok) {
        throw new UpstreamError(
          `freebuff session ${method} failed: ${res.status}`,
          {
            status: res.status,
            code: body?.error || body?.status,
            body,
            retryAfterMs,
          },
        )
      }

      return body
    },

    /**
     * Register an agent run; returns server-issued runId required by chat/completions.
     * @param {{ agentId: string, ancestorRunIds?: string[] }} params
     */
    async startAgentRun(params) {
      const res = await apiFetch('/api/v1/agent-runs', {
        method: 'POST',
        headers: {
          ...freebuffAuthHeaders(token),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'START',
          agentId: params.agentId,
          ancestorRunIds: params.ancestorRunIds ?? [],
        }),
        includeAuth: false,
        timeoutMs: 30_000,
      })
      const text = await res.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = { raw: text }
      }
      if (!res.ok) {
        throw new UpstreamError(
          `startAgentRun failed: ${res.status} ${text.slice(0, 200)}`,
          { status: res.status, code: 'start_agent_run_failed', body },
        )
      }
      const runId = body?.runId
      if (!runId || typeof runId !== 'string') {
        throw new UpstreamError('startAgentRun response missing runId', {
          status: 502,
          code: 'start_agent_run_failed',
          body,
        })
      }
      return runId
    },

    /**
     * Best-effort finish so the run does not linger server-side.
     * @param {{ runId: string, status?: string, errorMessage?: string }} params
     */
    async finishAgentRun(params) {
      try {
        await apiFetch('/api/v1/agent-runs', {
          method: 'POST',
          headers: {
            ...freebuffAuthHeaders(token),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            action: 'FINISH',
            runId: params.runId,
            status: params.status || 'completed',
            totalSteps: 1,
            directCredits: 0,
            totalCredits: 0,
            errorMessage: params.errorMessage,
            steps: [],
          }),
          includeAuth: false,
          timeoutMs: 15_000,
        })
      } catch (err) {
        logger.warn('finishAgentRun failed', {
          runId: params.runId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },

    /**
     * Low-level passthrough to upstream API path.
     * @param {string} upstreamPath e.g. /api/v1/chat/completions
     * @param {{ method: string, headers?: Record<string,string>, body?: any, signal?: AbortSignal, timeoutMs?: number }} init
     */
    async raw(upstreamPath, init) {
      const headers = {
        ...(init.headers || {}),
        ...freebuffAuthHeaders(token),
      }
      return apiFetch(upstreamPath, {
        method: init.method,
        headers,
        body: init.body,
        signal: init.signal,
        timeoutMs: init.timeoutMs,
        includeAuth: false,
        // chat 走这里：官方 chat 只带 catalog-fetch，不带 catalog-protocol
        catalogFetchOnly: init.catalogFetchOnly === true,
      })
    },

    /**
     * 释放本 client 持有的出网资源（undici ProxyAgent / EnvHttpProxyAgent）。
     *
     * **必须显式调用**：每个账号 runtime 在构造时都会 `new ProxyAgent(...)`，
     * 而 agent 自带 keep-alive 连接池。更新凭证、导入账号、切换代理池都会
     * **重建 runtime 并丢弃旧的**——若旧 agent 不被 close，它的 socket 会一直
     * 挂着，随"更新账号"的次数单调累积（实测每轮凭证更新留下 1 个常驻
     * socket），表现为运行越久越慢、连接越难建立。
     * @returns {Promise<void>}
     */
    async close() {
      const agents =
        proxyRes.kind === 'pool' ? proxyRes.agents : proxyRes.agent ? [proxyRes.agent] : []
      await Promise.all(
        agents.map(async (a) => {
          try {
            await a?.close?.()
          } catch {
            // 已关闭 / 正在关闭：忽略
          }
        }),
      )
    },
  }
}

/**
 * 读取上游响应 body 文本，带超时兜底：上游发完响应头后 body 迟迟不来
 * （幽灵连接）时取消 body 读取，避免控制面请求永远挂起。
 * @param {Response} res
 * @param {number} [timeoutMs]
 */
export async function safeText(res, timeoutMs = 10_000) {
  if (!res || !res.body) return ''
  try {
    return await Promise.race([
      res.text(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          res.body?.cancel().catch(() => {})
          reject(new Error('upstream body read timeout'))
        }, timeoutMs)
        if (timer.unref) timer.unref()
      }),
    ])
  } catch {
    return ''
  }
}

/**
 * 哪些 countryBlockReason 是**真正的封锁**（terminal，账号在此出口下不可用）。
 *
 * 官方枚举（common/src/types/freebuff-session.ts FreebuffCountryBlockReason）：
 *   country_not_allowed            → 国家不在 allowlist（terminal）
 *   anonymized_or_unknown_country → 位置不可信，无法给 free mode（terminal）
 *   missing_client_ip / unresolved_client_ip / ip_privacy_lookup_failed → 同理
 *   anonymous_network             → **不是封锁**：只是被判为 VPN/代理，
 *                                   落进 accessTier: limited（可用，模型集变小）
 *   recent_limited_country        → **不是封锁**：账号近期从受限地区用过，
 *                                   限制延续一段时间（可用）
 *
 * 判据来源：common/src/constants/freebuff-countries.ts
 *   "everywhere else, and any VPN, is limited access"
 */
export function isTerminalCountryBlock(reason) {
  return (
    reason === 'country_not_allowed' ||
    reason === 'anonymized_or_unknown_country' ||
    reason === 'missing_client_ip' ||
    reason === 'unresolved_client_ip' ||
    reason === 'ip_privacy_lookup_failed'
  )
}

const GATE_CODES = new Set([
  'waiting_room_required',
  'waiting_room_queued',
  'session_superseded',
  'session_model_mismatch',
  'session_expired',
  'free_mode_capacity_deferred',
  // Freebuff retires old Luna conversations after an agent rollout. This is
  // recoverable by replacing the cached session, not by cooling the account.
  'free_mode_legacy_luna_agent',
])

/**
 * chat/completions 返回的账号级限流/配额错误：当前账号被上游限流，
 * 换一个账号重试可能成功（free_mode_rate_limited = 免费模式 30 分钟窗口限流，
 * 例如 "Free mode rate limit exceeded (30 minutes limit). Try again in 1 minute."）。
 */
const RATE_LIMIT_CODES = new Set([
  'free_mode_rate_limited',
  'rate_limited',
  'spend_limited',
  'ip_capped',
])

/**
 * 从 chat/completions 错误响应里提取"应换号重试"的限流 code。
 * 兼容多种返回形态：{ error: 'free_mode_rate_limited' } /
 * { error: { code: 'rate_limited' } } / { code: ... } / { status: ... }。
 * @param {any} body
 * @param {number} [status]
 * @returns {string | null}
 */
export function extractRateLimitError(body, status) {
  if (!body || typeof body !== 'object') return null
  const nested =
    body.error && typeof body.error === 'object' && !Array.isArray(body.error)
      ? body.error
      : null
  const code = nested?.code || body.error || body.code || body.status
  if (typeof code !== 'string') return null
  if (RATE_LIMIT_CODES.has(code)) return code
  return null
}

/**
 * chat 返回 503 时，判断是不是「该模型当日会话次数用尽」。
 *
 * 2026-10-02 实测（全新账号、25/25 Freebucks 满额）：完整链路
 * catalog → admission(200 active) → agent-runs(200) 都成功，
 * **唯独 chat 503 `The model is temporarily unavailable`**；
 * 换了三个价格档（0/5/15）、多种身份组合，全部 503。
 * 排除法走到最后，真因在 `rateLimitsByModel`：
 *
 *   m-00032eaeec recent=6 limit=6   ← 打满
 *   m-096e75164d recent=6 limit=6
 *   m-22ff70c712 recent=6 limit=6
 *   resetAt = 2026-10-03T07:00:00.000Z（period: pacific_day）
 *
 * 即：limited 档**每模型每天 6 次会话**，与 Freebucks 是两本账 ——
 * 503 后上游自动退款（balance 恒 25 不变），但**次数那本账不退**。
 * 所以"额度看起来没少"是假象，而"模型暂时故障"是错误归因：
 * 按模型故障去换模型重试，只会把下一个模型也打满。
 *
 * @param {any} quota  session 回执里的 rateLimitsByModel / rateLimit
 * @param {string} [model] 目录 key（m-xxx）；不传时只看是否全满
 * @returns {{ exhausted: boolean, resetAtMs: number | null, limit: number | null, recentCount: number | null }}
 */
export function dailySessionQuota(quota, model) {
  const empty = { exhausted: false, resetAtMs: null, limit: null, recentCount: null }
  if (!quota || typeof quota !== 'object') return empty
  const byModel = quota.byModel
  const rows = []
  if (byModel && typeof byModel === 'object') {
    if (model && byModel[model]) rows.push(byModel[model])
    else for (const v of Object.values(byModel)) rows.push(v)
  }
  if (quota.rateLimit && typeof quota.rateLimit === 'object') {
    rows.push(quota.rateLimit)
  }
  let limit = null
  let recentCount = null
  let resetAtMs = null
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (typeof row.limit === 'number') {
      limit = limit === null ? row.limit : Math.min(limit, row.limit)
    }
    if (typeof row.recentCount === 'number') {
      recentCount =
        recentCount === null ? row.recentCount : Math.max(recentCount, row.recentCount)
    }
    if (row.resetAt) {
      const ms = Date.parse(row.resetAt)
      if (Number.isFinite(ms)) resetAtMs = resetAtMs === null ? ms : Math.max(resetAtMs, ms)
    }
  }
  if (limit === null || recentCount === null) return empty
  // limit=0 表示免费档下该模型完全没有额度，同样视为不可用
  const exhausted = limit <= 0 || recentCount >= limit
  return { exhausted, resetAtMs, limit, recentCount }
}

/**
 * 上游把"账号生命周期终止"写成多个不同字面量，必须归一成一个 code。
 *
 * 2026-09-18 实测：免费模式对第三方客户端的封禁回的是
 * 403 `{"error":"account_suspended","message":"Your account has been suspended
 * for accessing Freebuff with a third-party client or proxy..."}` —— 注意
 * `error` 是**字符串**而非对象。不归一，它会以 403 落入"4xx 客户端错误，
 * 不换号"的分支，于是**每一个被封的账号都被反复复用**、错误原样甩给下游
 * （`app-context.markCooldown` 也无法记 bannedAt，控制台看不见封禁）。
 *
 * @param {any} body
 * @param {number} [status]
 * @returns {string | null} 归一后的 code（目前统一为 'banned'）
 */
/*
 * 归一理由见
 * .agents/notes/implemented/bug-fix/2026-09-18-tool-schema-rejection-strip.md
 */
export function extractAccountBanError(body, status) {
  if (!body || typeof body !== 'object') return null
  const nested =
    body.error && typeof body.error === 'object' && !Array.isArray(body.error)
      ? body.error
      : null
  const code =
    nested?.code ||
    (typeof body.error === 'string' ? body.error : null) ||
    body.code ||
    body.status
  if (typeof code !== 'string') return null
  if (
    code === 'account_suspended' ||
    code === 'banned' ||
    code === 'country_blocked'
  ) {
    return 'banned'
  }
  return null
}

export function extractGateError(body, status) {
  if (!body || typeof body !== 'object') return null
  const nested =
    body.error && typeof body.error === 'object' && !Array.isArray(body.error)
      ? body.error
      : null
  const code =
    nested?.code ||
    (typeof body.error === 'string' ? body.error : null) ||
    body.code ||
    body.status
  if (typeof code !== 'string') return null
  // Status may vary; code is the source of truth.
  if (GATE_CODES.has(code)) return code
  return null
}

/** Gates where re-admit (same or next account) can recover the request. */
export function isSessionRecoverableGate(code) {
  return (
    code === 'waiting_room_required' ||
    code === 'waiting_room_queued' ||
    code === 'session_expired' ||
    code === 'session_model_mismatch' ||
    code === 'session_superseded' ||
    code === 'free_mode_capacity_deferred' ||
    code === 'free_mode_legacy_luna_agent'
  )
}
