/**
 * 唯一的路由分发器.
 *
 * 三张面各走各的入口: 健康检查 / 对外 LLM 面(/v1/*) / 控制台面(/api/* 由
 * 上游 dispatcher 分流). 这里只做"哪个路径交给谁", 不含业务逻辑.
 *
 * chatHandler 通过参数注入: 它与 handleChatCompletions 同址, 反过来 import 会成环.
 */

import { sendJson } from '../../util/http.ts'
import { authorize } from './auth.ts'
import { handleAccountsDelete, handleAccountsImport } from './accounts.ts'
import { handleModels, handleStatus } from './catalog.ts'
import { handleGenericPassthrough } from '../transport/passthrough.ts'

export async function handle(ctx: any, chatHandler: any, req: any, res: any) {
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  )
  const route = url.pathname
  const method = (req.method || 'GET').toUpperCase()

  if (method === 'GET' && (route === '/healthz' || route === '/health')) {
    sendJson(res, 200, { status: 'ok' })
    return
  }

  if (!authorize(ctx, req, res)) return

  if (method === 'GET' && route === '/v1/models') {
    await handleModels(ctx, res)
    return
  }

  if (method === 'GET' && route === '/v1/freebuff/status') {
    await handleStatus(ctx, res)
    return
  }

  if (method === 'GET' && route === '/v1/freebuff/accounts') {
    sendJson(res, 200, { object: 'list', data: ctx.runtimes.list() })
    return
  }

  if (method === 'POST' && route === '/v1/freebuff/accounts/import') {
    await handleAccountsImport(ctx, req, res)
    return
  }

  if (method === 'DELETE' && route === '/v1/freebuff/accounts') {
    await handleAccountsDelete(ctx, req, res)
    return
  }

  if (method === 'POST' && route === '/v1/freebuff/session/end') {
    await endAllSessions(ctx, res)
    return
  }

  // Chat completions 只走 CLI 通道(agent 接口: admit 会话 +
  // startAgentRun + /api/v1/chat/completions).
  if (method === 'POST' && route === '/v1/chat/completions') {
    await chatHandler(req, res)
    return
  }

  // /v1/responses 明确不支持(见 rejectResponses 的文件级说明). 方法不限: 任何方法
  // 落进下面的 /v1/* 兜底都会被透传给上游, 而这条路径在上游根本不存在.
  // 这一支必须留在 /v1/* 兜底之前: 否则请求会被透传到上游并换回 502 空体.
  if (route === '/v1/responses') {
    rejectResponses(res)
    return
  }

  // Auth-injected passthrough for other OpenAI-shaped /v1 routes only.
  // Chat completions are NOT handled here.
  if (route.startsWith('/v1/')) {
    await handleGenericPassthrough(ctx, req, res, url)
    return
  }

  sendJson(res, 404, {
    error: {
      message: `No route for ${method} ${route}. Public API is under /v1.`,
      type: 'invalid_request_error',
      code: 'not_found',
    },
  })
}

/**
 * /v1/responses 明确不支持 ---- 本仓无会话存储, 满足不了 previous_response_id 与
 * store:true 这类只发增量, 历史由服务端留的调用形态; 静默丢上下文比报错更难查.
 *
 * 必须由路由表显式拒绝, 而不是没有这一支: 去掉它路径会落进下面的 /v1/* 兜底,
 * 被原样透传到上游 /api/v1/responses, 上游无该端点 -> 404 被中间层崩成 502 空体.
 *
 * 见 .agents/notes/implemented/architecture/2026-10-05-responses-endpoint-explicitly-unsupported.md
 *
 * @param {object} res 响应对象
 * @returns {void} 无返回
 */
function rejectResponses(res: any) {
  sendJson(res, 501, {
    error: {
      message:
        '/v1/responses is not supported by this proxy. It is stateless and keeps no '
        + 'conversation store; send the full message history to /v1/chat/completions '
        + 'instead.',
      type: 'invalid_request_error',
      code: 'not_supported',
    },
  })
}

/**
 * 结束所有已缓存账号的上游会话(best-effort:单个失败不影响其余).
 *
 * 每个账号独立 try/catch 并把结果逐条回给调用方 ---- 静默吞掉失败会让
 * "点了结束但没结束"表现成"点了没反应".
 * @param {object} ctx 依赖集合(含 runtimes)
 * @param {object} res 响应对象
 * @returns {Promise<void>} 无返回
 */
async function endAllSessions(ctx: any, res: any) {
  const accounts = []
  for (const row of ctx.runtimes.list()) {
    try {
      const rt = ctx.runtimes.get(row.key)
      await rt.sessions.release()
      accounts.push({ key: row.key, email: row.email, ok: true })
    } catch (err) {
      accounts.push({
        key: row.key,
        email: row.email,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  sendJson(res, 200, { ok: true, accounts })
}
