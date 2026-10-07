/**
 * 统一上游出口 ---- 进程内所有出网请求的唯一入口.
 *
 * 一条纪律: 任何要发请求的地方都必须经由本模块拿到 fetch / bun 通道参数,
 * 不许自己调 undici 的 fetch, 不许自己 new ProxyAgent, 不许自己读
 * HTTP(S)_PROXY. 出口只有这一处说了算(判据在 ./resolve.ts).
 *
 * 出口优先级(高到低): 账号显式 proxy > 全局池 > upstream.proxy > env > 直连.
 * 只有以上全空时才直连.
 *
 * 两条传输通道共用同一份出口判据:
 *   - Node 通道: egress.fetch   ---- 始终带 dispatcher, 池内失败自动回落;
 *   - bun 通道:  egress.bunProxy ---- 交给 cli-bridge 侧 fetch 的 proxy 参数.
 *
 * bun 承载不了的出口(socks, 实测抛 UnsupportedProxyProtocol)一律留在 Node 侧
 * 执行, 绝不"用不了就直连" ---- 那会把宿主真实出口 IP 暴露给上游.
 *
 * 见 .agents/notes/implemented/architecture/2026-10-07-unified-upstream-egress.md
 */
import { bunCanUseProxy, bunProxyArg, resolveProxy } from './resolve.ts'
import { buildFetchWithProxy } from '../transport.ts'

/** createEgress 的入参. */
interface EgressOpts {
  config: any
  accountId?: string
  accountProxy?: string | null
}

/** 统一出口对象(所有上游请求的唯一入口). */
export interface Egress {
  /** Node 侧唯一出口:始终带 dispatcher, 池内失败自动回落下一个. */
  fetch: (url: string, init?: Record<string, any>) => Promise<any>
  /** 本次生效的出口地址(null = 直连), 供控制台展示与日志. */
  proxyUrl: string | null
  /** 本次出口能否交给 bun 运行时承载. */
  bunEligible: boolean
  /** 交给 bun 侧 fetch 的 proxy 参数(null = 让 bun 自己按 env 判定). */
  bunProxy: string | null
  /** 底层代理解析结果(排查用: kind 与 source). */
  resolution: any
}

/**
 * 构造统一出口.
 *
 * @param {EgressOpts} opts 配置与账号级覆盖项
 * @returns {Egress} 统一出口对象
 */
export function createEgress(opts: EgressOpts): Egress {
  const resolution = resolveProxy(opts.config, opts.accountProxy, opts.accountId)
  const poolIndex = resolution.kind === 'pool' ? resolution.indexFor(opts.accountId || 'catalog') : 0
  return {
    fetch: buildFetchWithProxy(resolution, poolIndex),
    proxyUrl: resolution.url || null,
    bunEligible: bunCanUseProxy(resolution.url),
    bunProxy: bunProxyArg(resolution),
    resolution,
  }
}

/**
 * 按配置构造出口(无账号上下文时的便捷入口, 如 catalog 同步 / 遥测).
 *
 * 与 createEgress 是同一份判据, 只是省掉了账号字段: 这些旁路出网属于
 * 进程级, 不属于某个账号.
 *
 * @param {any} config 已加载配置
 * @returns {Egress} 统一出口对象
 */
export function egressForConfig(config: any): Egress {
  return createEgress({ config })
}

/**
 * 本次出口能否交给 bun 通道承载.
 *
 * 判据来自出口对象自身(bunEligible): bun 不支持的代理协议(实测 socks5/socks)
 * 必须留在 Node 侧执行. 绝不能"用不了就直连"  --  那会把宿主真实出口 IP 暴露给
 * 上游(issue #5 的 session_model_mismatch 根因).
 *
 * 放在这里而不是 bun 通道包装层: 这是出口的判据, bun 通道只是它的一个消费者.
 *
 * @param {any} egress 统一出口(null = 无出口信息, 按可承载处理)
 * @returns {boolean} true 表示 bun 可以承载
 */
export function bunCanCarry(egress: any): boolean {
  return egress?.bunEligible !== false
}

export { bunCanUseProxy, bunProxyArg, resolveProxy } from './resolve.ts'
