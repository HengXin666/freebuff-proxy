/**
 * settings 域:运行设置(GET 快照 / POST 热更新)+ 只读配置视图.
 *
 * ! 为什么 GET 与 POST 必须同一个文件:这个端点的读口径与写口径是同一张
 * 字段表.分开放最容易出现的漂移是"写进去的字段 GET 没回显",于是前端
 * 保存后刷新一次设置就变回旧值 ---- 用户看到的现象是"设置保存不了".
 */
import { sendJson } from '../../../util/http.js'
import { logger } from '../../../util/log.js'
import { envProxyOrNull } from '../lib/helpers.ts'
import { denyUnlessAdmin } from '../lib/http-codes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 读快照:把内存设置与 config.yaml 默认值合成一个扁平对象.
 *
 * @param {any} config
 * @param {any} settingsStore
 * @returns {Record<string, any>} 前端消费的设置快照
 */
function readSettings(config: any, settingsStore: any) {
  const s = settingsStore?.get() || {}
  return {
    freeToolSignatureEnabled: s.freeToolSignatureEnabled !== false,
    stripToolsOnSchemaRejection: s.stripToolsOnSchemaRejection === true,
    accountMaxConcurrency: s.accountMaxConcurrency ?? 2,
    // 账号调度模式('sticky' 默认 / 'spread' 并发优先)+ 溢出排队上限.
    accountSchedulingMode: s.accountSchedulingMode === 'spread' ? 'spread' : 'sticky',
    accountOverflowWaitMs: s.accountOverflowWaitMs ?? 15_000,
    blockPremiumModels: s.blockPremiumModels === true,
    // 额度保护:空闲自动释放秒数 + 单请求新会话预算.
    // 未在控制台保存过时回落 config.yaml 的默认值(默认 600s,见 config.js).
    idleReleaseSec: s.idleReleaseSec ?? config.session.idleReleaseSec ?? 600,
    maxNewSessionsPerRequest:
      s.maxNewSessionsPerRequest ?? config.limits.maxNewSessionsPerRequest ?? 2,
    // "低额度"分组阈值(FB).纯前端分组,不参与调度;0 = 关闭分组.
    lowBalanceThreshold: s.lowBalanceThreshold ?? 15,
    // 遥测上报开关:官方 CLI 会发 app_launched 等生命周期事件,我们默认不发.
    cliTelemetryEnabled: s.cliTelemetryEnabled === true,
    // 上游请求形态通道('legacy' 默认 / 'official' 照抄官方抓包).
    // 见 src/upstream/official-shape.js
    upstreamChannel: s.upstreamChannel === 'official' ? 'official' : 'legacy',
  }
}

/**
 * 字段校验表:[字段, 校验失败文案, 归一化].
 *
 * 每条都先判类型再判范围,且必须显式区分"没传"(跳过)与"传了非法值"
 * (400)---- 把 undefined 当"要清零"是这类接口最典型的事故.
 *
 * 元组必须显式标注:不标的话 TS 会把每一行推成 (string | 函数)[],
 * 解构出来的 ok 就不可调用(buildPatch 里的 ok(...) 直接报 TS2349),
 * 而 key 也不再是 string(索引 patch 报 TS7053).
 */
type FieldSpec = [string, string, (v: unknown) => boolean]

const FIELDS: FieldSpec[] = [
  ['freeToolSignatureEnabled', 'freeToolSignatureEnabled 必须是布尔值', (v: any) => typeof v === 'boolean'],
  ['stripToolsOnSchemaRejection', 'stripToolsOnSchemaRejection 必须是布尔值', (v: any) => typeof v === 'boolean'],
  [
    'accountMaxConcurrency',
    'accountMaxConcurrency 必须是 1..16 的整数',
    (v: any) => Number.isInteger(v) && v >= 1 && v <= 16,
  ],
  [
    'accountSchedulingMode',
    "accountSchedulingMode 必须是 'sticky' 或 'spread'",
    (v: any) => v === 'sticky' || v === 'spread',
  ],
  [
    'accountOverflowWaitMs',
    'accountOverflowWaitMs 必须是 0..600000 的整数（毫秒）',
    (v: any) => Number.isInteger(v) && v >= 0 && v <= 600_000,
  ],
  ['blockPremiumModels', 'blockPremiumModels 必须是布尔值', (v: any) => typeof v === 'boolean'],
  [
    'lowBalanceThreshold',
    'lowBalanceThreshold 必须是 0 或 1..10000 的整数（0 = 关闭低额度分组）',
    (v: any) => Number.isInteger(v) && v >= 0 && v <= 10_000,
  ],
  [
    'idleReleaseSec',
    'idleReleaseSec 必须是 0 或 5..86400 的整数（0 = 关闭空闲释放）',
    (v: any) => Number.isInteger(v) && v >= 0 && v <= 86_400,
  ],
  [
    'maxNewSessionsPerRequest',
    'maxNewSessionsPerRequest 必须是 0..16 的整数（0 = 不限制）',
    (v: any) => Number.isInteger(v) && v >= 0 && v <= 16,
  ],
  ['cliTelemetryEnabled', 'cliTelemetryEnabled 必须是布尔值', (v: any) => typeof v === 'boolean'],
  // 上游请求形态通道(legacy / official).见 src/upstream/official-shape.js
  [
    'upstreamChannel',
    "upstreamChannel 必须是 'legacy' 或 'official'",
    (v: any) => v === 'legacy' || v === 'official',
  ],
]

/**
 * 把请求体过滤成合法的 patch;非法值直接写 400 并返回 null.
 *
 * @param {any} body 请求体
 * @param {import('node:http').ServerResponse} res
 * @returns {Record<string, any> | null} 合法 patch;有非法值为 null
 */
function buildPatch(body: any, res: ServerResponse) {
  // 显式标注:不标的话 patch 被推成 {},按下标赋值报 TS7053.
  const patch: Record<string, unknown> = {}
  for (const [key, message, ok] of FIELDS) {
    if (body[key] === undefined) continue
    if (!ok(body[key])) {
      sendJson(res, 400, { error: message })
      return null
    }
    patch[key] = body[key]
  }
  return patch
}

/**
 * settings / config 端点.
 *
 * @param {string} method HTTP 方法
 * @param {string} route 规范化路径
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
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
  const { config, settingsStore, readJson } = ctx
  if (route !== '/api/settings' && route !== '/api/config') return false

  if (method === 'GET' && route === '/api/settings') {
    sendJson(res, 200, readSettings(config, settingsStore))
    return true
  }

  if (method === 'POST' && route === '/api/settings') {
    if (denyUnlessAdmin(user, res)) return true
    if (!settingsStore) {
      sendJson(res, 501, { error: '当前进程未启用运行设置存储' })
      return true
    }
    let body
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '无效的 JSON' })
      return true
    }
    const patch = buildPatch(body, res)
    if (!patch) return true
    if (!Object.keys(patch).length) {
      sendJson(res, 400, { error: '没有可保存的设置项' })
      return true
    }
    const settings = settingsStore.save(patch)
    logger.info('runtime settings updated via web', settings)
    sendJson(res, 200, { ok: true, ...settings })
    return true
  }

  if (route === '/api/config' && method === 'GET' && user.role === 'admin') {
    sendJson(res, 200, {
      config: {
        server: {
          host: config.server.host,
          port: config.server.port,
          dataDir: config.server.dataDir,
          apiKeyCount: config.server.apiKeys.length,
        },
        upstream: {
          apiBase: config.upstream.apiBase,
          loginBase: config.upstream.loginBase,
          proxy: config.upstream.proxy || envProxyOrNull(),
          proxies: config.upstream.proxies || [],
          credentialsDir: config.upstream.credentialsDir,
        },
        web: config.web,
      },
    })
    return true
  }
  return false
}
