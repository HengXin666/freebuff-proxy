/**
 * settings 域:运行设置(GET 快照 / POST 热更新)+ 只读配置视图.
 *
 * 读快照已按体量拆到 ./settings/read.ts(原文件补完官方 system 回显后 346 行,
 * 撞了后端 300 行硬红线); 本文件只保留[写]与路由分流.
 */
import { sendJson } from '../../../util/http.ts'
import { specOf, validateValue, secretsFromValues, redactTunables } from '../../../config/tunable/store.ts'
import { logger } from '../../../util/log.ts'
import { envProxyOrNull } from '../lib/helpers.ts'
import { denyUnlessAdmin } from '../lib/http-codes.ts'
import { readSettings } from './settings/read.ts'
import { isReasoningOverrideShape } from '../../../proxy/reasoning-effort.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'


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
  // 官方工具注入名单: 空数组合法(一个都不注入), 所以只判元素类型不判长度.
  [
    'officialToolNames',
    'officialToolNames 必须是字符串数组',
    (v: any) => Array.isArray(v) && v.every((x: any) => typeof x === 'string'),
  ],
  // 上游请求形态通道(legacy / official).见 src/upstream/official-shape.js
  [
    'upstreamChannel',
    "upstreamChannel 必须是 'legacy' 或 'official'",
    (v: any) => v === 'legacy' || v === 'official',
  ],
  // 官方 system 提示词三态 + 自定义正文(见 settings-store 的接口注释).
  // 正文只卡长度不卡内容: 用户可能想贴任何指令, 语义校验只会挡住正当用法.
  [
    'officialSystemPromptMode',
    "officialSystemPromptMode 必须是 'official' / 'custom' / 'none'",
    (v: any) => v === 'official' || v === 'custom' || v === 'none',
  ],
  [
    'officialSystemPromptText',
    'officialSystemPromptText 必须是长度不超过 200000 的字符串',
    (v: any) => typeof v === 'string' && v.length <= 200_000,
  ],
  // 自动签到开关(默认关闭; 间隔固定 25 小时).
  ['autoSignInEnabled', 'autoSignInEnabled 必须是布尔值', (v: any) => typeof v === 'boolean'],
  // 思考强度覆盖(见 src/proxy/reasoning-effort.ts).
  [
    'reasoningOverride',
    'reasoningOverride 必须是 { enabled, models: [{ model, effort }] }(effort 取上游档位枚举)',
    (v: any) => isReasoningOverrideShape(v),
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
 * 从请求体挑出"可调项"(点分路径)并按声明校验.
 *
 * 与实时字段的关系: 两类写入同一个 settings.json, 但生效方式不同 ----
 * 实时字段存入即生效(走 getter), 可调项要等下次启动合并进 config.
 * 因此响应里必须分别回报, 前端才能给出准确提示(哪些已生效/哪些要重启).
 * @param {any} body 请求体
 * @param {import('node:http').ServerResponse} res
 * @returns {Record<string, any> | null} 合法可调项; 有非法值时为 null(已写 400)
 */
function buildTunablePatch(body: any, res: ServerResponse) {
  const patch: Record<string, any> = {}
  for (const [k, v] of Object.entries(body || {})) {
    if (!k.includes('.')) continue
    const spec = specOf(k)
    if (!spec) {
      sendJson(res, 400, { error: `未知配置项: ${k}` })
      return null
    }
    const err = validateValue(spec, v)
    if (err) {
      sendJson(res, 400, { error: err })
      return null
    }
    patch[k] = v
  }
  return patch
}

/**
 * POST /api/settings: 保存实时字段 + 可调项.
 *
 * 分流两类写入(它们的生效方式不同), 并在回执里把凭据项抹掉 ----
 * 刚写盘的值里就含凭据, 原样回等于[刚填的 Key 出现在响应体里].
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} user 当前用户
 * @param {any} ctx 路由上下文
 * @returns {Promise<void>}
 */
async function saveSettings(req: IncomingMessage, res: ServerResponse, user: any, ctx: any) {
  const { settingsStore, readJson } = ctx
  if (denyUnlessAdmin(user, res)) return
  if (!settingsStore) {
    sendJson(res, 501, { error: '当前进程未启用运行设置存储' })
    return
  }
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return
  }
  // 可调项(点分路径)按声明校验; 有非法值即已写出 400 并返回 null.
  const tunablePatch = buildTunablePatch(body, res)
  if (!tunablePatch) return
  const patch = buildPatch(body, res)
  if (!patch) return
  if (!Object.keys(patch).length && !Object.keys(tunablePatch).length) {
    sendJson(res, 400, { error: '没有可保存的设置项' })
    return
  }
  const settings = Object.keys(patch).length ? settingsStore.save(patch) : settingsStore.get()
  const savedTunables = Object.keys(tunablePatch).length
    ? settingsStore.saveTunables(tunablePatch)
    : settingsStore.savedTunables()
  logger.event('settingsChange', 'info', 'runtime settings updated via web', {
    live: Object.keys(patch),
    tunables: Object.keys(tunablePatch),
  })
  sendJson(res, 200, {
    ok: true,
    ...settings,
    tunables: redactTunables(savedTunables),
    secrets: secretsFromValues(savedTunables),
    restartRequired: Object.keys(tunablePatch).length > 0,
  })
}

/**
 * GET /api/config 的只读视图(admin).
 *
 * 凭据只回条数: apiKeyCount 是前端"配了几把"的展示需求, 值一律不出.
 * @param {any} config 配置对象
 * @returns {any} 视图
 */
function configView(config: any) {
  return {
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
  }
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
  const { config, settingsStore } = ctx
  if (route !== '/api/settings' && route !== '/api/config') return false

  if (method === 'GET' && route === '/api/settings') {
    // 对已认证用户开放(设置页对非 admin 渲染成只读态), 但凭据项的值
    // 一律不回 ---- 见 readSettings 里的 snapshotTunables / secretsEffective.
    // 屏蔽发生在真源那一层, 所以这个回执给谁看都是安全的.
    sendJson(res, 200, readSettings(config, settingsStore, ctx))
    return true
  }

  if (method === 'POST' && route === '/api/settings') {
    await saveSettings(req, res, user, ctx)
    return true
  }

  if (route === '/api/config' && method === 'GET' && user.role === 'admin') {
    sendJson(res, 200, configView(config))
    return true
  }
  return false
}
