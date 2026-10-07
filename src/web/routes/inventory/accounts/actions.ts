/**
 * accounts 域(单账号动作侧):单账号检测 / 关闭会话 / 清冷却.
 *
 * 与 refresh 侧分开:那侧是"整池只读刷新",这侧是"针对某一个账号的动作用户
 * 主动点下去".其中"关闭会话"是唯一会动计费会话的动作 ---- 上游按占用
 * 时长结算,主动早退 DELETE 才是"停止计费"的唯一手段,所以走严格释放.
 */
import { sendJson } from '../../../../util/http.ts'
import { logger } from '../../../../util/log.ts'
import { overviewModelNames, probeErrorFields } from '../../lib/helpers.ts'
import { denyUnlessAdmin, decodeSegment } from '../../lib/http-codes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * POST /api/accounts/:key/probe ---- 单账号只读检测(前端每行的"检测"按钮).
 *
 *
 * @param {string} key 账号 key
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx
 * @returns {Promise<void>}
 */
async function probeOne(key: any, res: ServerResponse, ctx: any) {
  const { runtimes } = ctx
  const a = runtimes.list().find((x: any) => x.key === key)
  if (!a) {
    sendJson(res, 404, { error: '账号不存在' })
    return
  }
  try {
    const rt = runtimes.get(key)
    const session = await rt.sessions.refresh()
    sendJson(res, 200, {
      ok: true,
      key,
      email: a.email,
      account: runtimes.list().find((x: any) => x.key === key),
      session,
      // 有在途请求时 refresh() 主动跳过探测(顶掉活跃会话会撞 428):
      // 如实回报, 前端才能说明"这次没真问上游, 显示的是上次快照".
      skipped: rt.sessions.getSnapshot()?.probeSkipped || null,
      // 检测结果的 toast 里会列"每个模型的已用/上限",其键是目录 key ----
      // 带上映射,前端才显示得出模型名而不是 m-00032eaeec.
      modelNames: overviewModelNames(runtimes),
      note: '只读探测，未创建 session',
    })
  } catch (err) {
    const { code, status } = probeErrorFields(err)
    sendJson(res, 200, {
      ok: false,
      key,
      email: a.email,
      code,
      status,
      error: err instanceof Error ? err.message : String(err),
      note: '探测失败，见 code/error 字段',
    })
  }
}

/**
 * POST /api/accounts/:key/session ---- 用户主动结束该账号的上游计费会话.
 *
 * 这是唯一允许在付费时段内删除会话的路径: 用户看着面板上那条会话,
 * 按了按钮, 明确要停掉它 ---- 早退损失(那一小时作废)由他自己承担.
 * 所有系统内部的批量释放(重启 / 退出 / 换号 / 代理变更)都受付费时段
 * 保护, 见 src/session/release/release.ts 与 src/proxy/routes/auth.ts.
 *
 * 走严格释放(等到上游确认结束或退避重试耗尽),并如实返回结果;
 * 删不掉的句柄会留在 sessions.json,由下次启动扫尾继续退款.
 *
 * @param {string} key 账号 key
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} user 当前用户
 * @param {any} ctx
 * @returns {Promise<void>}
 */
async function closeSession(key: any, req: IncomingMessage, res: ServerResponse, user: any, ctx: any) {
  const { runtimes, readJson } = ctx
  const a = runtimes.list().find((x: any) => x.key === key)
  if (!a) {
    sendJson(res, 404, { error: '账号不存在' })
    return
  }
  let waitMs = 10_000
  try {
    const body = await readJson(req)
    if (Number.isFinite(body?.waitInFlightMs)) {
      waitMs = Math.max(0, Math.min(60_000, body.waitInFlightMs))
    }
  } catch {
    // 无 body / 非法 JSON：用默认等待窗口
  }
  let result
  try {
    const rt = runtimes.get(key)
    // 先等在途 SSE 自然结束(有界,不无限等),再释放----尽量不掐断正在
    // 传输的回复;超时仍在途则如实标记 interrupted 并照常释放(用户明确
    // 释放成功后句柄会被清空,先留一份供前端/日志展示"关掉的是哪条会话"
    const released = rt.sessions.getSnapshot()?.instanceId ?? null
    await rt.sessions._waitForIdle(waitMs)
    const interrupted = rt.sessions.inFlightCount() > 0
    // force: 用户显式关闭, 连付费时段内也删(唯一允许这么做的路径).
    const rel = await rt.sessions.releaseStrict({ force: true })
    const refund = rt.sessions.getSnapshot()?.lastRefund?.refund ?? null
    result = { ...rel, instanceId: rel.instanceId ?? released, interrupted, refund }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  logger.info('account session close requested via web console', {
    by: user.username,
    key,
    email: a.email,
    ok: result.ok !== false,
    interrupted: result.interrupted === true,
    refund: result.refund ?? null,
  })
  sendJson(res, 200, {
    ok: result.ok !== false,
    key,
    email: a.email,
    instanceId: result.instanceId ?? null,
    attempts: result.attempts ?? 0,
    interrupted: result.interrupted === true,
    refund: result.refund ?? null,
    error: result.error ?? null,
    account: runtimes.list().find((x: any) => x.key === key),
  })
}

/**
 * POST /api/accounts/:key/scheduling ---- 开/关该账号的调度.
 *
 * 关掉后该账号不进候选, 不被选号, 不 admit; 已买断的会话句柄保留不动
 * (关开关不是释放会话,那一小时照旧可用到自然过期).
 * 与[解除冷却]同权限:管理员才能改.
 * @param {string} key 账号 key
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} user 当前用户
 * @param {any} ctx 路由上下文
 * @returns {Promise<void>}
 */
async function setScheduling(
  key: any,
  req: IncomingMessage,
  res: ServerResponse,
  user: any,
  ctx: any,
) {
  const { runtimes, readJson } = ctx
  const a = runtimes.list().find((x: any) => x.key === key)
  if (!a) {
    sendJson(res, 404, { error: '账号不存在' })
    return
  }
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return
  }
  if (typeof body?.enabled !== 'boolean') {
    sendJson(res, 400, { error: 'enabled 必须是布尔值' })
    return
  }
  const enabled = runtimes.setSchedulingEnabled(key, body.enabled)
  logger.info('account scheduling switch changed via web console', {
    by: user.username,
    key,
    email: a.email,
    enabled,
  })
  sendJson(res, 200, {
    ok: true,
    key,
    email: a.email,
    schedulingEnabled: enabled,
    account: runtimes.list().find((x: any) => x.key === key),
  })
}

/**
 * accounts 单账号动作侧入口.
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
  const one = route.match(/^\/api\/accounts\/([^/]+)\/probe$/)
  if (one && method === 'POST') {
    await probeOne(decodeSegment(one[1]), res, ctx)
    return true
  }

  const session = route.match(/^\/api\/accounts\/([^/]+)\/session$/)
  if (session && method === 'POST') {
    await closeSession(decodeSegment(session[1]), req, res, user, ctx)
    return true
  }

  const scheduling = route.match(/^\/api\/accounts\/([^/]+)\/scheduling$/)
  if (scheduling && method === 'POST') {
    if (denyUnlessAdmin(user, res)) return true
    await setScheduling(decodeSegment(scheduling[1]), req, res, user, ctx)
    return true
  }

  const cooldown = route.match(/^\/api\/accounts\/([^/]+)\/cooldown\/clear$/)
  if (cooldown && method === 'POST') {
    if (denyUnlessAdmin(user, res)) return true
    ctx.runtimes.clearCooldown(decodeSegment(cooldown[1]))
    sendJson(res, 200, { ok: true })
    return true
  }
  return false
}
