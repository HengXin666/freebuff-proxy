/**
 * 可观测面:总览 / 日志环形缓冲 / 数据文件自检.
 *
 * 这三件事同属"排障时一眼看清现场",且都是只读(DELETE /api/logs 只清内存
 * 缓冲,不碰落盘数据).与"写操作"分开,避免一旦排障读取出问题就把重启/断连
 * 这类救火入口一起带崩.
 */
import path from 'node:path'

import type { LogQuery } from '../../../util/log.ts'
import { sendJson } from '../../../util/http.ts'
import { logger, readLogBuffer, clearRing } from '../../../util/log.ts'
import { dataFileAudit } from '../../../util/json-store.ts'
import { overviewModelNames } from '../lib/helpers.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * GET /api/overview ---- 控制台首页快照.
 *
 * slots 是全局请求闸门的实时占用:inFlight 长期贴着 limit 不降 = 槽位泄漏,
 * 这种"不接单"故障以前完全不可观测(只能靠体感发现并重启).
 *
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx
 * @returns {void}
 */
function overview(res: ServerResponse, ctx: any) {
  const { config, runtimes, modelStore, requestSlotStats, buildModelsListResponse } = ctx
  let models = []
  try {
    models = buildModelsListResponse({
      includeAllCatalog: true,
      hiddenModels: modelStore ? modelStore.hidden() : [],
    }).data
  } catch {
    models = []
  }
  const accounts = runtimes.list()
  sendJson(res, 200, {
    accounts,
    // 目录 key -> 可读显示名,供账号表"额度"chip 把 m-00032eaeec
    // 显示成 MiMo 2.6 Flash(前端不再裸显示服务端标识).
    modelNames: overviewModelNames(runtimes),
    accountCount: runtimes.allKeys().length,
    models: models.length,
    upstream: {
      apiBase: config.upstream.apiBase,
      loginBase: config.upstream.loginBase,
    },
    dataDir: config.server.dataDir,
    version: process.env.npm_package_version || '1.0.0',
    slots: requestSlotStats(),
  })
}

/**
 * 数据文件分级:critical = 丢失/损坏无法一键恢复,只能人工处置(users.json 的
 * 登录凭据真源,sessions.json 里可能还挂着没退款的计费会话句柄);
 * 其余都是"重建即可"的派生/配置数据,控制台按损坏列出并给出 mv 建议.
 */
const CRITICAL_DATA_FILES = new Set(['users.json', 'sessions.json'])

/**
 * 清空进程内日志缓冲(控制台"日志"页的"清空"按钮).
 *
 * 为什么需要:缓冲是环形且只保留最近 N 条,自动丢弃最旧的 ----
 * 但用户想"从这一刻起只看新的"时,旧条目仍然占着整页(尤其一次故障
 * 刷出几百条后,新日志被挤到最底下很难找).没有手动清空就只能重启
 * 进程,而重启会连带丢掉热会话现场.
 *
 * 只清内存缓冲,不碰落盘数据(data/ 与 sessions.json 都不动),
 * 也不影响正在进行的请求.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {any} user 当前用户
 * @returns {void}
 */
function clearLogs(res: ServerResponse, user: any) {
  const before = readLogBuffer({ limit: 1 }).length
  clearRing()
  logger.info('log buffer cleared by admin', {
    username: user.username,
    hadEntries: before > 0,
  })
  // 清完立刻返回空列表:前端不必再发一次 GET,也避免"清了但还显示旧的"错觉
  sendJson(res, 200, {
    ok: true,
    lines: [],
    total: 0,
    truncated: false,
    serverTime: new Date().toISOString(),
  })
}

/**
 * 控制台"日志"页:直接读进程内环形缓冲,让用户不必 docker logs 就能
 * 看到完整字段(上游判据如 countryBlockReason 只在这里才看得到).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function listLogs(req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url || '/', 'http://localhost')
  const q = u.searchParams
  const level = q.get('level') || 'all'
  const search = q.get('q') || ''
  const limitRaw = Number(q.get('limit'))
  const sinceTs = q.get('since') || null
  // reqId / account 过滤:控制台日志页据此把一次请求的多条日志聚成一组,
  // 或只看某个账号 ---- 多账号池并发时日志原本完全交织,没有这两个维度排不了障.
  const reqId = q.get('reqId') || null
  const account = q.get('account') || null
  const lines = readLogBuffer({
    level,
    q: search,
    limit: Number.isFinite(limitRaw) ? limitRaw : 300,
    sinceTs,
    ...(reqId ? { reqId } : {}),
    ...(account ? { account } : {}),
  } as unknown as LogQuery)
  sendJson(res, 200, {
    ok: true,
    lines,
    // 让前端知道缓冲里到底有多少,是否被裁掉(避免"以为看全了").
    total: lines.length,
    truncated: false,
    serverTime: new Date().toISOString(),
  })
}

/**
 * 数据文件自检:把 data/ 下每个 JSON 的装载状态(ok/missing/invalid)
 * 连同处置建议返回.起因是真实故障----镜像升级后起不来,日志里只有
 * 一行 warn,用户靠"删几个 json"试错;这里让控制台能一眼看到是哪个文件
 * 坏了,为什么,该怎么办.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx 路由上下文
 * @returns {void}
 */
function dataStatus(res: ServerResponse, ctx: any) {
  const files = dataFileAudit().map((f) => ({
    file: f.file,
    name: path.basename(f.file),
    status: f.status,
    reason: f.reason,
    critical: CRITICAL_DATA_FILES.has(path.basename(f.file)),
    // 条目级问题(文件本身合法,但有若干条记录结构非法被丢弃并留证):
    // 与"文件损坏"是两件事,处置办法也不同(这里不需要人工删文件).
    droppedEntries: f.droppedEntries || 0,
    droppedReason: f.droppedReason || null,
    droppedBackup: f.droppedBackup || null,
    // sessions.json 专用:还有几条上游会话句柄没结算(不是错误,是状态).
    // 控制台"系统"页把它显示成"N 条会话待结算",让清没清干净一眼可见.
    openHandles: f.openHandles || 0,
  }))
  sendJson(res, 200, {
    dir: ctx.config.server.dataDir,
    ok: files.every((f) => f.status !== 'invalid'),
    files,
    invalid: files.filter((f) => f.status === 'invalid'),
    dirty: files.filter((f) => f.droppedEntries > 0),
  })
}

/**
 * 日志与数据自检端点.
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
  if (route !== '/api/logs' && route !== '/api/system/data-status' && route !== '/api/overview') {
    return false
  }

  if (method === 'GET' && route === '/api/overview') {
    overview(res, ctx)
    return true
  }

  if (user.role !== 'admin') {
    sendJson(res, 403, { error: '需要管理员权限' })
    return true
  }

  if (method === 'DELETE' && route === '/api/logs') {
    clearLogs(res, user)
    return true
  }

  if (method === 'GET' && route === '/api/logs') {
    listLogs(req, res)
    return true
  }

  if (method === 'GET' && route === '/api/system/data-status') {
    dataStatus(res, ctx)
    return true
  }
  return false
}
