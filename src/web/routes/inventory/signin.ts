/**
 * 签到域: 一键签到(手动) + 自动签到设置.
 *
 * ## 语义(先说清楚, 因为"签到"不是一次接口调用)
 *
 * 官方没有签到接口. GET /api/v1/freebuff/streak 只读状态;
 * 当天签到由[当天第一条消息]触发(见 src/web/store/signin/run.ts 的文件头).
 * 所以这里的"一键签到"= 逐账号读状态, 对今天还没签的账号发一条最小消息.
 * 已签过的账号会被跳过, 不重复付费.
 *
 * ## 防抖(用户要求)
 *
 *   - 手动: 18 小时内只允许触发一次;
 *   - 自动: 25 小时间隔, 由设置页开关控制, 默认关闭.
 * 判据落在服务端(store 里的 lastManualAt / lastAutoAt), 刷新页面绕不过.
 */
import { sendJson } from '../../../util/http.ts'
import { logger } from '../../../util/log.ts'
import { runSignInRound } from '../../store/signin/run.ts'
import { MANUAL_COOLDOWN_HOURS } from '../../store/signin/store.ts'
import { denyUnlessAdmin } from '../lib/http-codes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 组一份签到所需的依赖快照.
 *
 * 目录与运行设置都从 ctx 现取: 签到是低频动作, 不需要缓存这两份.
 *
 * @param {any} ctx 路由上下文
 * @returns {any} runSignInRound 的依赖
 */
function signInDeps(ctx: any) {
  const settings = ctx.settingsStore?.get?.() || {}
  return {
    runtimes: ctx.runtimes,
    config: ctx.config,
    catalogCache: ctx.catalogRows?.() || { rows: [] },
    settings: {
      officialToolNames: settings.officialToolNames,
      systemPrompt: typeof ctx.resolveSystemPrompt === 'function'
        ? ctx.resolveSystemPrompt(settings)
        : undefined,
    },
    store: ctx.signInStore,
  }
}

/**
 * GET /api/signin ---- 签到状态(只读).
 *
 * 回执要能让前端一次画全: 手动是否可点(剩余防抖时间), 自动开关当前值,
 * 上次签到时间, 每账号最近一次结果.
 *
 * @param {any} res
 * @param {any} ctx
 * @returns {void} 无返回值
 */
function signInStatus(res: ServerResponse, ctx: any) {
  const store = ctx.signInStore
  const st = store?.get?.() || { lastManualAt: null, lastAutoAt: null, perAccount: {} }
  const gate = store?.manualAllowed?.() || { allowed: true, remainMs: 0 }
  const settings = ctx.settingsStore?.get?.() || {}
  sendJson(res, 200, {
    ok: true,
    canSignIn: gate.allowed,
    remainMs: gate.remainMs,
    cooldownHours: MANUAL_COOLDOWN_HOURS,
    autoEnabled: settings.autoSignInEnabled === true,
    lastManualAt: st.lastManualAt,
    lastAutoAt: st.lastAutoAt,
    perAccount: st.perAccount,
    /** 本次运行内的最近一次结果(内存态, 供"刚点完看结果"). */
    lastResult: ctx.lastSignInResult || null,
    /** 影响面(本地估算): 确认框要把[会影响几个账号]摆出来. */
    impact: signInImpact(ctx),
  })
}

/**
 * 从本地缓存估出这次签到的影响面.
 *
 * 必须在本地算, 不能在 GET 里读上游 streak ----
 * 本仓铁律是[零自动探测]: 只有用户主动刷新时才准打上游
 * (docs/reverse/20 的 20.3). 而 /api/signin 是进总览页就会调的,
 * 让它去打上游等于每次开页面都多发一轮请求.
 *
 * 所以这里只回[能算的]: 账号总数 / 存活数 / 有没有 0 价模型.
 * [今天是否已签]只有真正执行时才逐个读(那是用户点了确认之后的事).
 *
 * @param {any} ctx 路由上下文
 * @returns {any} 影响面预估
 */
function signInImpact(ctx: any) {
  try {
    const rows = ctx.runtimes?.list?.() || []
    const alive = rows.filter((r: any) => !r.banned && !r.bannedAt)
    let hasZeroPrice = false
    for (const r of alive) {
      const prices = r?.freebucks?.prices
      if (prices && typeof prices === 'object'
        && Object.values(prices).some((v: any) => v === 0)) {
        hasZeroPrice = true
        break
      }
    }
    return { accounts: rows.length, alive: alive.length, hasZeroPrice }
  } catch {
    return { accounts: 0, alive: 0, hasZeroPrice: false }
  }
}

/**
 * POST /api/signin ---- 一键签到(对所有存活账号跑一轮).
 *
 * 防抖: 18 小时内重复调用直接回 429 并给出剩余时间, 不执行.
 * 这是服务端判据, 前端按钮置灰只是它的可视化.
 *
 * @param {any} res
 * @param {any} ctx
 * @param {any} user
 * @returns {Promise<void>} 无返回值
 */
async function signInAll(res: ServerResponse, ctx: any, user: any) {
  if (denyUnlessAdmin(user, res)) return
  const store = ctx.signInStore
  if (!store) {
    sendJson(res, 501, { error: '签到存储未启用' })
    return
  }
  const gate = store.manualAllowed()
  if (!gate.allowed) {
    sendJson(res, 429, {
      error: '手动签到在防抖窗口内',
      remainMs: gate.remainMs,
      cooldownHours: MANUAL_COOLDOWN_HOURS,
    })
    return
  }
  if (ctx.signInRunning) {
    sendJson(res, 409, { error: '已有签到在进行中' })
    return
  }
  ctx.signInRunning = true
  try {
    const summary = await runSignInRound(signInDeps(ctx), 'manual')
    ctx.lastSignInResult = { at: Date.now(), kind: 'manual', ...summary }
    sendJson(res, 200, { ok: true, ...summary })
  } catch (err) {
    logger.warn('signin round failed', { error: String(err) })
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  } finally {
    ctx.signInRunning = false
  }
}

/**
 * 签到域路由.
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
  void req
  if (route === '/api/signin' && method === 'GET') {
    signInStatus(res, ctx)
    return true
  }
  if (route === '/api/signin' && method === 'POST') {
    await signInAll(res, ctx, user)
    return true
  }
  return false
}
