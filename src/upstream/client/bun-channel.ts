/**
 * bun 通道包装层:把[官方形态]的那几跳交给副仓库(cli-bridge,bun 执行).
 *
 * 主服务(Node)不复制任何协议逻辑,只做端口调用;bun 不可用或失败时
 * 按各函数注释里写明的规则回落(可用性优先,但 401 是例外,必须显式抛出).
 *
 * 从 src/upstream/client.ts 拆出(原 1499 行单文件).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../../util/log.ts'
import { bunCanCarry } from './egress/index.ts'
import { UpstreamError } from './errors/index.ts'

/**
 * bun 通道总开关.
 *
 * FREEBUFF_DISABLE_BUN=1 时全部走 Node.
 * 测试(mock 上游不响应 catalog,bun 侧动作会因前置 fetchCatalog 失败)
 * 与排障时需要这个开关;生产默认启用 bun.
 *
 * @returns {boolean} true 表示允许走 bun 通道
 */
/** 传输层函数签名(fetch 兼容). */
type FetchLike = (url: string, init?: any) => Promise<Response>

/**
 * bun 通道总开关.
 *
 * 见 .agents/notes/implemented/feature/2026-10-03-bun-channel-kill-switch.md
 * @returns {boolean} true 表示允许走 bun 通道
 */
export function bunEnabled(): boolean {
  return process.env.FREEBUFF_DISABLE_BUN !== '1'
}

/**
 * 读官方客户端登录态里的 installId(只读 best-effort).
 *
 * @returns {string | null} installId;读不到返回 null
 */
export function installIdFromClientState(): string | null {
  try {
    const p = join(homedir(), '.config/freebuff-desktop/state.json')
    const st = JSON.parse(readFileSync(p, 'utf8'))
    return typeof st?.installId === 'string' ? st.installId : null
  } catch {
    return null
  }
}

/**
 * 构造 bun 执行通道(同步返回,内部惰性解析).
 *
 * catalog 那一跳要"与客户端完全一致"就必须跑在 bun 上  --  Node 的内置
 * fetch 会自动加 accept-language 与 sec-fetch-mode(后者是 forbidden
 * header,设不掉),而客户端(bun)不带这两个.
 *
 * 不做成必需依赖:bun 未随镜像分发 / 执行失败时静默退回 Node 路径
 * (功能不降级,只是头集差两项).
 *
 * 同步返回:createUpstreamClient 不是 async, 改成 await 会破坏签名;
 * 真正的加载推迟到第一次抓取时,不阻塞客户端构造.
 *
 * @param {string} apiBase 上游 API 主机
 * @param {any} [egress] 统一出口(null = 直连, 由 bun 自己按 env 判定)
 * @returns {((input: object) => Promise<any>) | null} bun fetch 调用器;不可用时 null
 */
export function makeBunFetcher(apiBase?: string, egress?: any): ((input: Record<string, any>) => Promise<any>) | null {
  let loader: Promise<any> | null = null
  return async (input: Record<string, any>) => {
    if (bunEnabled() === false || !bunCanCarry(egress)) return null
    if (loader === null) {
      loader = import('../../../cli-bridge/bridge.ts')
        .then((m) => (m.hasBun() ? m.callBun : null))
        .catch(() => null)
    }
    const callBun = await loader
    if (!callBun) return null
    // 统一补 apiHost:无论调用方是否显式给,都以主服务配置为准
    const withHost = {
      ...input,
      cfg: {
        ...(input?.cfg || {}),
        apiHost: input?.cfg?.apiHost || apiBase || null,
        // 出口由 Node 侧解析后下传  --  bun 读不到控制台的代理设置.
        // null 表示"按环境变量自行判定", 与显式直连的语义不同.
        proxy: egress?.bunProxy ?? null,
      },
    }
    return callBun(withHost, 30_000)
  }
}

/**
 * 经 bun 通道释放会话(官方形态实现在 cli-bridge).失败返回 null,回落 Node.
 *
 * @param {string} token 上游 token
 * @param {string} [accountId] 账号 id(写进 device-key scope)
 * @param {string} apiBase 上游 API 主机
 * @param {string} [deviceKeyPath] 设备密钥文件路径
 * @param {any} [egress] 统一出口(null = 按 env 判定)
 * @returns {(instanceId: string) => Promise<any>} 释放器;成功返回解析后的回执
 */
export function makeReleaseViaBun(
  token: string,
  accountId?: string,
  apiBase?: string,
  deviceKeyPath?: string,
  egress?: any,
): (instanceId: string) => Promise<any> {
  let loader: Promise<any> | null = null
  return async (instanceId: string) => {
    try {
      if (!bunEnabled() || !bunCanCarry(egress)) return null
      if (loader === null) loader = import('../rpc/official-rpc.ts').catch(() => null)
      const mod: any = await loader
      if (!mod?.rpcReleaseSession || !mod?.buildRpcCfg) return null
      const cfg: any = await mod.buildRpcCfg(
        { token, accountId, deviceKeyPath },
        { upstream: { timeZone: 'Asia/Shanghai', apiBase } },
      )
      if (!cfg) return null
      cfg.installId = installIdFromClientState() || null
      cfg.apiHost = apiBase || null
      cfg.proxy = egress?.bunProxy ?? null
      const r = await mod.rpcReleaseSession({ cfg, instanceId })
      if (!r?.ok) return null
      // 上游释放成功返回空体;构造一个最小对象供调用方判定
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
 * 包装 fetchImpl:device-keys 那一跳交给 bun(官方形态),其余原样.
 *
 * 只换传输层,不动 DeviceSigner 的注册/重试/落盘逻辑.
 * bun 不可用或失败时回落到传入的 fallback(可用性优先).
 *
 * @param {string} token 上游 token
 * @param {string} apiBase 上游 API 主机
 * @param {(url: string, init?: any) => Promise<Response>} fallback 非 device-keys 跳的传输实现
 * @param {any} [egress] 统一出口(null = 按 env 判定)
 * @returns {(url: string, init?: any) => Promise<Response>} 分流后的 fetch
 */
export function makeDeviceKeysViaBun(
  token: string,
  apiBase: string | undefined,
  fallback: FetchLike,
  egress?: any,
): FetchLike {
  let loader: Promise<any> | null = null
  return async (url: string, init?: any) => {
    const isDeviceKeys =
      typeof url === 'string' && url.includes('/api/v1/freebuff/device-keys')
    if (!isDeviceKeys || (init?.method || 'GET').toUpperCase() !== 'POST') {
      return fallback(url, init)
    }
    try {
      if (!bunEnabled() || !bunCanCarry(egress)) return fallback(url, init)
      if (loader === null) loader = import('../rpc/official-rpc.ts').catch(() => null)
      const mod: any = await loader
      if (!mod?.rpcRegisterDeviceKey) return fallback(url, init)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      if (!body?.publicKey) return fallback(url, init)
      const cfg = { token, apiHost: apiBase || null, proxy: egress?.bunProxy ?? null }
      const r = await mod.rpcRegisterDeviceKey({ cfg, publicKey: body.publicKey })
      if (!r?.ok) return fallback(url, init)
      // 返回一个最小 Response,让 DeviceSigner 的既有解析逻辑照常工作
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
 * 构造 bun 侧的会话读取器(GET /api/v1/freebuff/session).
 *
 * 必须接收并透传 opts.instanceId / opts.heartbeat: 不透传时 bun 侧的
 * /session GET 不带 x-freebuff-instance-id, 也不发 x-freebuff-heartbeat: 1.
 * 官方在 admission 成功后立刻发一次这形态的心跳, 之后每 45 秒一次
 * (orchestrator.js:208918-208957); 不发心跳会让会话在 admission 后约 25 秒
 * 被上游退款(session_superseded + "purchase was refunded").
 *
 * @param {string} token 上游 token
 * @param {string} [accountId] 账号 id
 * @param {string} apiBase 上游 API 主机
 * @param {string} [deviceKeyPath] 设备密钥文件路径
 * @param {any} [egress] 统一出口(null = 按 env 判定)
 * @returns {(opts?: { instanceId?: string | null, heartbeat?: boolean }) => Promise<any>}
 *   会话体;bun 不可用/非 401 失败时返回 null(调用方回落 Node)
 */
export function makeSessionViaBun(
  token: string,
  accountId?: string,
  apiBase?: string,
  deviceKeyPath?: string,
  egress?: any,
): (opts?: { instanceId?: string | null, heartbeat?: boolean }) => Promise<any> {
  let loader: Promise<any> | null = null
  return async (opts: { instanceId?: string | null, heartbeat?: boolean } = {}) => {
    try {
      if (!bunEnabled() || !bunCanCarry(egress)) return null
      if (loader === null) loader = import('../rpc/official-rpc.ts').catch(() => null)
      const mod: any = await loader
      if (!mod?.rpcSession || !mod?.buildRpcCfg) return null
      /**
       * 复用已有的 buildRpcCfg  --  它负责从 deviceKeyPath 读 keyId/privateKey.
       * 不在这里重写凭据装配逻辑(官方形态的实现只有一份).
       */
      const cfg: any = await mod.buildRpcCfg(
        { token, accountId, deviceKeyPath },
        { upstream: { timeZone: 'Asia/Shanghai', apiBase } },
      )
      if (!cfg) return null
      // 会话这一跳客户端是带 install-id 的(chat 不带,故 buildRpcCfg 置 null)
      cfg.installId = installIdFromClientState() || null
      // 主机随主服务配置走, 保证镜像对照与主服务指向同一上游(硬编码会让
      // 本地镜像对照变成真的打到上游), 见
      // .agents/notes/implemented/bug-fix/2026-10-03-session-via-bun-port.md
      cfg.apiHost = apiBase || null
      // 出口同理: bun 读不到控制台代理设置, 只能由 Node 侧下传.
      cfg.proxy = egress?.bunProxy ?? null
      const r = await mod.rpcSession({
        cfg,
        instanceId: opts.instanceId || null,
        heartbeat: opts.heartbeat === true,
      })
      return unwrapSessionViaBun(r, cfg)
    } catch {
      return null
    }
  }
}

/**
 * 判定 bun 侧会话返回:401 显式抛出,其余失败回落 Node,成功返回会话体.
 *
 * 401 直接抛出, 不回落 Node: 重试换运行时不会改变"上游不认这个 token"这个语义,
 * 只会多制造一次被拒记录并吞掉 bun 那一跳的关键字段(status / hasKeyId).
 *
 * 抛出时标注本次到底签没签名(cfg.keyId): 它是[token 真坏了]与
 * [设备未注册导致被拒]的分流判据 ---- 签名齐全仍 401 = token 坏;
 * 没签名就 401 = 先去查设备密钥.
 *
 * 其余失败(网络/bun 本身挂了/status 非 401)回落 Node.
 * 见 docs/reverse/21 §21.5[通道接上 ≠ 通道生效].
 *
 * @param {{ ok?: boolean, status?: number, body?: any, error?: string } | null} r bun 侧回执
 * @param {{ keyId?: string | null }} cfg 本次装配的 cfg(取 keyId 作为签名判据)
 * @returns {any} 会话体;非 401 失败返回 null
 */
export function unwrapSessionViaBun(r: any, cfg: any): any {
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
          // 本次是否带了设备签名:401 时它是第一分流判据
          // (signed = token 真坏;unsigned = 先查设备密钥注册)
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
}
