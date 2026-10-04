/**
 * proxy 域:全局代理池的读/写 + 出口连通性测试.
 *
 * 与账号级 proxy 字段(/api/accounts/:key PATCH)分开:那是"这个号绑死
 * 某个出口",这里是"整池怎么配".两者优先级见 AGENTS.md"代理"一节.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'

import { sendJson } from '../../../util/http.js'
import { logger } from '../../../util/log.js'
import { envProxyOrNull, uniqueStrings } from '../lib/helpers.ts'
import { denyUnlessAdmin } from '../lib/http-codes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 代理连通性测试的结果形状.
 *
 * 必须显式声明:JSDoc @type 在 .ts 文件里 tsc 不认(type 一律从初始化式推),
 * 于是 out.error = '...' 会被推成"只能赋 null"(TS2322),hint 甚至判成
 * "属性不存在"(TS2339).字段全给成可空,与下面每条赋值路径一一对应.
 */
interface ProxyTestResult {
  proxy: string
  ok: boolean
  error: string | null
  ip: string | null
  country: string | null
  latencyMs: number | null
  codebuffStatus: number | null
  hint?: string
}

/**
 * 从任意抛出物里取底层原因码(undici 把 ENOTFOUND 这类挂在 err.cause.code).
 *
 * catch 到的值在 strict 下是 unknown,直接读 .cause/.code 会被拒;
 * 这里收成一个窄接口再判,顺便把"非对象/无 cause"的情形一次挡掉.
 */
function causeCodeOf(err: unknown): string | null {
  const cause = (err as { cause?: unknown } | null)?.cause
  if (!cause || typeof cause !== 'object') return null
  const code = (cause as { code?: unknown }).code
  return code ? String(code) : null
}

/**
 * 通过指定代理做连通性测试:
 * 1. GET https://www.cloudflare.com/cdn-cgi/trace -> 出口 IP + 国家(证明真的走了该代理)
 * 2. GET https://codebuff.com/ -> 真实目标可达性
 *
 * @param {string} proxyUrl 代理地址
 * @param {number} [timeoutMs] 单项超时(毫秒)
 * @returns {Promise<ProxyTestResult>} 测试结果(含 ip/country/latencyMs/codebuffStatus/error)
 */
async function testProxyUrl(proxyUrl: any, timeoutMs = 12_000): Promise<ProxyTestResult> {
  const started = Date.now()
  const out: ProxyTestResult = {
    proxy: proxyUrl,
    ok: false,
    error: null,
    ip: null,
    country: null,
    latencyMs: null,
    codebuffStatus: null,
  }
  let agent
  try {
    agent = new ProxyAgent({ uri: proxyUrl })
  } catch (err) {
    out.error = `代理地址解析失败: ${err instanceof Error ? err.message : String(err)}`
    out.latencyMs = Date.now() - started
    return out
  }
  try {
    const traceRes = await undiciFetch('https://www.cloudflare.com/cdn-cgi/trace', {
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (traceRes.ok) {
      const text = await traceRes.text()
      out.ip = text.match(/^ip=(.+)$/m)?.[1] || null
      out.country = text.match(/^loc=(.+)$/m)?.[1] || null
    } else {
      out.error = `trace HTTP ${traceRes.status}`
    }
    try {
      const cbRes = await undiciFetch('https://codebuff.com/', {
        dispatcher: agent,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      })
      out.codebuffStatus = cbRes.status
    } catch {
      out.codebuffStatus = null
    }
    out.ok = true
  } catch (err) {
    const causeCode = causeCodeOf(err)
    out.error =
      (err instanceof Error ? err.message : String(err)) +
      (causeCode ? ` (${causeCode})` : '')
  } finally {
    out.latencyMs = Date.now() - started
  }
  if (!out.ok && String(proxyUrl).includes('host.docker.internal')) {
    out.hint =
      'host.docker.internal 只表示"跑容器的那台宿主机本身"：仅当代理就运行在这台宿主机上才可能通' +
      '（且需代理监听 0.0.0.0 / Clash 开 Allow LAN）。' +
      '如果你的代理在其他机器上，直接填它的真实 IP，例如 http://192.168.1.10:2334。'
  }
  return out
}

/**
 * 候选代理:显式指定 > 全局池 > 单代理配置 > 环境变量(去重).
 *
 * @param {any} body 请求体
 * @param {any} proxyStore
 * @param {any} config
 * @returns {string[]} 待测代理列表
 */
function candidatesOf(body: any, proxyStore: any, config: any) {
  const requested =
    typeof body.proxy === 'string' && body.proxy.trim() ? body.proxy.trim() : null
  if (requested) return [requested]
  const pool = proxyStore ? proxyStore.list() : config.upstream.proxies || []
  const candidates = []
  for (const p of pool) if (p) candidates.push(p)
  if (config.upstream.proxy) candidates.push(config.upstream.proxy)
  const envProxy = envProxyOrNull()
  if (envProxy && !candidates.includes(envProxy)) candidates.push(envProxy)
  return candidates
}

/**
 * GET /api/proxy ---- 列出已配置代理 + 实际生效的代理 + 每账号绑定.
 *
 * @param {ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {void}
 */
function listProxies(res: ServerResponse, ctx: any) {
  const { config, proxyStore, runtimes } = ctx
  const configured = proxyStore ? proxyStore.list() : config.upstream.proxies || []
  sendJson(res, 200, {
    proxies: configured,
    // 实际生效的代理(含单代理/环境变量),用于前端展示
    effective: uniqueStrings([
      ...(configured || []),
      ...(config.upstream.proxy ? [config.upstream.proxy] : []),
      ...(envProxyOrNull() ? [envProxyOrNull()] : []),
    ]),
    accounts: runtimes.list().map((a: any) => ({
      key: a.key,
      id: a.id || null,
      email: a.email,
      proxy: a.proxy || null,
      effectiveProxy: a.effectiveProxy || null,
    })),
  })
}

/**
 * POST /api/proxy ---- 保存代理池并立即生效.
 *
 * 除了落盘,还要更新运行配置并重建缓存 runtime(释放旧 session,走新出口)
 * ---- 否则"保存了但要重启才生效"会回到前端点了没反应的观感.
 *
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {Promise<void>}
 */
async function saveProxies(req: IncomingMessage, res: ServerResponse, ctx: any) {
  const { config, proxyStore, runtimes, readJson } = ctx
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return
  }
  const proxies = proxyStore.save(body.proxies)
  config.upstream.proxies = proxies
  await runtimes.invalidateProxies()
  logger.info('proxy pool updated via web', { proxies })
  sendJson(res, 200, {
    ok: true,
    proxies,
    note: proxies.length
      ? '已保存并立即生效（账号出口已切换）'
      : '已清空全局代理池（将走环境变量/直连）',
  })
}

/**
 * POST /api/proxy/test ---- 逐个候选代理做连通性测试.
 *
 * 代理连通性测试:走该代理访问 Cloudflare trace 拿出口 IP/地区,再探测 codebuff.
 * 只读,无副作用;body.proxy 为空时测试当前生效的代理配置.
 *
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {Promise<void>}
 */
async function testProxies(req: IncomingMessage, res: ServerResponse, ctx: any) {
  const { config, proxyStore, readJson } = ctx
  let body: any = {}
  try {
    body = await readJson(req)
  } catch {
    // 忽略非法 body，按"测当前配置"处理
  }
  const candidates = candidatesOf(body, proxyStore, config)
  if (!candidates.length) {
    sendJson(res, 200, {
      ok: true,
      results: [],
      note: '未配置任何代理（当前直连）。可在 config 配 upstream.proxies 或给本接口传 proxy。',
    })
    return
  }
  const results = []
  for (const p of candidates) results.push(await testProxyUrl(p))
  sendJson(res, 200, { ok: true, results })
}

/**
 * 代理池端点.
 *
 * @param {string} method HTTP 方法
 * @param {string} route 规范化路径
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {any} user 当前用户
 * @param {any} ctx 路由上下文
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handle(
  method: string,
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  user: any,
  ctx: any,
) {
  const { proxyStore } = ctx
  if (route !== '/api/proxy' && route !== '/api/proxy/test') return false

  if (method === 'GET' && route === '/api/proxy') {
    listProxies(res, ctx)
    return true
  }

  if (method === 'POST' && route === '/api/proxy') {
    if (denyUnlessAdmin(user, res)) return true
    if (!proxyStore) {
      sendJson(res, 501, { error: '当前进程未启用代理存储' })
      return true
    }
    await saveProxies(req, res, ctx)
    return true
  }

  if (method === 'POST' && route === '/api/proxy/test') {
    await testProxies(req, res, ctx)
    return true
  }
  return false
}
