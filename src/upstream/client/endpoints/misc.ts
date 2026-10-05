/**
 * 非会话端点:登录码/登录状态,agent run,裸透传,资源释放.
 *
 * 与 session.ts 一样,所有闭包依赖走显式 ctx(见 http.js 的说明).
 *
 * 从 src/upstream/client.ts 拆出(原 1499 行单文件).
 */
import { logger } from '../../../util/log.ts'
import { freebuffAuthHeaders } from '../../../auth-store.ts'
import { UpstreamError, safeText } from '../errors/index.ts'
import { apiFetch, fetchLoginUpstream } from '../http.ts'

/**
 * @typedef {import('./session.ts').SessionCtx & {
 *   loginBase: string,
 *   proxyRes: { kind: string, agent?: any, agents?: any[] },
 * }} EndpointCtx
 */

/**
 * 组装非会话端点.返回的方法直接挂在客户端对象上.
 *
 * @param {EndpointCtx} ctx 出站依赖
 * @returns {Record<string, Function>} 端点方法集合
 */
export function buildEndpoints(ctx: any): Record<string, Function> {
  return {
    ...buildLoginEndpoints(ctx),
    ...buildAgentRunEndpoints(ctx),
    ...buildMiscEndpoints(ctx),
  }
}

/** 登录状态轮询的参数. */
interface LoginStatusParams {
  fingerprintId: string
  fingerprintHash: string
  expiresAt: string
}

/**
 * 登录端点:一次性 code + 轮询状态.
 *
 * @param {EndpointCtx} ctx 出站依赖
 * @returns {Record<string, Function>} 登录端点方法
 */
function buildLoginEndpoints(ctx: any): Record<string, Function> {
  const { loginBase } = ctx
  return {
    /**
     * 发起 CLI 登录(拿一次性 code 供用户浏览器确认).
     *
     * @param {string} fingerprintId 本机指纹 id
     * @returns {Promise<any>} 上游登录码回执
     */
    async loginCode(fingerprintId: string) {
      // 用 apiFetch(带超时 + 代理池回落)而不是裸 fetchWithProxy:
      // freebuff.com 网络波动/被墙时裸 fetch 会永远挂起,轮询/弹窗
      // 无限堆积 socket,把整个服务拖死(前台表现为[系统崩溃,只能重启]).
      // 无代理部署(kind:'none')下 apiFetch 没有池内回落,靠
      // fetchLoginUpstream 补一次重试 -- 见 .agents/notes/implemented/
      // bug-fix/2026-10-03-login-transient-retry.md
      const res = await fetchLoginUpstream(
        ctx,
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

    /**
     * 轮询登录状态(用户确认后返回 token).
     *
     * @param {{ fingerprintId: string, fingerprintHash: string, expiresAt: string }} params 登录上下文
     * @returns {Promise<any>} 上游登录状态回执(未确认时 pending: true)
     */
    async loginStatus({ fingerprintId, fingerprintHash, expiresAt }: LoginStatusParams) {
      const qs = new URLSearchParams({ fingerprintId, fingerprintHash, expiresAt })
      // 同上:必须带超时.登录轮询每 4s 一轮,若 status 永远挂起(上游不可达),
      // 每轮都泄漏一个永不结束的 fetch/socket,服务最终被拖死.
      const res = await fetchLoginUpstream(
        ctx,
        `${loginBase}/api/auth/cli/status?${qs}`,
        { method: 'GET', includeAuth: false, timeoutMs: 15_000 },
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
  }
}

/**
 * agent run 端点:START 拿 runId / FINISH 收尾.
 *
 * @param {EndpointCtx} ctx 出站依赖
 * @returns {Record<string, Function>} agent-run 端点方法
 */
function buildAgentRunEndpoints(ctx: any): Record<string, Function> {
  const { token } = ctx
  return {
    /**
     * Register an agent run; returns server-issued runId required by chat/completions.
     *
     * @param {{ agentId: string, ancestorRunIds?: string[] }} params 运行参数
     * @returns {Promise<string>} 服务端签发的 runId
     * @throws {UpstreamError} 非 2xx 或回执缺 runId
     */
    async startAgentRun(params: { agentId: string, ancestorRunIds?: string[] }) {
      const res = await apiFetch(ctx, '/api/v1/agent-runs', {
        method: 'POST',
        headers: { ...freebuffAuthHeaders(token), 'content-type': 'application/json' },
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
     *
     * @param {{ runId: string, status?: string, errorMessage?: string }} params 结束参数
     * @returns {Promise<void>} 失败只记 warn,不抛
     */
    async finishAgentRun(params: { runId: string, status?: string, errorMessage?: string }) {
      try {
        await apiFetch(ctx, '/api/v1/agent-runs', {
          method: 'POST',
          headers: { ...freebuffAuthHeaders(token), 'content-type': 'application/json' },
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
  }
}

/**
 * 杂项端点:上游裸透传与出网资源释放.
 *
 * @param {EndpointCtx} ctx 出站依赖
 * @returns {Record<string, Function>} 杂项端点方法
 */
function buildMiscEndpoints(ctx: any): Record<string, Function> {
  const { token, proxyRes } = ctx
  return {
    /**
     * Low-level passthrough to upstream API path.
     *
     * @param {string} upstreamPath 例如 /api/v1/chat/completions
     * @param {{ method: string, headers?: Record<string,string>, body?: any,
     *   signal?: AbortSignal, timeoutMs?: number, catalogFetchOnly?: boolean }} init 请求参数
     * @returns {Promise<Response>} 上游响应
     */
    async raw(upstreamPath: string, init: any) {
      const headers = { ...(init.headers || {}), ...freebuffAuthHeaders(token) }
      return apiFetch(ctx, upstreamPath, {
        method: init.method,
        headers,
        body: init.body,
        signal: init.signal,
        timeoutMs: init.timeoutMs,
        includeAuth: false,
        // chat 走这里:官方 chat 只带 catalog-fetch,不带 catalog-protocol
        catalogFetchOnly: init.catalogFetchOnly === true,
      })
    },

    /**
     * 释放本 client 持有的出网资源(undici ProxyAgent / EnvHttpProxyAgent).
     *
     * 必须显式调用:每个账号 runtime 在构造时都会 new ProxyAgent(...),
     * 而 agent 自带 keep-alive 连接池.更新凭证,导入账号,切换代理池都会
     * 重建 runtime 并丢弃旧的 -- 若旧 agent 不被 close,它的 socket 会一直
     * 挂着,随"更新账号"的次数单调累积(实测每轮凭证更新留下 1 个常驻
     * socket),表现为运行越久越慢,连接越难建立.
     *
     * @returns {Promise<void>} 全部 agent 关闭完成
     */
    async close() {
      const agents =
        proxyRes.kind === 'pool' ? proxyRes.agents : proxyRes.agent ? [proxyRes.agent] : []
      await Promise.all(
        agents.map(async (a: any) => {
          try {
            await a?.close?.()
          } catch {
            // 已关闭 / 正在关闭:忽略
          }
        }),
      )
    },
  }
}
