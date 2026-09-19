import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { loadConfig } from '../src/config.js'
import { AccountRuntimes } from '../src/app-context.js'
import { SessionHandleStore } from '../src/session-handles.js'
import { startServer } from '../src/server.js'
import { SessionManager } from '../src/session-manager.js'
import { requestSlotStats } from '../src/proxy.js'
import { configureLogger } from '../src/util/log.js'
import {
  requireModelId,
  isFreeModel,
  buildModelsListResponse,
  agentIdForModel,
  agentFallbackForModel,
  CATALOG_CACHE_FILENAME,
  DEFAULT_CATALOG_CACHE_PATH,
  catalogCachePath,
  configureCatalogCache,
  applyCatalogCache,
  mergeCatalogWithBuiltin,
} from '../src/model.js'
import {
  saveAccountUser,
  listAccounts,
  readAccountUser,
  invalidCredentialFiles,
} from '../src/auth-store.js'
import {
  ensureFreebuffSystemMessages,
  ensureFreebuffToolSignature,
  normalizeReasoningFields,
  normalizeOutputBudget,
  FREEBUFF_SIGNATURE_TOOL_DEFINITIONS,
  FREEBUFF_SIGNATURE_TOOL_NAMES,
  FREEBUFF_SIGNATURE_TOOL_NAME,
  FREEBUFF_SYSTEM_OPENING,
} from '../src/free-mode.js'
import {
  chooseHermesDelegateAlias,
  restoreHermesDelegateInResponse,
  rewriteHermesDelegateForUpstream,
  rewriteHermesDelegateSseLine,
} from '../src/tool-alias.js'
import {
  detectForeignClient,
  isGenuineSignatureTool,
} from '../src/upstream/foreign-client-signals.js'
import { SettingsStore } from '../src/web/settings-store.js'
import { ModelStore } from '../src/web/model-store.js'
import { UserStore } from '../src/web/user-store.js'
import { ProxyStore } from '../src/web/proxy-store.js'
import { WebSessionStore } from '../src/web/session-store.js'
import {
  dataFileAudit,
  invalidDataFiles,
  dirtyDataFiles,
  quarantineFile,
  ensureObjectEntries,
} from '../src/util/json-store.js'
import { LoginFlowManager } from '../src/web/login-flows.js'
import {
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
} from '../src/upstream/client.js'

configureLogger({ level: 'error' })

// --- unit: Hermes delegate_task compatibility alias (issue #17) ---
{
  const clientBody = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'delegate_task',
          description: 'delegate work',
          parameters: {
            type: 'object',
            properties: { prompt: { type: 'string' } },
          },
        },
      },
    ],
    tool_choice: {
      type: 'function',
      function: { name: 'delegate_task' },
    },
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'delegate_task', arguments: '{"prompt":"x"}' },
          },
        ],
      },
      { role: 'tool', name: 'delegate_task', tool_call_id: 'call-1', content: 'ok' },
    ],
  }
  const alias = chooseHermesDelegateAlias(clientBody.tools)
  assert.equal(alias, 'spawn_subagent')
  const upstreamBody = rewriteHermesDelegateForUpstream(clientBody, alias)
  assert.equal(upstreamBody.tools[0].function.name, alias)
  assert.equal(upstreamBody.tool_choice.function.name, alias)
  assert.equal(upstreamBody.messages[0].tool_calls[0].function.name, alias)
  assert.equal(upstreamBody.messages[1].name, alias)
  assert.equal(clientBody.tools[0].function.name, 'delegate_task', '不得修改客户端原对象')

  const signedTools = ensureFreebuffToolSignature(upstreamBody.tools, true)
  const verdict = detectForeignClient({ ...upstreamBody, tools: signedTools }, true)
  assert.notEqual(verdict.signal, 'foreign_tool_names')
  assert.deepEqual(verdict.foreignToolNames, [])

  const restored = restoreHermesDelegateInResponse(
    {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: alias, arguments: '{"prompt":"x"}' } },
            ],
          },
          delta: {
            tool_calls: [{ function: { name: alias, arguments: '' } }],
          },
        },
      ],
    },
    alias,
  )
  assert.equal(restored.choices[0].message.tool_calls[0].function.name, 'delegate_task')
  assert.equal(restored.choices[0].delta.tool_calls[0].function.name, 'delegate_task')

  const sse = rewriteHermesDelegateSseLine(
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"spawn_subagent","arguments":""}}]}}]}\n',
    alias,
  )
  assert.match(sse, /"name":"delegate_task"/)

  // 已有同名工具时选择无冲突别名，不能覆盖客户端自己的 spawn_subagent。
  assert.equal(
    chooseHermesDelegateAlias([
      { type: 'function', function: { name: 'delegate_task' } },
      { type: 'function', function: { name: 'spawn_subagent' } },
    ]),
    'spawn_subagent_2',
  )
}

const originalFetch = globalThis.fetch
let calls = []
/** @type {'ok' | 'gate_once' | 'rate_limit_a' | 'rate_limit_completion' | 'err_500_a' | 'capacity_once' | 'capacity_all' | 'run_500_a' | 'run_403_a' | 'network_err_a' | 'gate_twice_a' | 'hold_once' | 'legacy_luna_once' | 'luna_base2_retired'} */
let mockMode = 'ok'
let sessionPosts = 0
let sessionDeletes = 0
let completionAttempts = 0
/** 历次 startAgentRun 使用的 agentId（agent 兜底/退役验证用）。 */
let startAgentCalls = []
/** 会话有效期（毫秒）：近过期/重连测试用 */
let sessionExpiryMs = 3600_000
/**
 * 模拟上游 Freebucks 计量块（2026-09 改版）：设成对象后，每个 session 响应
 * （POST/GET/DELETE）都会带上它；null = 老上游（无计量，不拦截）。
 * @type {null | { balance: number, daily?: any, wallet?: any, prices?: Record<string, number>, quotaExempt?: boolean, planId?: string | null }}
 */
let mockFreebucks = null

/** 每次 DELETE 退还给调用方的 Freebucks（模拟"提前结束退款"）。 */
let mockRefund = 1.5
/**
 * 上游"结算未完成"标志 (vendor af898dc freebucksRefundPending)。true 时 DELETE
 * 回执只带 pending、**不带** freebucksRefund——2026-09 实测提前结束的会话会
 * 持续挂起数分钟。用于验证"挂起 ≠ 退款 0"。
 */
let mockRefundPending = false
/** DELETE 收到过的 x-freebuff-instance-id（回归：不带会被上游 400）。 */
let deleteInstanceIds = []
/** 还需要失败几次 DELETE（验证"失败不丢句柄"）。0 = 全部成功。 */
let deleteFailuresLeft = 0
/** 模拟上游 DELETE 缺 instance id 时返回 400 instance_required。 */
let requireDeleteInstance = true
/** hold_once 模式：被挂起的流式响应控制器（等 releaseHoldStreams 放行） */
let holdStreamControllers = []

/** 放行所有被挂起的流式响应（写入 [DONE] 并关闭）。 */
function releaseHoldStreams() {
  const enc = new TextEncoder()
  for (const controller of holdStreamControllers.splice(0)) {
    try {
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    } catch {
      // ignore
    }
  }
}

/** 轮询等待条件成立（默认 2s 超时，超时抛错）。 */
async function waitFor(desc, fn, timeoutMs = 2_000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  assert.fail(`waitFor 超时: ${desc}`)
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.includes('127.0.0.1') || u.includes('localhost')) {
    return originalFetch(url, init)
  }
  const method = (init.method || 'GET').toUpperCase()
  const headers = init.headers || {}
  calls.push({ url: u, method, headers, body: init.body })

  if (u.includes('/api/v1/me')) {
    return jsonRes({ id: 'u1', email: 'a@b.c' })
  }
  // 官方 POST 走 .../session/admission（GET/DELETE 走 .../session）。
  if (u.includes('/api/v1/freebuff/session/admission') && method === 'POST') {
    sessionPosts++
    const model =
      headers['x-freebuff-model'] ||
      headers['X-Freebuff-Model'] ||
      'deepseek/deepseek-v4-flash'
    // Multi-account: token-a is rate-limited on admit
    const auth =
      headers.Authorization ||
      headers.authorization ||
      headers['x-codebuff-api-key'] ||
      ''
    if (mockMode === 'rate_limit_a' && String(auth).includes('token-a')) {
      return jsonRes(
        {
          status: 'rate_limited',
          message: 'quota',
          retryAfterMs: 60_000,
        },
        429,
      )
    }
    const rateLimit = {
      model,
      entitlementBreakdown: { base: 6, referral: 0, streak: 0 },
      limit: 6,
      period: 'pacific_day',
      resetTimeZone: 'America/Los_Angeles',
      resetAt: '2026-08-09T07:00:00.000Z',
      windowHours: 24,
      recentCount: 1,
    }
    return jsonRes({
      status: 'active',
      instanceId: `inst-${sessionPosts}`,
      model,
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + sessionExpiryMs).toISOString(),
      remainingMs: sessionExpiryMs,
      accessTier: 'full',
      rateLimit,
      rateLimitsByModel: { [model]: rateLimit },
      ...(mockFreebucks ? { freebucks: mockFreebucks } : {}),
    })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'GET') {
    return jsonRes({
      status: 'none',
      accessTier: 'full',
      ...(mockFreebucks ? { freebucks: mockFreebucks } : {}),
    })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'DELETE') {
    sessionDeletes++
    if (deleteFailuresLeft > 0) {
      deleteFailuresLeft--
      return jsonRes({ error: 'internal_error' }, 500)
    }
    const instanceId =
      headers['x-freebuff-instance-id'] ||
      headers['X-Freebuff-Instance-Id'] ||
      ''
    deleteInstanceIds.push(instanceId)
    // 上游 2026-09 行为：DELETE 不带 x-freebuff-instance-id 会 400
    // instance_required，会话删不掉、退款也拿不到。
    if (requireDeleteInstance && !instanceId) {
      return jsonRes({ error: 'instance_required' }, 400)
    }
    return jsonRes({
      status: 'ended',
      ...(mockRefundPending ? { freebucksRefundPending: true } : {}),
      ...(mockRefundPending ? {} : { freebucksRefund: mockRefund }),
      ...(mockFreebucks ? { freebucks: mockFreebucks } : {}),
    })
  }
  if (u.includes('/api/v1/agent-runs') && method === 'POST') {
    const body = JSON.parse(init.body || '{}')
    if (body.action === 'START') {
      const runAuth =
        headers.Authorization ||
        headers.authorization ||
        headers['x-codebuff-api-key'] ||
        ''
      if (mockMode === 'run_500_a' && String(runAuth).includes('token-a')) {
        return jsonRes({ error: 'internal_error', message: 'run boom' }, 500)
      }
      // startAgentRun 以 403 拒绝该账号（非 banned/ip_capped 等账号级封禁 code，
      // 只是该账号+agent 组合不可用）：必须冷却当前账号并换下一个，而不是
      // 把 start_agent_run_failed 直接甩给用户（回归：403 曾因不在换号条件内而
      // 不换号、第一次尝试就报错给用户）。
      if (mockMode === 'run_403_a' && String(runAuth).includes('token-a')) {
        return jsonRes(
          {
            error: 'start_agent_run_failed',
            message: 'This account/agent combination cannot start a run.',
          },
          403,
        )
      }
      // agent 兜底：主 agent（base2）被拒，base3 孪生成功
      if (mockMode === 'agent_fallback' && body.agentId === 'base2-free-deepseek-flash') {
        return jsonRes(
          { error: 'free_mode_invalid_agent_model', message: 'Free mode is only available for specific agent and model combinations.' },
          403,
        )
      }
      // 退役 Luna agent：chat 阶段 free_mode_legacy_luna_agent 场景——base2
      // startAgentRun 能成功（runId 正常返回），但 chat 转发后上游说
      // "此对话用了退役 agent"。重试必须切 base3。
      if (mockMode === 'luna_base2_retired' && body.agentId === 'base2-free-luna') {
        startAgentCalls.push(body.agentId)
        return jsonRes({ runId: '00000000-0000-4000-8000-000000000002' })
      }
      startAgentCalls.push(body.agentId)
      return jsonRes({ runId: '00000000-0000-4000-8000-000000000001' })
    }
    if (body.action === 'FINISH') {
      return jsonRes({ ok: true })
    }
    return jsonRes({ error: 'bad action' }, 400)
  }
  if (u.includes('/api/v1/chat/completions')) {
    const body = JSON.parse(init.body)
    assert.match(body.model, /^[a-z0-9-]+\/[a-z0-9.-]+$/i)
    if (
      mockMode === 'legacy_luna_once' &&
      body.model === 'openai/gpt-5.6-luna' &&
      completionAttempts === 0
    ) {
      completionAttempts++
      return jsonRes(
        {
          error: 'free_mode_legacy_luna_agent',
          message:
            'This conversation uses a retired Luna agent. Update Freebuff if needed, then start a new conversation.',
        },
        403,
      )
    }
    // luna_base2_retired：base2 的 runId 指向退役 agent，chat 第一次必撞
    // free_mode_legacy_luna_agent；重试（切 base3 + 新 runId）后成功。
    if (
      mockMode === 'luna_base2_retired' &&
      body.model === 'openai/gpt-5.6-luna' &&
      completionAttempts === 0
    ) {
      completionAttempts++
      return jsonRes(
        {
          error: 'free_mode_legacy_luna_agent',
          message:
            'This conversation uses a retired Luna agent. Update Freebuff if needed, then start a new conversation.',
        },
        403,
      )
    }
    assert.equal(body.codebuff_metadata.cost_mode, 'free')
    assert.ok(body.codebuff_metadata.freebuff_instance_id)
    assert.equal(
      body.codebuff_metadata.run_id,
      '00000000-0000-4000-8000-000000000001',
    )
    assert.ok(Array.isArray(body.messages))
    assert.equal(body.messages[0].role, 'system')
    // base3 世代 root（base3-free-*）用 base3 规范开场（对齐 trefeon PR #207）：
    // "a base3 run must open with the BASE3 canonical identity, not base2's"。
    // luna 系在本项目强制 base3，故其请求以 base3 开场是正确行为。
    // chat 请求 body 里没有 agentId 字段（agentId 只在 agent-runs START），
    // 这里按模型推断：luna 系 = base3 run。
    const isBase3Run = /luna/.test(body.model)
    const msg0 = String(body.messages[0].content)
    assert.ok(
      isBase3Run
        ? msg0.startsWith('You are Buffy, the coding agent behind Codebuff.')
        : msg0.startsWith(FREEBUFF_SYSTEM_OPENING),
      `messages[0] 应以 ${isBase3Run ? 'base3' : 'base2'} 规范开场, got ${msg0.slice(0, 80)}`,
    )
    const userMsg = body.messages.find((m) => m.role === 'user')
    assert.ok(userMsg && String(userMsg.content).length > 0)
    assert.ok(headers.Authorization || headers.authorization)
    assert.ok(headers['x-codebuff-api-key'] || headers['X-Codebuff-Api-Key'])

    // 输出预算治理（freebuff2api-wokers#8）：客户端小 max_tokens 会把思考链
    // （reasoning token 计入预算）掐断——转发上游前必须抬到 floor 并统一为
    // max_completion_tokens 单字段，绝不允许小上限原样透传。
    assert.equal(body.max_tokens, undefined)
    assert.equal(body.max_output_tokens, undefined)
    assert.ok(
      body.max_completion_tokens >= 65536,
      `转发上游的输出预算应 >= 65536, got ${body.max_completion_tokens}`,
    )

    completionAttempts++
    // stall_zero: 200 OK with a streaming body that never sends any data nor closes
    // （只对 token-spa 的第一次尝试生效，验证换号重试）
    const stallAuth =
      headers.Authorization ||
      headers.authorization ||
      headers['x-codebuff-api-key'] ||
      ''
    if (
      mockMode === 'stall_zero' &&
      completionAttempts === 1 &&
      String(stallAuth).includes('token-sa')
    ) {
      return new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    // stall_partial: enqueue one chunk then stall forever
    if (
      mockMode === 'stall_partial' &&
      completionAttempts === 1 &&
      String(stallAuth).includes('token-sa')
    ) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n'
            ))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    // bigstall: 一次性下发大块数据后卡死——用于下游背压（客户端不读）场景，
    // 大块写会让下游 socket 缓冲区填满 → write() 返回 false → 等待 drain
    if (mockMode === 'bigstall') {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: ' + 'x'.repeat(4 * 1024 * 1024) + '\n\n',
              ),
            )
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    // First completion fails with recoverable gate; second succeeds.
    if (mockMode === 'gate_once' && completionAttempts === 1) {
      return jsonRes(
        { error: 'session_superseded', message: 'taken over' },
        409,
      )
    }
    // Account a is free-mode rate limited at the completions layer (not admit).
    const compAuth =
      headers.Authorization ||
      headers.authorization ||
      headers['x-codebuff-api-key'] ||
      ''
    if (
      mockMode === 'rate_limit_completion' &&
      String(compAuth).includes('token-a')
    ) {
      return jsonRes(
        {
          error: 'free_mode_rate_limited',
          message:
            'Free mode rate limit exceeded (30 minutes limit). Try again in 1 minute.',
        },
        429,
        { 'retry-after': '60' },
      )
    }
    // 上游 tool-schema 指纹拒：带 tools 一律 404 "No endpoints found"
    // （2026-09-18 线上实测原样复刻）。去掉 tools 后放行 → 验证剥离重试。
    if (mockMode === 'tool_schema_reject' && Array.isArray(body.tools)) {
      return jsonRes(
        {
          error: {
            message: 'No endpoints found for ' + body.model + '.',
            code: 404,
            type: null,
            param: null,
          },
        },
        404,
      )
    }
    // 账号封禁：403 {"error":"account_suspended"}（error 是**字符串**）
    if (mockMode === 'suspended_a' && String(compAuthOf(headers)).includes('token-a')) {
      return jsonRes(
        {
          error: 'account_suspended',
          message:
            'Your account has been suspended for accessing Freebuff with a third-party client or proxy.',
        },
        403,
      )
    }
    // 所有账号的 chat 都 500（账号级故障 → 连续换号），用于验证新会话预算
    if (mockMode === 'err_500_all') {
      return jsonRes({ error: 'internal_error', message: 'boom' }, 500)
    }
    if (mockMode === 'err_500_a' && String(compAuth).includes('token-a')) {
      return jsonRes({ error: 'internal_error', message: 'boom' }, 500)
    }
    // free_mode_capacity_deferred：瞬时容量排队，换号重试不冷却
    if (mockMode === 'capacity_once' && completionAttempts === 1) {
      return jsonRes(
        {
          error: 'free_mode_capacity_deferred',
          message:
            'Free mode is briefly at capacity; your request will be retried automatically.',
        },
        429,
      )
    }
    if (mockMode === 'capacity_all') {
      return jsonRes(
        {
          error: 'free_mode_capacity_deferred',
          message:
            'Free mode is briefly at capacity; your request will be retried automatically.',
        },
        429,
      )
    }
    // 同账号连续 gate 失败（session_superseded ×2）→ 升级换号
    if (
      mockMode === 'gate_twice_a' &&
      String(compAuth).includes('token-a') &&
      completionAttempts <= 2
    ) {
      return jsonRes({ error: 'session_superseded', message: 'taken over' }, 409)
    }
    // 网络层错误（fetch 抛异常）→ 换号重试
    if (mockMode === 'network_err_a' && String(compAuth).includes('token-a')) {
      throw new Error('ECONNRESET: socket hang up')
    }
    // hold_once：第一次流式响应保持打开（先吐一个 chunk），
    // 直到 releaseHoldStreams() 放行——用于模拟"正在传输的长流"。
    if (mockMode === 'hold_once' && completionAttempts === 1 && body.stream) {
      return new Response(
        new ReadableStream({
          start(controller) {
            holdStreamControllers.push(controller)
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n',
              ),
            )
          },
          cancel() {
            const i = holdStreamControllers.indexOf(controller)
            if (i >= 0) holdStreamControllers.splice(i, 1)
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }

    if (body.stream) {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(
            enc.encode(
              'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n',
            ),
          )
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return jsonRes({
      id: 'c1',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
    })
  }
  return jsonRes({ error: 'unexpected ' + u }, 500)
}

/** 从请求头取上游认证 token（多账号测试区分 token-a / token-b 用）。 */
function compAuthOf(headers = {}) {
  return (
    headers.Authorization ||
    headers.authorization ||
    headers['x-codebuff-api-key'] ||
    ''
  )
}

function jsonRes(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

// --- unit: free-mode helpers ---
{
  const msgs = ensureFreebuffSystemMessages([
    { role: 'user', content: 'hi' },
  ])
  assert.equal(msgs[0].role, 'system')
  assert.ok(msgs[0].content.startsWith(FREEBUFF_SYSTEM_OPENING))

  const already = ensureFreebuffSystemMessages([
    { role: 'system', content: `${FREEBUFF_SYSTEM_OPENING}\nextra` },
    { role: 'user', content: 'x' },
  ])
  assert.equal(already[0].content, `${FREEBUFF_SYSTEM_OPENING}\nextra`)

  const prefixed = ensureFreebuffSystemMessages([
    { role: 'system', content: 'Be brief.' },
  ])
  assert.ok(prefixed[0].content.startsWith(FREEBUFF_SYSTEM_OPENING))
  assert.match(prefixed[0].content, /Be brief/)

  const r = normalizeReasoningFields({
    reasoning_effort: 'max',
    reasoning: { effort: 'low', other: 1 },
  })
  assert.equal(r.reasoning_effort, undefined)
  // 官方 efforts 表（freebuff free-agents/reasoning-effort）：flash=[low,high,max]、
  // pro=[high,max]——max 是合法档位，保留以支持最深思考（不降档）
  assert.equal(r.reasoning.effort, 'max')
  assert.equal(r.reasoning.other, 1)

  const r2 = normalizeReasoningFields({ reasoning_effort: 'high' })
  assert.equal(r2.reasoning.effort, 'high')

  // 输出预算治理（freebuff2api-wokers#8：DS4 思考链稍长即截断）：
  // reasoning token 计入 max_tokens 预算，客户端偏小上限会把思考链掐断
  // （finish_reason=length）。转发上游前抬到 floor，统一为 max_completion_tokens。
  const b1 = normalizeOutputBudget({ max_tokens: 8192 })
  assert.equal(b1.max_tokens, undefined)
  assert.equal(b1.max_completion_tokens, 65536)

  const b2 = normalizeOutputBudget({ max_completion_tokens: 4096, max_tokens: 1000 })
  assert.equal(b2.max_tokens, undefined)
  assert.equal(b2.max_completion_tokens, 65536)

  // 客户端上限高于 floor → 保留客户端意图（不降档）
  const b3 = normalizeOutputBudget({ max_tokens: 131072 })
  assert.equal(b3.max_completion_tokens, 131072)

  // 未设上限 → 补 floor（上游默认若不设可能同样偏小）
  const b4 = normalizeOutputBudget({ model: 'x' })
  assert.equal(b4.max_completion_tokens, 65536)
  assert.equal(b4.model, 'x')

  // max_output_tokens（Responses/部分 SDK 字段）同样计入预算
  const b6 = normalizeOutputBudget({ max_output_tokens: 2048 })
  assert.equal(b6.max_output_tokens, undefined)
  assert.equal(b6.max_completion_tokens, 65536)

  // 非法/非数值上限 → 兜底 floor
  const b5 = normalizeOutputBudget({ max_tokens: 'abc', max_completion_tokens: -5 })
  assert.equal(b5.max_completion_tokens, 65536)

  const originalTools = [
    { type: 'function', function: { name: 'web_search' } },
  ]
  const signedTools = ensureFreebuffToolSignature(originalTools, true)
  assert.equal(originalTools.length, 1)
  // 注入的是**官方真签名工具**：主签名（带参数、走 schema 子集）+ 自定义名兜底。
  assert.equal(signedTools.length, 1 + FREEBUFF_SIGNATURE_TOOL_NAMES.length)
  assert.ok(signedTools[1].function.name === FREEBUFF_SIGNATURE_TOOL_NAME)
  // 主签名工具必须带**非空** schema —— 上游判据要求签名工具「名字 + 真实参数」双真，
  // 零参数工具永远不算签名（旧实现注入空心 end_turn 正是被上游点名的洗白形态）。
  assert.ok(
    signedTools[1].function.parameters &&
      Object.keys(signedTools[1].function.parameters.properties || {}).length > 0,
    '主签名工具必须带非空参数 schema',
  )
  // 每个注入的工具都必须被上游判据认可为「货真价实」，否则等于没注入。
  for (const def of FREEBUFF_SIGNATURE_TOOL_DEFINITIONS) {
    assert.ok(
      isGenuineSignatureTool({
        name: def.function.name,
        parameters: def.function.parameters,
      }),
      '注入的签名工具必须通过上游 isGenuineSignatureTool：' + def.function.name,
    )
    assert.ok(
      FREEBUFF_SIGNATURE_TOOL_NAMES.includes(def.function.name),
      '注入的工具名必须在官方签名名集内：' + def.function.name,
    )
  }
  assert.equal(ensureFreebuffToolSignature(originalTools, false), originalTools)
  assert.deepEqual(ensureFreebuffToolSignature([], true), [])
  assert.equal(
    ensureFreebuffToolSignature(signedTools, true),
    signedTools,
  )
  // 只带其中一个签名工具时，应把缺的那个补上（两个都带才最稳）。
  const half = [originalTools[0], FREEBUFF_SIGNATURE_TOOL_DEFINITIONS[0]]
  assert.equal(
    ensureFreebuffToolSignature(half, true).length,
    1 + FREEBUFF_SIGNATURE_TOOL_NAMES.length,
  )
}

// --- unit: gate helpers ---
{
  assert.equal(
    extractGateError({ error: 'session_superseded' }, 409),
    'session_superseded',
  )
  assert.equal(isSessionRecoverableGate('session_superseded'), true)
  assert.equal(isSessionRecoverableGate('session_expired'), true)
  assert.equal(
    extractGateError({ error: 'free_mode_legacy_luna_agent' }, 403),
    'free_mode_legacy_luna_agent',
  )
  assert.equal(isSessionRecoverableGate('free_mode_legacy_luna_agent'), true)
  assert.equal(isSessionRecoverableGate('nope'), false)

  // account-level rate-limit codes (chat completions 429) → switch account
  assert.equal(
    extractRateLimitError({ error: 'free_mode_rate_limited' }),
    'free_mode_rate_limited',
  )
  assert.equal(
    extractRateLimitError({ error: { code: 'rate_limited' } }),
    'rate_limited',
  )
  assert.equal(extractRateLimitError({ code: 'spend_limited' }), 'spend_limited')
  assert.equal(extractRateLimitError({ status: 'ip_capped' }), 'ip_capped')
  assert.equal(extractRateLimitError({ error: 'session_superseded' }), null)
  assert.equal(extractRateLimitError({ error: 'free_mode_cli_required' }), null)
  assert.equal(extractRateLimitError(null), null)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-'))
saveAccountUser(tmpDir, {
  id: 'u1',
  email: 'smoke@example.com',
  name: 'Smoke',
  authToken: 'token-smoke-1',
})

const config = loadConfig()
config.server.host = '127.0.0.1'
config.server.port = 0
config.server.apiKeys = ['sk-test']
config.upstream.credentialsDir = tmpDir
config.session.pollIntervalSec = 3600
config.limits.maxConcurrentRequests = 2

const runtimes = new AccountRuntimes(config)
const settingsStore = new SettingsStore(path.join(tmpDir, 'settings.json'))
const modelStore = new ModelStore(path.join(tmpDir, 'custom-models.json'))
const server = await startServer({
  config,
  runtimes,
  ...(() => {
    const rt = runtimes.getAny()
    return {
      authToken: rt.authToken,
      authSource: rt.source,
      authEmail: rt.email,
      upstream: rt.upstream,
      sessions: rt.sessions,
    }
  })(),
  settingsStore,
  modelStore,
})
const port = server.address().port
const base = `http://127.0.0.1:${port}`

function chat(body, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

// model required
{
  const res = await chat({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(res.status, 400)
  const j = await res.json()
  assert.equal(j.error.code, 'model_required')
}

// happy path non-stream
{
  calls = []
  sessionPosts = 0
  completionAttempts = 0
  mockMode = 'ok'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    temperature: 0.2,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  const j = await res.json()
  assert.equal(j.choices[0].message.content, 'hi')
  assert.ok(
    calls.some((c) => c.url.includes('/freebuff/session') && c.method === 'POST'),
  )
  assert.ok(calls.some((c) => c.url.includes('/chat/completions')))
}


// tool-schema rejection: 上游以 404 "No endpoints found" 拒掉带工具的请求时，
// 代理必须**去掉 tools 再发一次**，而不是把 404 透传给下游。
// 背景（2026-09-18 一手实测）：上游对 tools 做 tool-schema 指纹比对，任何非官方
// 工具集一律 404（字面却说"模型不存在"）；下游 Responses 桥接层会把它崩成
// Cloudflare 纯文本 502 → 客户端 SDK 报 "502 status code (no body)"，
// 表现就是"所有模型全部空响应"。
{
  calls = []
  completionAttempts = 0
  mockMode = 'tool_schema_reject'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'run_code',
          description: 'Execute code.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  })
  assert.equal(res.status, 200, await res.clone().text())
  const j = await res.json()
  assert.equal(j.choices[0].message.content, 'hi')
  // 必须恰好两次 chat 尝试：第一次带 tools 被拒，第二次不带 tools 成功。
  const chatCalls = calls.filter((c) => c.url.includes('/chat/completions'))
  assert.equal(chatCalls.length, 2, '应重试恰好一次')
  const first = JSON.parse(chatCalls[0].body)
  const second = JSON.parse(chatCalls[1].body)
  // 第一次带 tools（原工具 + 签名工具 end_turn，签名开关默认开）。
  assert.ok(Array.isArray(first.tools), '第一次应带 tools')
  assert.ok(
    first.tools.some((t) => t.function && t.function.name === 'run_code'),
    '第一次应保留客户端原始工具',
  )
  assert.equal(second.tools, undefined, '第二次必须已剥离 tools')
  assert.equal(second.tool_choice, undefined)
  assert.equal(res.headers.get('x-freebuff-proxy-tools-stripped'), '1')
}

// 不带 tools 的请求遇到同样 404 时**不得**重试（没有工具可去），原样返回 404。
{
  calls = []
  completionAttempts = 0
  mockMode = 'tool_schema_reject'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, '无 tools 时 mock 不触发拒绝，正常 200')
  assert.equal(calls.filter((c) => c.url.includes('/chat/completions')).length, 1)
}

// 指纹对齐：chat 请求必须与官方 CLI 的形态一致。
// 依据（全部静态提取自官方 freebuff@0.0.178 二进制，见
// src/upstream/official-fingerprint.js）：
//   chat UA = ai-sdk/openai-compatible/<真版本>/codebuff（旧实现硬编码 1.0.0）；
//   POST 准入走 .../session/admission，不是 .../session。
// 用独立全新账号目录起服务：热 session 复用不会发 POST，断言不到准入形状。
{
  const fpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-fp-'))
  saveAccountUser(fpDir, { id: 'fp', email: 'fp@example.com', authToken: 'token-fp' })
  const fpConfig = loadConfig()
  fpConfig.server.host = '127.0.0.1'
  fpConfig.server.port = 0
  fpConfig.server.apiKeys = ['sk-test']
  fpConfig.upstream.credentialsDir = fpDir
  fpConfig.session.pollIntervalSec = 3600
  const fpRuntimes = new AccountRuntimes(fpConfig)
  const fpServer = await startServer({
    config: fpConfig,
    runtimes: fpRuntimes,
    ...(() => {
      const rt = fpRuntimes.getAny()
      return { authToken: rt.authToken, authSource: rt.source, authEmail: rt.email, upstream: rt.upstream, sessions: rt.sessions }
    })(),
  })
  const fpPort = fpServer.address().port
  calls = []
  sessionPosts = 0
  completionAttempts = 0
  mockMode = 'ok'
  const res = await fetch('http://127.0.0.1:' + fpPort + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  const chatCall = calls.find((c) => c.url.includes('/chat/completions'))
  assert.ok(chatCall, '应发出 chat 请求')
  const ua = chatCall.headers['user-agent'] || chatCall.headers['User-Agent']
  assert.ok(ua, 'chat 必须带 user-agent')
  assert.match(ua, /^ai-sdk\/openai-compatible\/\d+\.\d+\.\d+\/codebuff$/, 'UA 必须是官方 ai-sdk 形状 + 真实版本号, got ' + ua)
  assert.ok(!ua.includes('/1.0.0/'), 'UA 不得再是硬编码的 1.0.0（与真 CLI 版本不符）')
  // 已知偏差（未删）：官方 chat 只带 Authorization + user-agent，本代理仍带
  // x-codebuff-api-key —— raw() 统一注入 freebuffAuthHeaders，而本项目 token 由网页
  // 登录签发，auth-store 记录「只带 Bearer 会 401」。删它有打死全部认证的风险，
  // 在未验证前不动。这里如实断言当前确实带了，把偏差钉在测试里可见。
  assert.ok(chatCall.headers['x-codebuff-api-key'], 'chat 当前仍带 x-codebuff-api-key（已知未对齐，见 fingerprint note）')
  assert.ok(String(chatCall.headers.Authorization || chatCall.headers.authorization || '').startsWith('Bearer '), 'chat 必须带 Bearer Authorization')
  const admitCall = calls.find((c) => c.url.includes('/api/v1/freebuff/session') && c.method === 'POST')
  assert.ok(admitCall, '应发出准入请求')
  assert.ok(admitCall.url.endsWith('/api/v1/freebuff/session/admission'), 'POST 准入端点应为 .../session/admission, got ' + admitCall.url)
  assert.equal(admitCall.headers['x-freebuff-model'], 'deepseek/deepseek-v4-flash')
  assert.equal(admitCall.headers['x-freebuff-wallet-spend-limit'], '0')
  assert.equal(admitCall.headers['x-freebuff-first-tab-discount'], '0')
  assert.ok(admitCall.headers['x-fb-timezone'], '准入请求应带本机时区')
  await fpRuntimes.shutdown()
  fpServer.close()
  fs.rmSync(fpDir, { recursive: true, force: true })
  mockMode = 'ok'
}
// tool signature compatibility: default on, hot-disable without restart
{
  calls = []
  completionAttempts = 0
  const tools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        parameters: { type: 'object', properties: {} },
      },
    },
  ]
  const enabledRes = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
    tools,
  })
  assert.equal(enabledRes.status, 200, await enabledRes.clone().text())
  const enabledCall = calls.find((c) => c.url.includes('/chat/completions'))
  const enabledBody = JSON.parse(enabledCall.body)
  // 转发上游的工具集 = 客户端原工具 + 官方真签名工具（顺序：原工具在前）。
  assert.deepEqual(
    enabledBody.tools.map((tool) => tool.function.name),
    ['web_search', ...FREEBUFF_SIGNATURE_TOOL_NAMES],
  )
  // 决定性断言：这**整个工具集**送进上游判据必须判「自己人」（signal === null）。
  // 旧实现注入空心 end_turn，上游判 foreign_toolset 并把请求降级到
  // inclusionai/ling-3.0-tiny:free —— 那正是 issue#15「所有模型空响应」的根因。
  const verdict = detectForeignClient(
    { tools: enabledBody.tools, messages: enabledBody.messages },
    true,
  )
  assert.equal(
    verdict.signal,
    null,
    '转发上游的工具集不得被判为外来：' + verdict.signal,
  )
  assert.deepEqual(verdict.hollowToolNames, [], '不得再出现空心签名工具')
  assert.deepEqual(verdict.foreignToolNames, [], '不得夹带第三方 harness 工具名')

  settingsStore.save({ freeToolSignatureEnabled: false })
  calls = []
  completionAttempts = 0
  const disabledRes = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
    tools,
  })
  assert.equal(disabledRes.status, 200, await disabledRes.clone().text())
  const disabledCall = calls.find((c) => c.url.includes('/chat/completions'))
  const disabledBody = JSON.parse(disabledCall.body)
  assert.deepEqual(
    disabledBody.tools.map((tool) => tool.function.name),
    ['web_search'],
  )
  settingsStore.save({ freeToolSignatureEnabled: true })
}


// stream
{
  mockMode = 'ok'
  completionAttempts = 0
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)
  assert.match(text, /hi/)
}

// models auth + list
{
  const res = await fetch(`${base}/v1/models`)
  assert.equal(res.status, 401)
}
{
  const res = await fetch(`${base}/v1/models`, {
    headers: { authorization: 'Bearer sk-test' },
  })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.object, 'list')
  assert.ok(j.data.length > 0)
  assert.ok(j.data.some((m) => m.id === 'openai/gpt-5.6-luna'))
}

// /api/v1 is not public
{
  const res = await fetch(`${base}/api/v1/me`, {
    headers: { authorization: 'Bearer sk-test' },
  })
  assert.equal(res.status, 404)
}

assert.equal(requireModelId('  openai/gpt-5.6-luna  '), 'openai/gpt-5.6-luna')
assert.equal(requireModelId(''), null)

// Official Freebuff Web-only/god-only models must use their model-specific
// roots; otherwise the upstream rejects the generic base2-free agent.
const verifiedSpecialModels = [
  {
    id: 'crof/kimi-k3-eco',
    base2: 'base2-free-kimi-k3-eco',
    base3: 'base3-free-kimi-k3-eco',
  },
  {
    id: 'openai/gpt-5.6-luna-es',
    base2: 'base2-free-luna-es',
    base3: 'base3-free-luna-es',
    // luna 系强制 base3（风控保护）：agentIdForModel 直接返回 base3，不再用 base2
    forcedBase3: true,
  },
  {
    id: 'meta/muse-spark-1.2-contributor',
    base2: 'base2-free-muse-spark',
    base3: 'base3-free-muse-spark',
  },
  {
    id: 'z-ai/glm-5.3-flash',
    base2: 'base2-free-glm-5-3-flash',
    base3: 'base3-free-glm-5-3-flash',
  },
  {
    id: 'stealth/ox-alpha',
    base2: 'base2-free-ox-alpha',
    base3: 'base3-free-ox-alpha',
  },
  {
    id: 'z-ai/glm-5.2',
    base2: 'base2-free-glm',
    base3: 'base3-free-glm',
  },
]
for (const model of verifiedSpecialModels) {
  // luna 系强制 base3：主 agent 直接是 base3（风控保护，绝不用 base2）
  const expected = model.forcedBase3 ? model.base3 : model.base2
  assert.equal(agentIdForModel(model.id), expected)
  assert.equal(agentFallbackForModel(model.id), model.base3)
  const listed = buildModelsListResponse().data.find((row) => row.id === model.id)
  assert.ok(listed, `${model.id} should be present in /v1/models`)
}

/**
 * 回归：accessTier='limited' 不得把整个目录标成 unavailable。
 *
 * 真实故障（用户反馈「测试对话只有一个模型」）：内置 catalog 15 条都没有
 * accessTiers 字段 → 一律回落 ['full'] → 上游回一次 accessTier:'limited'，整张
 * 列表就被染成 available:false，前端过滤后只剩 extraIds 里那一个模型。
 * 目录准入 ≠ 实时配额：真正拦人的是 freebucks/units 闸门，不是这个静态标记。
 */
{
  const limited = buildModelsListResponse({ accessTier: 'limited', includeAllCatalog: true })
  const unavailable = limited.data.filter((m) => m.available === false)
  assert.equal(
    unavailable.length,
    0,
    `accessTier=limited 时不应有任何模型被标成不可用（实际 ${unavailable.length} 个：${unavailable.map((m) => m.id).join(',')}）`,
  )
  // 基线 = 内置 catalog 的全量条目数（用同一入口取，避免硬编码数字）
  const baseline = buildModelsListResponse({ includeAllCatalog: true }).data.length
  assert.ok(
    limited.data.length >= baseline,
    `accessTier=limited 时列表长度不得缩水（${limited.data.length} < ${baseline}）`,
  )
  // 前端「测试对话」的过滤条件（available !== false）必须留下全部模型——
  // 这正是以前只剩一个的那一行。
  const visible = limited.data.filter((m) => m.available !== false)
  assert.equal(visible.length, limited.data.length, '测试对话下拉必须能看到全部模型')
  // 上游真实清单只作为**标注**透出（upstreamModelIds），不是过滤依据。
  const withIds = buildModelsListResponse({
    accessTier: 'limited',
    extraIds: ['deepseek/deepseek-v4-flash'],
  })
  assert.ok(
    withIds.data.find((m) => m.id === 'deepseek/deepseek-v4-flash').available !== false,
    '上游给过额度的模型当然可用',
  )
  assert.ok(
    withIds.data.find((m) => m.id === 'mimo/mimo-v2.5') !== undefined,
    '未出现在 extraIds 里的目录模型也必须保留在列表中',
  )
}

/**
 * 回归：账号级错误回执不得抹掉活着的 session 句柄。
 *
 * 上游对 banned / country_blocked 的 GET 回执是 200 + {status:'banned'}。以前
 * SessionManager.refresh() 无条件 _apply(body)，于是控制台点一次「刷新」就会：
 *   1) 把 session 覆盖成无 instanceId 的空壳 —— 已付费一小时的会话从此无法寻址，
 *      DELETE 不掉（腾不出上游槽位）也追不回钱（退款的唯一凭据就是 instanceId）；
 *      用户要求「刷新和警告都不会导致丢失已购买的会话」正是这条。
 *   2) 记成 lastProbe.ok = true —— 探测失败却显示成功。
 */
{
  const up = {
    freebuffSession: async (method) => {
      if (method === 'GET') return { status: 'banned', message: 'account banned' }
      throw new Error('不应触达 ' + method)
    },
  }
  const sm = new SessionManager({
    upstream: up,
    config: { session: { reAdmitOnExpire: true }, limits: {} },
    accountKey: 'probe-k',
  })
  // 先造一条活着的会话（买断了整小时）
  sm.session = {
    status: 'active',
    instanceId: 'inst-live',
    model: 'deepseek/deepseek-v4-flash',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    remainingMs: 3600_000,
  }
  await assert.rejects(
    () => sm.refresh(),
    (err) => err.code === 'banned',
    '账号级回执必须抛出（调用方据此区分 ban 与正常）',
  )
  assert.equal(sm.session?.instanceId, 'inst-live', '刷新不得抹掉活会话的句柄')
  assert.equal(sm.session?.status, 'active', '刷新不得篡改活会话状态')
  assert.equal(sm.lastProbe?.ok, false, '探测失败必须如实记为失败')
  assert.equal(sm.lastProbe?.code, 'banned')
  assert.ok(sm.hasLiveSlot(), '账号级故障不等于会话没了')
}

{
  const up = {
    freebuffSession: async () => ({ status: 'none', accessTier: 'full' }),
  }
  const sm = new SessionManager({
    upstream: up,
    config: { session: { reAdmitOnExpire: true }, limits: {} },
    accountKey: 'probe-ok',
  })
  await sm.refresh()
  assert.equal(sm.lastProbe?.ok, true, '正常回执仍记为成功')
  assert.equal(sm.lastProbe?.code, null)
}

// recoverable gate: exactly one re-admit (session POST again), one extra completion
{
  // Force fresh session path by releasing
  await runtimes.get('u1').sessions.release()
  calls = []
  sessionPosts = 0
  completionAttempts = 0
  mockMode = 'gate_once'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  const j = await res.json()
  assert.equal(j.choices[0].message.content, 'hi')
  // First admit + one force re-admit on retry (not double)
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  assert.equal(completionAttempts, 2)
  mockMode = 'ok'
}

// 会话切换（re-admit）不得掐断在途 SSE：旧 session 必须等在途流结束后才释放
{
  const sm = runtimes.get('u1').sessions
  await sm.release()
  calls = []
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  mockMode = 'hold_once'
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200)
  assert.equal(sm.inFlightCount(), 1, 'hold 流应在途')
  assert.equal(sessionPosts, 1)
  assert.equal(sessionDeletes, 0)

  // 模拟"会话即将过期需要 re-admit"：让 isUsableForModel 返回 false 后触发 ensureSession
  sm.session.expiresAt = new Date(Date.now() - 1000).toISOString()
  const ensurePromise = sm.ensureSession('deepseek/deepseek-v4-flash')
  // 等待一小段：ensureSession 应等待在途流结束，而不是立刻 DELETE 旧 session
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(sessionDeletes, 0, 're-admit 不得在流在途时删除旧 session')
  assert.equal(sm.inFlightCount(), 1)

  // 放行旧流 → 在途归零 → ensureSession 才释放旧 session 并 admit 新 session
  releaseHoldStreams()
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)
  await ensurePromise
  assert.equal(sessionDeletes, 1, '旧 session 应在流结束后才释放')
  assert.equal(sessionPosts, 2, '应 admit 一个新 session')
  mockMode = 'ok'
}

// agent 兜底：主 agent 403 free_mode_invalid_agent_model → 自动回退 base3 孪生
{
  mockMode = 'agent_fallback'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  // startAgentRun 至少尝试了 base3（fallback），且 chat 成功
  const startCalls = calls.filter(
    (c) => c.url.includes('/agent-runs') && JSON.parse(c.body).action === 'START',
  )
  assert.ok(
    startCalls.some((c) => JSON.parse(c.body).agentId === 'base3-free-deepseek-flash'),
    `应回退到 base3 孪生 agent, got ${JSON.stringify(startCalls.map((c) => JSON.parse(c.body).agentId))}`,
  )
  mockMode = 'ok'
}

// retired Luna conversation → release/re-admit the same model session once,
// without cooling the account or forwarding the stale conversation identity.
{
  await runtimes.get('u1').sessions.release()
  mockMode = 'legacy_luna_once'
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  calls = []
  const res = await chat({
    model: 'openai/gpt-5.6-luna',
    conversation_id: 'old-top-level-conversation',
    codebuff_metadata: {
      conversation_id: 'old-nested-conversation',
      client_id: 'old-client-id',
      agent_id: 'retired-luna-agent',
    },
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(sessionPosts, 2, 'legacy Luna error should admit a fresh session')
  assert.equal(sessionDeletes, 1, 'legacy Luna recovery should release the old session')

  const completionCalls = calls.filter((c) => c.url.includes('/chat/completions'))
  assert.equal(completionCalls.length, 2, 'legacy Luna should retry once')
  const forwarded = completionCalls.map((c) => JSON.parse(c.body))
  for (const body of forwarded) {
    assert.equal(body.conversation_id, undefined)
    assert.equal(body.codebuff_metadata.conversation_id, undefined)
    assert.equal(body.codebuff_metadata.agent_id, undefined)
    // client_id 必须是 SDK 形 13 位 base36（对齐官方 CLI
    // Math.random().toString(36).substring(2,15)）——绝不能用 freebuff-proxy
    // 等自有前缀：上游 cf-worker-signals.ts 的 looksLikeProxyClientId 会把
    // 自定义形态指纹为代理客户端（对齐 trefeon generateClientID）。
    assert.match(
      body.codebuff_metadata.client_id,
      /^[0-9a-z]{13}$/,
      `client_id 应为 13 位 base36 SDK 形, got ${body.codebuff_metadata.client_id}`,
    )
  }
  assert.notEqual(
    forwarded[0].codebuff_metadata.client_id,
    'old-client-id',
    'proxy must not inherit a retired client identity',
  )
  mockMode = 'ok'
}

// luna 系强制 base3（风控保护）：agentIdForModel 对 luna 永远返回 base3-free-luna，
// 无论自定义/catalog 写了 base2——任何 base2 尝试都会触发上游风控。
// 验证：真实 chat 里 startAgentRun 只用 base3，绝无 base2 出现。
{
  await runtimes.get('u1').sessions.release()
  mockMode = 'ok'
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  startAgentCalls = []
  calls = []
  const res = await chat({
    model: 'openai/gpt-5.6-luna',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.ok(
    startAgentCalls.length >= 1,
    `startAgentRun 至少调用一次, got ${JSON.stringify(startAgentCalls)}`,
  )
  assert.ok(
    startAgentCalls.every((a) => a === 'base3-free-luna'),
    `luna 只允许 base3-free-luna, got ${JSON.stringify(startAgentCalls)}`,
  )
  assert.ok(
    !startAgentCalls.some((a) => a.includes('base2')),
    `luna 绝不允许 base2, got ${JSON.stringify(startAgentCalls)}`,
  )
  // luna-es 同样强制 base3（base3-free-luna-es，绝无 base2）
  startAgentCalls = []
  const resEs = await chat({
    model: 'openai/gpt-5.6-luna-es',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(resEs.status, 200, await resEs.clone().text())
  assert.ok(
    startAgentCalls.every((a) => a === 'base3-free-luna-es'),
    `luna-es 应只用 base3-free-luna-es, got ${JSON.stringify(startAgentCalls)}`,
  )
  mockMode = 'ok'
}

// 模型白名单：APP 里没有的模型 id 一律 400 拒绝，绝不盲发上游
{
  calls = []
  completionAttempts = 0
  // 完全未知的模型 id（不在 catalog / 自定义 / 上游探测里）
  const res = await chat({
    model: 'openai/gpt-5.7-unknown',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 400, await res.clone().text())
  const j = await res.json()
  assert.equal(j.error.code, 'model_not_allowed')
  assert.equal(completionAttempts, 0, '未知模型不应打到上游')
  mockMode = 'ok'
}

// 客户端断开必须立即释放账号锁（回归：reqToAbortSignal 无条件 abort，
// 否则请求体读完（req.complete=true）后断开会让上游挂到超时、锁占死全部请求）
{
  mockMode = 'hold_once'
  completionAttempts = 0
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200)
  // 读一个 chunk 后客户端断开（cancel body → 连接关闭）
  const reader = res.body.getReader()
  await reader.read()
  await reader.cancel().catch(() => {})
  // 立即发第二个请求：锁必须已释放并快速 200（无修复会卡到上游超时/无限排队）
  const t0 = Date.now()
  const res2 = await chat({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello again' }],
  })
  assert.equal(res2.status, 200, await res2.clone().text())
  assert.ok(
    Date.now() - t0 < 10_000,
    `断开后账号锁应快速释放, took ${Date.now() - t0}ms`,
  )
  await res2.text()
  mockMode = 'ok'
}

// 流量切换（代理池变更）不得掐断在途 SSE：旧 runtime 优雅回收
{
  const pDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-drain-'))
  saveAccountUser(pDir, { id: 'pa', email: 'pa@example.com', authToken: 'token-pa' })
  const pConfig = loadConfig()
  pConfig.server.host = '127.0.0.1'
  pConfig.server.port = 0
  pConfig.server.apiKeys = ['sk-test']
  pConfig.upstream.credentialsDir = pDir
  pConfig.session.pollIntervalSec = 3600
  const pRuntimes = new AccountRuntimes(pConfig)
  const pServer = await startServer({
    config: pConfig,
    runtimes: pRuntimes,
    ...(() => {
      const rt = pRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const pBase = `http://127.0.0.1:${pServer.address().port}`
  const oldRt = pRuntimes.get('pa')

  mockMode = 'hold_once'
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  const res = await fetch(`${pBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200)
  assert.equal(oldRt.sessions.inFlightCount(), 1)

  // 切换代理池：立即让位，但旧流不能被掐断
  pConfig.upstream.proxies = ['http://p1.example:7890']
  await pRuntimes.invalidateProxies()
  assert.equal(pRuntimes.isCurrentRuntime(oldRt), false)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(sessionDeletes, 0, '代理切换不得在流在途时删除旧 session')

  // 旧流正常结束，之后旧 session 才被优雅释放
  releaseHoldStreams()
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)
  await waitFor('代理切换后旧 session 优雅释放', () => sessionDeletes >= 1)
  assert.equal(sessionDeletes, 1)
  assert.equal(sessionPosts, 1, '切换本身不应新增 admit（新请求才走新出口）')

  await pRuntimes.shutdown()
  pServer.close()
  fs.rmSync(pDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// 排队等锁期间发生代理切换 → 请求无冷却重新选号，不撞已失效旧 runtime
// 真实代理链路：本地 mock 上游 + 本地转发代理（单代理池必须真的走代理，回归 issue #5）
{
  const { createMockUpstreamServer, createForwardProxy } = await import('./proxy-test-helpers.mjs')
  const qDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-queue-switch-'))
  saveAccountUser(qDir, { id: 'qa', email: 'qa@example.com', authToken: 'token-qa' })
  const holdResponses = []
  const releaseQHolds = () => {
    for (const hres of holdResponses.splice(0)) {
      try {
        hres.write('data: [DONE]\n\n')
        hres.end()
      } catch {
        // ignore
      }
    }
  }
  const qUpstream = await createMockUpstreamServer({
    sessionPosts: () => sessionPosts,
    bumpSessionPosts: () => { sessionPosts++ },
    bumpSessionDeletes: () => { sessionDeletes++ },
    completionAttempts: () => completionAttempts,
    bumpCompletionAttempts: () => { completionAttempts++ },
    getMockMode: () => mockMode,
    holdStreamControllers,
    holdResponses,
  })
  const qProxy = await createForwardProxy()
  const qConfig = loadConfig()
  qConfig.server.host = '127.0.0.1'
  qConfig.server.port = 0
  qConfig.server.apiKeys = ['sk-test']
  qConfig.upstream.credentialsDir = qDir
  qConfig.upstream.apiBase = `http://127.0.0.1:${qUpstream.port}`
  qConfig.session.pollIntervalSec = 3600
  qConfig.limits.accountMaxConcurrency = 1
  const qRuntimes = new AccountRuntimes(qConfig)
  const qServer = await startServer({
    config: qConfig,
    runtimes: qRuntimes,
    ...(() => {
      const rt = qRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const qBase = `http://127.0.0.1:${qServer.address().port}`

  mockMode = 'hold_once'
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  const oldRt = qRuntimes.get('qa')
  // A：占住账号唯一并发槽（流保持打开）
  const resA = await fetch(`${qBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(resA.status, 200)
  assert.equal(oldRt.sessions.inFlightCount(), 1)
  // B：开始后会在 chat 锁上排队
  const resBPromise = fetch(`${qBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  await new Promise((r) => setTimeout(r, 150))
  // 等待期间切换代理池 → 旧 runtime 被顶替（单代理池，真实本地代理）
  qConfig.upstream.proxies = [`http://127.0.0.1:${qProxy.port}`]
  await qRuntimes.invalidateProxies()
  assert.equal(qRuntimes.isCurrentRuntime(oldRt), false)
  // 放行 A；B 拿到锁后应检测到 runtime 已过期 → 无冷却重新选号 → 走新出口成功
  releaseQHolds()
  await resA.text()
  const resB = await resBPromise
  assert.equal(resB.status, 200, await resB.clone().text())
  assert.match(await resB.text(), /data: \[DONE\]/)
  assert.equal(sessionPosts, 2, 'B 应在新 runtime 上 admit 新 session')
  // A 的旧 session 由优雅回收释放
  await waitFor('排队切换后旧 session 优雅释放', () => sessionDeletes >= 1)

  await qRuntimes.shutdown()
  qServer.close()
  qUpstream.server.close()
  qProxy.server.close()
  fs.rmSync(qDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// multi-account: A rate_limited → B succeeds
{
  const multiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-multi-'))
  saveAccountUser(multiDir, {
    id: 'a',
    email: 'a@example.com',
    authToken: 'token-a',
  })
  saveAccountUser(multiDir, {
    id: 'b',
    email: 'b@example.com',
    authToken: 'token-b',
  })
  const multiConfig = loadConfig()
  multiConfig.server.host = '127.0.0.1'
  multiConfig.server.port = 0
  multiConfig.server.apiKeys = ['sk-test']
  multiConfig.upstream.credentialsDir = multiDir
  multiConfig.session.pollIntervalSec = 3600
  const multiRuntimes = new AccountRuntimes(multiConfig)
  const multiServer = await startServer({
    config: multiConfig,
    runtimes: multiRuntimes,
    ...(() => {
      const rt = multiRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const multiPort = multiServer.address().port
  mockMode = 'rate_limit_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${multiPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  // At least one failed admit (A) and one success (B)
  assert.ok(sessionPosts >= 2)
  const accounts = multiRuntimes.list()
  const a = accounts.find((x) => x.email === 'a@example.com')
  assert.equal(a.available, false)
  assert.equal(a.cooldownCode, 'rate_limited')
  // quota from admit is surfaced on the row
  const b = accounts.find((x) => x.email === 'b@example.com')
  assert.equal(b.quota.byModel['deepseek/deepseek-v4-flash'].limit, 6)
  assert.equal(b.quota.byModel['deepseek/deepseek-v4-flash'].recentCount, 1)
  // request distribution stats present
  assert.ok(b.requests >= 1)
  await multiRuntimes.shutdown()
  multiServer.close()
  fs.rmSync(multiDir, { recursive: true, force: true })
  mockMode = 'ok'
}


// account_suspended（403，error 为字符串）必须归一为 banned：
// 冷却该账号并**换号重试**，绝不能当客户端 4xx 把错误甩给用户。
// 背景（2026-09-18 线上实测）：上游对第三方客户端的封禁回的是
// 403 {"error":"account_suspended"}（error 是字符串，没有 code 字段）；
// 不归一它就会落进"4xx 客户端错误不换号"分支，于是每个被封账号被反复复用。
{
  const banDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-ban-'))
  saveAccountUser(banDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(banDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const banConfig = loadConfig()
  banConfig.server.host = '127.0.0.1'
  banConfig.server.port = 0
  banConfig.server.apiKeys = ['sk-test']
  banConfig.upstream.credentialsDir = banDir
  banConfig.session.pollIntervalSec = 3600
  const banRuntimes = new AccountRuntimes(banConfig)
  const banServer = await startServer({
    config: banConfig,
    runtimes: banRuntimes,
    ...(() => {
      const rt = banRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const banPort = banServer.address().port
  mockMode = 'suspended_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${banPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  // token-a 被封 → 必须换到 token-b 成功，而不是把 403 甩给下游。
  assert.equal(res.status, 200, await res.clone().text())
  assert.ok(
    calls.filter((c) => c.url.includes('/chat/completions')).length >= 2,
    '封禁后必须换号重试',
  )
  // 被封账号被标记 banned（控制台分区与调度排除都靠它）。
  const banAccounts = banRuntimes.list()
  const bannedA = banAccounts.find((x) => x.email === 'a@example.com')
  assert.equal(bannedA.banned, true, 'account_suspended 应归一为 banned')
  assert.equal(bannedA.available, false)
  await banRuntimes.shutdown()
  banServer.close()
  fs.rmSync(banDir, { recursive: true, force: true })
  mockMode = 'ok'
}
// completions 返回 free_mode_rate_limited → 冷却当前账号并换号重试一次
{
  const rlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-rlcomp-'))
  saveAccountUser(rlDir, {
    id: 'a',
    email: 'a@example.com',
    authToken: 'token-a',
  })
  saveAccountUser(rlDir, {
    id: 'b',
    email: 'b@example.com',
    authToken: 'token-b',
  })
  const rlConfig = loadConfig()
  rlConfig.server.host = '127.0.0.1'
  rlConfig.server.port = 0
  rlConfig.server.apiKeys = ['sk-test']
  rlConfig.upstream.credentialsDir = rlDir
  rlConfig.session.pollIntervalSec = 3600
  const rlRuntimes = new AccountRuntimes(rlConfig)
  const rlServer = await startServer({
    config: rlConfig,
    runtimes: rlRuntimes,
    ...(() => {
      const rt = rlRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const rlPort = rlServer.address().port
  mockMode = 'rate_limit_completion'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${rlPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  // a 完成被 429 后换到 b 重试：2 次 session POST、2 次 completions
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  assert.equal(completionAttempts, 2)
  const rlAccounts = rlRuntimes.list()
  const rlA = rlAccounts.find((x) => x.email === 'a@example.com')
  assert.equal(rlA.available, false)
  assert.equal(rlA.cooldownCode, 'free_mode_rate_limited')
  // 冷却时长采用上游 retry-after（60s）
  const cd = rlRuntimes.cooldowns.get('a')
  assert.ok(
    cd.until - Date.now() >= 58_000,
    `cooldown should honor retry-after 60s, got ${cd.until - Date.now()}ms`,
  )
  // 可观测性：响应头标明实际账号；换号后是 b
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  await rlRuntimes.shutdown()
  rlServer.close()
  fs.rmSync(rlDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// cooldown: model_unavailable is per-model, not whole account
{
  const pool = new AccountRuntimes(config)
  pool.markCooldown(
    'u1',
    { code: 'model_unavailable', retryAfterMs: 60_000 },
    'openai/gpt-5.6-luna',
  )
  assert.equal(
    pool.isCoolingDown('u1', 'openai/gpt-5.6-luna'),
    true,
  )
  assert.equal(
    pool.isCoolingDown('u1', 'deepseek/deepseek-v4-flash'),
    false,
  )
  pool.markCooldown('u1', {
    code: 'banned',
    retryAfterMs: 1000,
  })
  assert.equal(pool.isCoolingDown('u1', 'any'), true)
  const cd = pool.cooldowns.get('u1')
  assert.ok(cd.until - Date.now() > 60_000) // banned floors to 1 day
}

// --- unit: loadConfig 不得污染全局 DEFAULTS（深拷贝缺失的真 bug） ---
// 历史 bug：deepMerge 用 `{ ...base }` 浅拷贝，当**没有 config.yaml** 时 fileConfig={}，
// 嵌套的 session/limits/web/upstream 与 DEFAULTS 共享同一对象；任何一处
// `config.session.xxx = y`（测试与运行时代码都这么改）都会污染 DEFAULTS，
// 使同一进程内后续所有 loadConfig() 拿到被改坏的配置。有 config.yaml 时因递归
// 新建对象而被掩盖——CI 一直靠仓库里的 config.yaml 侥幸通过。
{
  const { DEFAULTS } = await import('../src/config.js')
  const snapshot = JSON.stringify(DEFAULTS)
  const c = loadConfig()
  // 模拟调用方就地改写配置（smoke 其它块与运行时都这么做）
  c.session.idleReleaseSec = 0.15
  c.limits.maxNewSessionsPerRequest = 99
  c.limits.accountMaxConcurrency = 7
  c.web.sessionTtlHours = 1
  c.upstream.proxies.push('http://pushed.example:1')
  assert.equal(
    JSON.stringify(DEFAULTS),
    snapshot,
    '修改 loadConfig() 的结果不得改动全局 DEFAULTS（需深拷贝）',
  )
  const again = loadConfig()
  assert.equal(again.session.idleReleaseSec, JSON.parse(snapshot).session.idleReleaseSec, '后续 loadConfig 必须拿到干净默认值')
  assert.equal(again.limits.maxNewSessionsPerRequest, 2)
  assert.equal(again.limits.accountMaxConcurrency, 2)
  assert.equal(again.web.sessionTtlHours, 24 * 7)
  assert.deepEqual(again.upstream.proxies, [])

  // 嵌套对象/数组必须与 DEFAULTS 无共享引用
  const d = loadConfig()
  assert.notEqual(d.session, DEFAULTS.session, '嵌套对象不得共享引用')
  assert.notEqual(d.limits, DEFAULTS.limits, '嵌套对象不得共享引用')
  assert.notEqual(d.upstream.proxies, DEFAULTS.upstream.proxies, '数组不得共享引用')
}
// --- unit: catalog 缓存必须落在 dataDir（issue #9：写死 /app/data → EACCES）---
{
  const { writeCatalogCache, readCatalogCache, startCatalogSync } = await import(
    '../src/catalog/runtime-sync.mjs'
  )
  // 路径由 dataDir 决定，而不是源码目录旁的 data
  assert.equal(catalogCachePath('/data'), path.join('/data', CATALOG_CACHE_FILENAME))
  assert.equal(catalogCachePath('/srv/x'), path.join('/srv/x', 'catalog-cache.json'))
  assert.ok(DEFAULT_CATALOG_CACHE_PATH.endsWith(path.join('data', CATALOG_CACHE_FILENAME)))

  // 切到 dataDir 后能读回同一份缓存（读路径 = 写路径）
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-catalog-'))
  const before = applyCatalogCache(cacheDir)
  assert.equal(before.path, catalogCachePath(cacheDir))
  assert.ok(before.models.length > 0, '切换到 dataDir 后应能读回合并后的 catalog')
  assert.ok(
    before.models.some((m) => m.id === 'deepseek/deepseek-v4-flash'),
    '切入 dataDir 后应能读到真实 catalog（含 flash）',
  )
  // 内置 catalog 兜底写一份（server 启动时的 seed 行为）
  assert.deepEqual(
    writeCatalogCache(before.path, {
      version: 1,
      models: before.models,
      source: 'builtin',
    }),
    { ok: true },
  )
  assert.equal(readCatalogCache(before.path)?.models.length, before.models.length)

  // 目录不可写（旧版 Docker 的 /app/data）→ 只报错不抛，同步循环继续跑
  const badDir = path.join(cacheDir, 'file-not-a-dir')
  fs.writeFileSync(badDir, 'x')
  const fail = writeCatalogCache(path.join(badDir, 'catalog-cache.json'), { models: [] })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /ENOTDIR|EEXIST|EACCES|EPERM|ENOENT/)

  // 拉取成功但落盘失败 → 日志必须区别于"拉取失败"（issue #9 的误导来源）
  const logs = []
  const sync = startCatalogSync(path.join(badDir, 'catalog-cache.json'), {
    log: (m) => logs.push(m),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => 'export const X_MODEL_ID = \'a/b\'\nexport const Y_MODEL_ID = \'c/d\'\n'.repeat(5),
    }),
  })
  await sync.done
  assert.ok(
    logs.some((m) => m.includes('catalog cache not writable')),
    '落盘失败必须报 cache not writable，而不是 refresh failed',
  )
  assert.ok(!logs.some((m) => m.includes('refresh failed')), '不得把权限问题报成拉取失败')
  sync.stop()
  fs.rmSync(cacheDir, { recursive: true, force: true })

  // 合并规则：内置元信息优先，agent 映射跟随缓存
  const merged = mergeCatalogWithBuiltin(
    [{ id: 'm', displayName: '内置名', pool: 'premium', agentId: 'base2-x' }],
    [
      { id: 'm', displayName: '缓存名', pool: 'daily', agentId: 'base2-new' },
      { id: 'new', displayName: '新模型' },
    ],
  )
  assert.equal(merged[0].displayName, '内置名')
  assert.equal(merged[0].pool, 'premium')
  assert.equal(merged[0].agentId, 'base2-new')
  assert.equal(merged[1].id, 'new')
  assert.deepEqual(mergeCatalogWithBuiltin([{ id: 'm' }], null), [{ id: 'm' }])
}

// --- unit: 管理员 bootstrap 报告真实结果（issue #9：日志撒谎导致"无法登录"）---
{
  const { UserStore } = await import('../src/web/user-store.js')
  const adminsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-admin-'))
  const store = new UserStore(path.join(adminsDir, 'users.json'))

  // 1) 首次启动 + 无密码 → 随机生成，必须把密码交回调用方打印
  const first = store.ensureDefaultAdmin('admin', null)
  assert.equal(first.created, true)
  assert.equal(first.username, 'admin')
  assert.ok(first.password && first.password.length >= 6)

  // 2) 已有管理员 + env 给了合法密码 → 轮换（rotated=true，供日志如实上报）
  const rotated = store.ensureDefaultAdmin('admin', 'newpass123')
  assert.equal(rotated.created, false)
  assert.equal(rotated.rotated, true)
  assert.ok(store.verifyPassword('admin', 'newpass123'))

  // 3) env 密码不合法（<6 位）→ 不能静默当成功，必须回传 error 让人看到
  const rejected = store.ensureDefaultAdmin('admin', 'abc')
  assert.equal(rejected.rotated, undefined)
  assert.match(String(rejected.error), /密码/)
  assert.ok(store.verifyPassword('admin', 'newpass123'), '被拒绝的密码不得改动现有密码')

  // 4) 已有管理员且没给密码 → 既不创建也不轮换（密码只在首次启动打印一次）
  const again = store.ensureDefaultAdmin('admin', null)
  assert.equal(again.created, false)
  assert.equal(again.rotated, undefined)
  assert.equal(again.password, undefined)
  fs.rmSync(adminsDir, { recursive: true, force: true })
}

// --- unit: user store + web sessions ---
{
  const { UserStore } = await import('../src/web/user-store.js')
  const { WebSessionStore } = await import('../src/web/session-store.js')
  const us = new UserStore(path.join(tmpDir, 'users.json'))
  assert.equal(us.all().length, 0)
  const u = us.create({ username: 'Alice', password: 'secret123', role: 'user' })
  assert.equal(u.username, 'alice')
  assert.ok(u.apiKey.startsWith('sk-fb-'))
  assert.equal(us.verifyPassword('alice', 'wrong'), null)
  const good = us.verifyPassword('alice', 'secret123')
  assert.equal(good.username, 'alice')
  assert.equal(us.getByApiKey(u.apiKey).username, 'alice')
  const newKey = us.resetApiKey('alice')
  assert.ok(newKey !== u.apiKey)
  // persistence across instances
  const us2 = new UserStore(path.join(tmpDir, 'users.json'))
  assert.equal(us2.getByUsername('alice').username, 'alice')
  us2.delete('alice')
  assert.equal(us2.getByUsername('alice'), null)

  const ws = new WebSessionStore(path.join(tmpDir, 'web-sessions.json'), 60_000)
  const tok = ws.create('alice')
  assert.equal(ws.get(tok), 'alice')
  ws.destroy(tok)
  assert.equal(ws.get(tok), null)
}

// --- unit: session-first —— 热 session 复用，冷却后才启用下一个账号 ---
{
  const rrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-rr-unit-'))
  saveAccountUser(rrDir, { id: 'a', email: 'rr-a@example.com', authToken: 'token-a' })
  saveAccountUser(rrDir, { id: 'b', email: 'rr-b@example.com', authToken: 'token-b' })
  saveAccountUser(rrDir, { id: 'c', email: 'rr-c@example.com', authToken: 'token-c' })
  const rrConfig = loadConfig()
  rrConfig.upstream.credentialsDir = rrDir
  rrConfig.session.pollIntervalSec = 3600
  // 本用例回归热 session 复用 → 平摊账号数=1（只用一个账号，永远复用热 session）
  const pool = new AccountRuntimes(rrConfig)
  mockMode = 'ok'
  sessionPosts = 0
  // 串行请求全部复用 a 的同一个热 session，只 admit 一次。
  const emails = []
  for (let i = 0; i < 6; i++) {
    const rt = await pool.acquireForModel('deepseek/deepseek-v4-flash')
    emails.push(rt.email)
  }
  assert.deepEqual(
    emails,
    [
      'rr-a@example.com',
      'rr-a@example.com',
      'rr-a@example.com',
      'rr-a@example.com',
      'rr-a@example.com',
      'rr-a@example.com',
    ],
    `同模型热 session 应持续复用, got ${JSON.stringify(emails)}`,
  )
  assert.equal(sessionPosts, 1, `expected one admission, got ${sessionPosts}`)

  // 新模型优先使用空闲的 b，不能释放 a 上仍可复用的 Flash session。
  const luna = await pool.acquireForModel('openai/gpt-5.6-luna')
  assert.equal(luna.email, 'rr-b@example.com')
  assert.equal(pool.get('a').sessions.getSnapshot().model, 'deepseek/deepseek-v4-flash')
  assert.equal(pool.get('b').sessions.getSnapshot().model, 'openai/gpt-5.6-luna')
  assert.equal(sessionPosts, 2, `second model should add one admission, got ${sessionPosts}`)

  // a 冷却后，Flash 使用空闲的 c，而不是覆盖 b 上的 Luna。
  pool.markCooldown('a', {
    code: 'rate_limited',
    retryAfterMs: 60_000,
  })
  const next = []
  for (let i = 0; i < 4; i++) {
    const rt = await pool.acquireForModel('deepseek/deepseek-v4-flash')
    next.push(rt.email)
  }
  assert.deepEqual(
    next,
    ['rr-c@example.com', 'rr-c@example.com', 'rr-c@example.com', 'rr-c@example.com'],
    `故障切号后应复用新账号 session, got ${JSON.stringify(next)}`,
  )
  assert.equal(sessionPosts, 3, `expected three admissions, got ${sessionPosts}`)
  await pool.shutdown()
  fs.rmSync(rrDir, { recursive: true, force: true })
}

// --- unit: 粘性调度（drain, not rotate）——集中用一个账号，未用过的排最后 ---
{
  const spDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-sticky-'))
  saveAccountUser(spDir, { id: 'a', email: 'sp-a@example.com', authToken: 'token-a' })
  saveAccountUser(spDir, { id: 'b', email: 'sp-b@example.com', authToken: 'token-b' })
  saveAccountUser(spDir, { id: 'c', email: 'sp-c@example.com', authToken: 'token-c' })
  const spConfig = loadConfig()
  spConfig.upstream.credentialsDir = spDir
  spConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(spConfig)
  mockMode = 'ok'
  sessionPosts = 0
  // 串行请求全部粘在 a 上（同一个热 session，只 admit 一次）——绝不轮换健康账号
  const emails = []
  for (let i = 0; i < 6; i++) {
    const rt = await pool.acquireForModel('deepseek/deepseek-v4-flash')
    emails.push(rt.email)
  }
  assert.deepEqual(
    emails,
    Array(6).fill('sp-a@example.com'),
    `请求应粘在同一账号, got ${JSON.stringify(emails)}`,
  )
  assert.equal(sessionPosts, 1, `expected one admission, got ${sessionPosts}`)
  // 从未用过的账号一个都不能碰
  const rows = pool.list()
  assert.equal(rows.find((r) => r.key === 'a').used, true, 'a 应标记为已用')
  assert.equal(rows.find((r) => r.key === 'b').used, false, 'b 不应被使用')
  assert.equal(rows.find((r) => r.key === 'c').used, false, 'c 不应被使用')

  // a 冷却（限流/额度耗尽）→ 才启用一个从未用过的账号，并继续粘住它
  pool.markCooldown('a', { code: 'rate_limited', retryAfterMs: 60_000 })
  const after = []
  for (let i = 0; i < 3; i++) {
    after.push((await pool.acquireForModel('deepseek/deepseek-v4-flash')).email)
  }
  assert.deepEqual(
    after,
    Array(3).fill('sp-b@example.com'),
    `换号后应粘住新账号, got ${JSON.stringify(after)}`,
  )
  assert.equal(pool.list().find((r) => r.key === 'c').used, false, 'c 仍不应被使用')

  // b 也冷却 → 才轮到最后一个从未用过的账号 c
  pool.markCooldown('b', { code: 'rate_limited', retryAfterMs: 60_000 })
  const last = await pool.acquireForModel('deepseek/deepseek-v4-flash')
  assert.equal(last.email, 'sp-c@example.com', '最后一个账号才启用 c')

  // 只剩 c 可用且它持有 flash 热 session：换模型请求复用同一账号（释放旧 session）
  sessionPosts = 0
  const luna = await pool.acquireForModel('openai/gpt-5.6-luna')
  assert.equal(luna.email, 'sp-c@example.com', '无其他可用账号时应复用已用账号换模型')
  assert.equal(sessionPosts, 1, `换模型应只 admit 一次, got ${sessionPosts}`)
  await pool.shutdown()
  fs.rmSync(spDir, { recursive: true, force: true })
}

// --- regression: GitHub/Google 同一邮箱但 id 不同 → 两个账号并存，不互相覆盖 ---
{
  const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-dup-'))
  // 模拟 GitHub 登录 + Google 登录（同一邮箱、不同 Freebuff id）
  saveAccountUser(dupDir, { id: 'github-u1', email: 'same@example.com', name: 'GitHub', authToken: 'token-gh' })
  saveAccountUser(dupDir, { id: 'google-u1', email: 'same@example.com', name: 'Google', authToken: 'token-google' })
  let rows = listAccounts(dupDir)
  assert.equal(rows.length, 2, `同邮箱不同 id 应并存, got ${JSON.stringify(rows.map((r) => r.id))}`)
  assert.equal(rows.filter((r) => r.email === 'same@example.com').length, 2)
  assert.ok(rows.some((r) => r.id === 'github-u1') && rows.some((r) => r.id === 'google-u1'))
  // 各自独立文件，互不覆盖
  assert.ok(fs.existsSync(path.join(dupDir, 'github-u1.json')))
  assert.ok(fs.existsSync(path.join(dupDir, 'google-u1.json')))
  // 重登 GitHub（同 id）→ 只更新 GitHub 那份，Google 那份原样保留
  saveAccountUser(dupDir, { id: 'github-u1', email: 'same@example.com', name: 'GitHub', authToken: 'token-gh-2' })
  rows = listAccounts(dupDir)
  assert.equal(rows.length, 2)
  assert.equal(readAccountUser(dupDir, 'github-u1').authToken, 'token-gh-2')
  assert.equal(readAccountUser(dupDir, 'google-u1').authToken, 'token-google')
  // 并发冷启动也只能创建一个 session；两个身份仍各自独立存在于账号池。
  const dupConfig = loadConfig()
  dupConfig.upstream.credentialsDir = dupDir
  dupConfig.session.pollIntervalSec = 3600
  const dupPool = new AccountRuntimes(dupConfig)
  mockMode = 'ok'
  sessionPosts = 0
  const seen = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const rt = await dupPool.acquireForModel('deepseek/deepseek-v4-flash')
      return rt.key
    }),
  )
  assert.equal(new Set(seen).size, 1, `并发冷启动应复用一个账号, got ${seen}`)
  assert.equal(sessionPosts, 1, `并发冷启动只应 admit 一次, got ${sessionPosts}`)
  await dupPool.shutdown()
  fs.rmSync(dupDir, { recursive: true, force: true })
}

// --- per-account proxy (多代理粘性: 账号绑定专属出口) ---
{
  const pDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-acc-'))
  saveAccountUser(pDir, {
    id: 'pa',
    email: 'pa@example.com',
    authToken: 'token-pa',
    proxy: 'http://127.0.0.1:7890',
  })
  saveAccountUser(pDir, { id: 'pb', email: 'pb@example.com', authToken: 'token-pb' })
  const pConfig = loadConfig()
  pConfig.upstream.credentialsDir = pDir
  pConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(pConfig)

  // runtime uses the per-account proxy
  const rtA = pool.get('pa')
  assert.equal(rtA.proxy, 'http://127.0.0.1:7890')
  assert.equal(rtA.effectiveProxy, 'http://127.0.0.1:7890')

  // rows surface proxy + effectiveProxy
  const rows = pool.list()
  const rowA = rows.find((x) => x.email === 'pa@example.com')
  assert.equal(rowA.proxy, 'http://127.0.0.1:7890')
  assert.equal(rowA.effectiveProxy, 'http://127.0.0.1:7890')
  assert.equal(rows.find((x) => x.email === 'pb@example.com').proxy, null)
  assert.equal(rows.find((x) => x.email === 'pb@example.com').effectiveProxy, null)

  // proxy change → cached runtime recreated with the new proxy
  pool.get('pa').sessions.quota = { byModel: {}, rateLimit: null, updatedAt: 'x' }
  const before = pool.get('pa')
  const file = path.join(pDir, 'pa.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.proxy = null
  fs.writeFileSync(file, JSON.stringify(raw))
  const after = pool.get('pa')
  assert.notEqual(after, before)
  assert.equal(after.proxy, null)

  // createUpstreamClient honors opts.proxy without throwing
  const { createUpstreamClient } = await import('../src/upstream/client.js')
  const cli = createUpstreamClient(pConfig, 'tok', { proxy: 'http://127.0.0.1:7890' })
  assert.ok(cli)
  await pool.shutdown()
  fs.rmSync(pDir, { recursive: true, force: true })
}

// --- 全局代理池：稳定哈希分配 + 账号覆盖优先 ---
{
  const poolConfig = loadConfig()
  poolConfig.upstream.proxies = [
    'http://p1.example:7890',
    'http://p2.example:7890',
    'http://p3.example:7890',
  ]
  const { createUpstreamClient } = await import('../src/upstream/client.js')
  const a1 = createUpstreamClient(poolConfig, 'tok', { accountId: 'a@example.com' })
  const a2 = createUpstreamClient(poolConfig, 'tok', { accountId: 'a@example.com' })
  const b = createUpstreamClient(poolConfig, 'tok', { accountId: 'b@example.com' })
  // 同账号稳定同一代理
  assert.equal(a1.proxyUrl, a2.proxyUrl)
  assert.ok(a1.proxyUrl.startsWith('http://p'))
  // 不同账号可能落到不同代理（池内成员之一）
  assert.ok(poolConfig.upstream.proxies.includes(a1.proxyUrl))
  assert.ok(poolConfig.upstream.proxies.includes(b.proxyUrl))
  // 账号显式代理优先于全局池
  const c = createUpstreamClient(poolConfig, 'tok', {
    accountId: 'a@example.com',
    proxy: 'http://explicit:9999',
  })
  assert.equal(c.proxyUrl, 'http://explicit:9999')
  // 无池无显式 → 直连（null）
  const plain = createUpstreamClient(loadConfig(), 'tok', { accountId: 'x@example.com' })
  assert.equal(plain.proxyUrl, null)
}

// --- 回归：单代理池也必须走代理（issue #5 根因：1 个代理时直连绕过） ---
{
  const { createProxyFetch } = await import('../src/upstream/client.js')
  // 最小 HTTP 代理：收到绝对形式请求直接回带标记的响应（不转发）
  let proxyHits = 0
  const proxyServer = http.createServer((req, res) => {
    proxyHits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('VIA_PROXY ' + req.url)
  })
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('DIRECT ' + req.url)
  })
  await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r))
  await new Promise((r) => targetServer.listen(0, '127.0.0.1', r))
  const proxyPort = proxyServer.address().port
  const targetPort = targetServer.address().port
  try {
    const cfg = loadConfig()
    cfg.upstream.proxies = [`http://127.0.0.1:${proxyPort}`] // 单代理池
    const { fetch: proxyFetch } = createProxyFetch(cfg)
    const res = await proxyFetch(`http://127.0.0.1:${targetPort}/hello`, {
      headers: { 'x-test': '1' },
    })
    const text = await res.text()
    assert.ok(
      text.startsWith('VIA_PROXY'),
      `单代理池应走代理（代理收到请求），实际响应: ${text}`, // 直连会给 DIRECT
    )
    assert.equal(proxyHits, 1, '请求应恰好经过代理一次')
    // 上游 apiFetch 同样走单代理池（apiBase 指向 target，代理不转发 → 收到的是代理的响应）
    const upstreamCfg = loadConfig()
    upstreamCfg.upstream.apiBase = `http://127.0.0.1:${targetPort}`
    upstreamCfg.upstream.proxies = [`http://127.0.0.1:${proxyPort}`]
    const { createUpstreamClient } = await import('../src/upstream/client.js')
    const cli = createUpstreamClient(upstreamCfg, 'tok', { accountId: 'a@example.com' })
    const r2 = await cli.raw('/api/v1/me', { method: 'GET' })
    const t2 = await r2.text()
    assert.ok(
      t2.startsWith('VIA_PROXY'),
      `上游调用单代理池也应走代理，实际响应: ${t2}`, // 直连会是 DIRECT
    )
  } finally {
    proxyServer.close()
    targetServer.close()
  }
}

// --- web api: probe 只读刷新 session/额度缓存 ---
{
  const wDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-probe-'))
  saveAccountUser(wDir, { id: 'w', email: 'w@example.com', authToken: 'token-w' })
  const wConfig = loadConfig()
  wConfig.server.host = '127.0.0.1'
  wConfig.server.port = 0
  wConfig.server.apiKeys = ['sk-test']
  wConfig.upstream.credentialsDir = wDir
  wConfig.session.pollIntervalSec = 3600
  const { UserStore } = await import('../src/web/user-store.js')
  const { WebSessionStore } = await import('../src/web/session-store.js')
  const { LoginFlowManager } = await import('../src/web/login-flows.js')
  const { ProxyStore } = await import('../src/web/proxy-store.js')
  const userStore = new UserStore(path.join(wDir, 'users.json'))
  const webSessions = new WebSessionStore(path.join(wDir, 'web-sessions.json'), 3600_000)
  userStore.create({ username: 'admin', password: 'secret123', role: 'admin' })
  const loginFlows = new LoginFlowManager({
    file: path.join(wDir, 'login-flows.json'),
    credentialsDir: wDir,
    config: wConfig,
  })
  const proxyStore = new ProxyStore(path.join(wDir, 'proxies.json'))
  const settingsStore = new SettingsStore(path.join(wDir, 'settings.json'))
  const poolUrls = ['http://p1.example:7890', 'http://p2.example:7890']
  const wruntimes = new AccountRuntimes(wConfig)
  const wserver = await startServer({
    config: wConfig,
    runtimes: wruntimes,
    authToken: null,
    authSource: null,
    authEmail: null,
    upstream: null,
    sessions: null,
    userStore,
    webSessions,
    loginFlows,
    proxyStore,
    settingsStore,
  })
  const wport = wserver.address().port
  const lr = await fetch(`http://127.0.0.1:${wport}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret123' }),
  })
  assert.equal(lr.status, 200)
  const cookie = lr.headers.get('set-cookie').split(';')[0]
  const pr = await fetch(`http://127.0.0.1:${wport}/api/accounts/probe`, {
    method: 'POST',
    headers: { cookie },
  })
  assert.equal(pr.status, 200)
  const pj = await pr.json()
  assert.equal(pj.results.length, 1)
  assert.equal(pj.results[0].ok, true)
  assert.equal(pj.accounts[0].email, 'w@example.com')
  // mock GET 返回 status none → 探测后 session 状态可见
  assert.equal(pj.accounts[0].session.status, 'none')
  // 账号凭证：任意已登录用户可查看完整凭据（含 authToken），404 与 401 正确
  {
    const cred = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/credential`, {
      headers: { cookie },
    })
    assert.equal(cred.status, 200)
    const cj = await cred.json()
    assert.equal(cj.ok, true)
    assert.equal(cj.key, 'w')
    assert.equal(cj.credential.email, 'w@example.com')
    assert.equal(cj.credential.authToken, 'token-w')
    assert.equal(cj.credential.id, 'w')

    const missing = await fetch(`http://127.0.0.1:${wport}/api/accounts/nope/credential`, {
      headers: { cookie },
    })
    assert.equal(missing.status, 404)

    const anon = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/credential`)
    assert.equal(anon.status, 401)
  }
  // 运行设置：默认开启，保存关闭后立即返回并持久化，重建 store 仍为关闭
  {
    const getDefault = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      headers: { cookie },
    })
    assert.equal(getDefault.status, 200)
    assert.equal((await getDefault.json()).freeToolSignatureEnabled, true)

    const invalid = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ freeToolSignatureEnabled: 'no' }),
    })
    assert.equal(invalid.status, 400)

    const saveSetting = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ freeToolSignatureEnabled: false }),
    })
    assert.equal(saveSetting.status, 200)
    assert.equal((await saveSetting.json()).freeToolSignatureEnabled, false)
    assert.equal(settingsStore.get().freeToolSignatureEnabled, false)
    assert.equal(
      new SettingsStore(path.join(wDir, 'settings.json')).get()
        .freeToolSignatureEnabled,
      false,
    )
  }
  // 运行设置：账号并发上限（粘性调度）——默认 2，校验非法值，保存后持久化
  {
    const getDefault = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      headers: { cookie },
    })
    assert.equal((await getDefault.json()).accountMaxConcurrency, 2)

    for (const bad of [0, -1, 17, 1.5, 'x']) {
      const res = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ accountMaxConcurrency: bad }),
      })
      assert.equal(res.status, 400, `accountMaxConcurrency=${bad} should be rejected`)
    }

    const save = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accountMaxConcurrency: 4 }),
    })
    assert.equal(save.status, 200)
    assert.equal((await save.json()).accountMaxConcurrency, 4)
    assert.equal(settingsStore.get().accountMaxConcurrency, 4)
    assert.equal(
      new SettingsStore(path.join(wDir, 'settings.json')).get()
        .accountMaxConcurrency,
      4,
    )
    // 恢复默认，避免影响其他用例
    await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accountMaxConcurrency: 1 }),
    })
  }
  // 运行设置：额度保护（空闲释放 + 单请求新会话预算）——非法值拒绝，保存即持久化
  {
    const getDefault = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      headers: { cookie },
    })
    const def = await getDefault.json()
    // 2026-09-13 结论反转：早退 DELETE **会**按实际占用退还 Freebucks，所以默认回到
    // 60s——挂着的空闲会话在按小时计价，早退才把未用时长换回来。
    assert.equal(def.idleReleaseSec, 60, '未保存过时应回落 config.yaml 默认值')
    assert.ok(
      def.idleReleaseSec > 0 && def.idleReleaseSec <= 300,
      '默认空闲释放应在 5s..300s 内：早退会退还未用时长，挂着空闲才是花钱',
    )
    assert.equal(def.maxNewSessionsPerRequest, 2)

    for (const bad of [-1, 'x', null, 999999]) {
      const res = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ idleReleaseSec: bad }),
      })
      assert.equal(res.status, 400, `idleReleaseSec=${bad} should be rejected`)
    }

    // 下限放宽到 5s：1..4 吸附到 5s（避免把每个回合切成一条新会话）
    const tiny = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ idleReleaseSec: 1 }),
    })
    assert.equal(tiny.status, 200)
    assert.equal((await tiny.json()).idleReleaseSec, 5, '1s 应被夹到最小生效值 5s')

    const save = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ idleReleaseSec: 600, maxNewSessionsPerRequest: 3 }),
    })
    assert.equal(save.status, 200)
    assert.equal((await save.json()).idleReleaseSec, 600)
    assert.equal(settingsStore.get().idleReleaseSec, 600)
    assert.equal(settingsStore.get().maxNewSessionsPerRequest, 3)
    const persisted = new SettingsStore(path.join(wDir, 'settings.json')).get()
    assert.equal(persisted.idleReleaseSec, 600, '保存后应持久化到 settings.json')
    assert.equal(persisted.maxNewSessionsPerRequest, 3)
  }
  // 代理管理 API：GET 空池 → POST 保存（持久化 + 立即生效）→ GET 返回
  {
    const g1 = await fetch(`http://127.0.0.1:${wport}/api/proxy`, { headers: { cookie } })
    assert.equal(g1.status, 200)
    assert.deepEqual((await g1.json()).proxies, [])

    const post = await fetch(`http://127.0.0.1:${wport}/api/proxy`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ proxies: ['http://p1.example:7890', 'http://p2.example:7890', '  '] }),
    })
    assert.equal(post.status, 200)
    const pj = await post.json()
    assert.deepEqual(pj.proxies, ['http://p1.example:7890', 'http://p2.example:7890'])
    assert.ok(pj.note)

    // 持久化到 /data/proxies.json，且运行配置已更新
    const saved = JSON.parse(fs.readFileSync(path.join(wDir, 'proxies.json'), 'utf8'))
    assert.deepEqual(saved.proxies, ['http://p1.example:7890', 'http://p2.example:7890'])
    assert.deepEqual(wConfig.upstream.proxies, ['http://p1.example:7890', 'http://p2.example:7890'])

    // 新 runtime 使用新池（invalidateProxies 后重建）
    const rt = wruntimes.get('w')
    assert.ok(poolUrls.includes(rt.effectiveProxy))

    const g2 = await fetch(`http://127.0.0.1:${wport}/api/proxy`, { headers: { cookie } })
    assert.deepEqual((await g2.json()).proxies, ['http://p1.example:7890', 'http://p2.example:7890'])

    // 清空 → 全局池空
    await fetch(`http://127.0.0.1:${wport}/api/proxy`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ proxies: [] }),
    })
    assert.deepEqual(wConfig.upstream.proxies, [])
  }

  // proxy test: 未配置代理 → 空结果
  const pt1 = await fetch(`http://127.0.0.1:${wport}/api/proxy/test`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(pt1.status, 200)
  const ptj1 = await pt1.json()
  assert.equal(ptj1.results.length, 0)
  assert.ok(ptj1.note)
  // proxy test: 死代理 → ok:false + 错误信息（真连接尝试，localhost 立即拒绝）
  const pt2 = await fetch(`http://127.0.0.1:${wport}/api/proxy/test`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ proxy: 'http://127.0.0.1:9' }),
  })
  assert.equal(pt2.status, 200)
  const ptj2 = await pt2.json()
  assert.equal(ptj2.results.length, 1)
  assert.equal(ptj2.results[0].ok, false)
  assert.equal(ptj2.results[0].proxy, 'http://127.0.0.1:9')
  assert.ok(ptj2.results[0].error)
  // 操作列「关闭会话」：用户主动结束该账号的上游计费会话。
  // 三个关键语义：① 成功即无活跃会话 ② 上游删不掉时不得谎报成功、句柄必须保留
  // （留给重启扫尾继续退款）③ 未知账号 404。
  {
    const sm = wruntimes.get('w').sessions
    await sm.ensureSession('deepseek/deepseek-v4-flash')
    assert.ok(sm.getSnapshot().instanceId, '关闭前应有活跃会话')

    const res = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/session`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(res.status, 200, await res.clone().text())
    const j = await res.json()
    assert.equal(j.ok, true, `关闭会话应成功：${JSON.stringify(j)}`)
    assert.equal(j.key, 'w')
    assert.equal(j.interrupted, false, '无在途流时不应标记为中断')
    assert.equal(sm.getSnapshot().status, 'none', '关闭后该账号应无活跃会话')

    // 上游一直删不掉 → ok=false + 带原因，且句柄保留（不得静默丢弃）
    await sm.ensureSession('deepseek/deepseek-v4-flash')
    deleteFailuresLeft = 99
    const bad = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/session`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    })
    const bj = await bad.json()
    assert.equal(bj.ok, false, '删不掉时必须 ok=false')
    assert.ok(bj.error, '失败要带原因')
    assert.ok(sm.getSnapshot().instanceId, '失败后句柄必须保留')
    deleteFailuresLeft = 0
    await sm.release()

    // 未知账号 → 404（且不误伤其它账号）
    const nf = await fetch(`http://127.0.0.1:${wport}/api/accounts/nope/session`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(nf.status, 404, '未知账号应 404')

    // 未登录 → 401
    const anon = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/session`, {
      method: 'POST',
    })
    assert.equal(anon.status, 401, '未登录应 401')
  }

  loginFlows.shutdown()
  await wruntimes.shutdown()
  wserver.close()
  fs.rmSync(wDir, { recursive: true, force: true })
}

// --- quota: extraction + display；已用满的冷账号排到可用冷账号之后 ---
{
  const qDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-quota-'))
  saveAccountUser(qDir, { id: 'qa', email: 'qa@example.com', authToken: 'token-qa' })
  saveAccountUser(qDir, { id: 'qb', email: 'qb@example.com', authToken: 'token-qb' })
  const qConfig = loadConfig()
  qConfig.upstream.credentialsDir = qDir
  qConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(qConfig)
  const mkQuota = (model, limit, used) => {
    const rl = { model, limit, period: 'pacific_day', resetAt: '2026-08-09T07:00:00.000Z', recentCount: used }
    return { byModel: { [model]: rl }, rateLimit: rl, updatedAt: new Date().toISOString() }
  }
  const pa = pool.get('qa')
  const pb = pool.get('qb')
  pa.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 5)
  pb.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 1)

  // 两个账号都有剩余额度时，轮询仅作为同层级的平局处理。
  const order = pool.candidateKeys('openai/gpt-5.6-luna')
  assert.deepEqual(order, ['qa', 'qb'], `expected stable tie-break, got ${order}`)

  // 已用满的冷账号不应先触发一次必败的 admit。
  pa.sessions.quota = mkQuota('openai/gpt-5.6-luna', 6, 6)
  const order2 = pool.candidateKeys('openai/gpt-5.6-luna')
  assert.deepEqual(order2, ['qb', 'qa'], `exhausted account should be last, got ${order2}`)

  // list() surfaces the live quota unchanged, including flash daily limits
  pa.sessions.quota = {
    byModel: {
      'openai/gpt-5.6-luna': mkQuota('openai/gpt-5.6-luna', 6, 5).byModel['openai/gpt-5.6-luna'],
      'deepseek/deepseek-v4-flash': mkQuota('deepseek/deepseek-v4-flash', 6, 6).byModel['deepseek/deepseek-v4-flash'],
      'mimo/mimo-v2.5': mkQuota('mimo/mimo-v2.5', 6, 4.8).byModel['mimo/mimo-v2.5'],
    },
    rateLimit: null,
    updatedAt: new Date().toISOString(),
  }
  pb.sessions.quota = {
    byModel: {
      'openai/gpt-5.6-luna': mkQuota('openai/gpt-5.6-luna', 6, 1).byModel['openai/gpt-5.6-luna'],
      'deepseek/deepseek-v4-flash': mkQuota('deepseek/deepseek-v4-flash', 6, 6).byModel['deepseek/deepseek-v4-flash'],
      'mimo/mimo-v2.5': mkQuota('mimo/mimo-v2.5', 6, 4.8).byModel['mimo/mimo-v2.5'],
    },
    rateLimit: null,
    updatedAt: new Date().toISOString(),
  }
  const rows = pool.list()
  const rowB = rows.find((x) => x.email === 'qb@example.com')
  assert.equal(rowB.quota.byModel['openai/gpt-5.6-luna'].recentCount, 1)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].limit, 6)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].recentCount, 6)
  assert.equal(rowB.quota.byModel['deepseek/deepseek-v4-flash'].unlimited, undefined)
  assert.equal(rowB.quota.byModel['mimo/mimo-v2.5'].limit, 6)
  assert.equal(rowB.quota.byModel['mimo/mimo-v2.5'].recentCount, 4.8)
  assert.equal(rowB.quota.byModel['mimo/mimo-v2.5'].unlimited, undefined)
  assert.equal(rowB.quota.byModel['openai/gpt-5.6-luna'].unlimited, undefined)
  assert.equal(typeof rowB.requests, 'number')
  await pool.shutdown()
  fs.rmSync(qDir, { recursive: true, force: true })
}

// --- session-first：conversation_id 不参与选号，同模型热 session 始终复用 ---
{
  const convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-conv-'))
  saveAccountUser(convDir, { id: 'da', email: 'da@example.com', authToken: 'token-da' })
  saveAccountUser(convDir, { id: 'db', email: 'db@example.com', authToken: 'token-db' })
  saveAccountUser(convDir, { id: 'dc', email: 'dc@example.com', authToken: 'token-dc' })
  const convConfig = loadConfig()
  convConfig.server.host = '127.0.0.1'
  convConfig.server.port = 0
  convConfig.server.apiKeys = ['sk-test']
  convConfig.upstream.credentialsDir = convDir
  convConfig.session.pollIntervalSec = 3600
  const convRuntimes = new AccountRuntimes(convConfig)
  const convServer = await startServer({
    config: convConfig,
    runtimes: convRuntimes,
    ...(() => {
      const rt = convRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const convPort = convServer.address().port

  // 同一会话 key 连续 6 次只创建并复用一个上游 session。
  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const seen = []
  let res
  for (let i = 0; i < 6; i++) {
    res = await fetch(`http://127.0.0.1:${convPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        codebuff_metadata: { conversation_id: 'same-thread-forever' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    seen.push(res.headers.get('x-freebuff-proxy-account'))
  }
  assert.deepEqual(
    seen,
    [
      'da@example.com',
      'da@example.com',
      'da@example.com',
      'da@example.com',
      'da@example.com',
      'da@example.com',
    ],
    `恒定会话 key 应复用热 session, got ${JSON.stringify(seen)}`,
  )
  assert.equal(sessionPosts, 1, `expected one admission, got ${sessionPosts}`)
  // 同一会话不应再回传会话 key 响应头（无会话分组概念）
  assert.equal(res.headers.get('x-freebuff-proxy-conv-key'), null)

  // 当前账号冷却后才切到下一个账号，并复用新 session。
  convRuntimes.markCooldown('da', {
    code: 'rate_limited',
    retryAfterMs: 60_000,
  })
  const afterCool = []
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`http://127.0.0.1:${convPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        codebuff_metadata: { conversation_id: 'same-thread-forever' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    afterCool.push(res.headers.get('x-freebuff-proxy-account'))
  }
  assert.deepEqual(afterCool, ['db@example.com', 'db@example.com'])
  assert.equal(sessionPosts, 2, `failover should add one admission, got ${sessionPosts}`)

  await convRuntimes.shutdown()
  convServer.close()
  fs.rmSync(convDir, { recursive: true, force: true })
}

// 无会话ID 的并发请求：粘性调度 + 每账号并发上限 1 → 全部挤在同一账号上排队，
// 不主动开新账号（换号 = 多买一条 Freebucks 计费会话）
{
  const rrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-rr-'))
  saveAccountUser(rrDir, { id: 'ra', email: 'ra@example.com', authToken: 'token-ra' })
  saveAccountUser(rrDir, { id: 'rb', email: 'rb@example.com', authToken: 'token-rb' })
  saveAccountUser(rrDir, { id: 'rc', email: 'rc@example.com', authToken: 'token-rc' })
  const rrConfig = loadConfig()
  rrConfig.server.host = '127.0.0.1'
  rrConfig.server.port = 0
  rrConfig.server.apiKeys = ['sk-test']
  rrConfig.upstream.credentialsDir = rrDir
  rrConfig.session.pollIntervalSec = 3600
  rrConfig.limits.maxConcurrentRequests = 24
  const rrRuntimes = new AccountRuntimes(rrConfig, {
    getAccountConcurrency: () => 1,
  })

  // 慢流 mock：每流 ~300ms，保证并发期间锁一直占用，选号结果确定
  let rrActive = 0
  let rrActiveMax = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return origFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        let closed = false
        rrActive++
        if (rrActive > rrActiveMax) rrActiveMax = rrActive
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            async function emit(i) {
              if (i >= 4 || closed) {
                rrActive = Math.max(0, rrActive - 1)
                if (!closed) controller.close()
                return
              }
              controller.enqueue(enc.encode(`data: {"x":"${i}"}\n\n`))
              await new Promise((r) => setTimeout(r, 100))
              emit(i + 1)
            }
            emit(0)
          },
          cancel() {
            closed = true
            rrActive = Math.max(0, rrActive - 1)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return jsonRes({
        id: 'c1', object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      })
    }
    return origFetch(url, init)
  }

  const rrServer = await startServer({
    config: rrConfig,
    runtimes: rrRuntimes,
    ...(() => {
      const rt = rrRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const rrPort = rrServer.address().port
  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  const concurrent = await Promise.all(
    Array.from({ length: 9 }, () => fetch(`http://127.0.0.1:${rrPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })),
  )
  const rrAccounts = []
  for (const res of concurrent) {
    assert.equal(res.status, 200, await res.clone().text())
    rrAccounts.push(res.headers.get('x-freebuff-proxy-account'))
  }
  // 粘性优先：9 条并发全部挤在 ra 上（有界排队），单账号同时最多 1 条流，
  // 不为了并发去启用从未用过的 rb / rc
  assert.deepEqual(
    [...new Set(rrAccounts)],
    ['ra@example.com'],
    `并发请求应粘在同一账号, got ${JSON.stringify(rrAccounts)}`,
  )
  assert.equal(sessionPosts, 1, `只应 admit 一次, got ${sessionPosts}`)
  assert.equal(rrActiveMax, 1, `单账号并发上限 1 → 上游并发峰值应为 1, got ${rrActiveMax}`)
  const rrRows = rrRuntimes.list()
  assert.equal(rrRows.find((r) => r.key === 'ra').used, true, 'ra 应标记已用')
  assert.equal(rrRows.find((r) => r.key === 'rb').used, false, 'rb 不应被启用')
  assert.equal(rrRows.find((r) => r.key === 'rc').used, false, 'rc 不应被启用')
  // 满员账号仍排在未用过账号之前（先排队；只有排队超时被 skipKeys 排除后才溢出）
  assert.deepEqual(
    rrRuntimes.candidateKeys('deepseek/deepseek-v4-flash'),
    ['ra', 'rb', 'rc'],
    '满员的已用账号应排在未用过账号之前',
  )
  assert.deepEqual(
    rrRuntimes.candidateKeys('deepseek/deepseek-v4-flash', {
      skipKeys: new Set(['ra']),
    }),
    ['rb', 'rc'],
    '排队超时后应把该账号排除，溢出到下一个',
  )

  globalThis.fetch = origFetch
  await rrRuntimes.shutdown()
  rrServer.close()
  fs.rmSync(rrDir, { recursive: true, force: true })
}

// sub2api 场景：恒定 user 不参与选号，仍复用同模型热 session
{
  const subDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-sub2api-'))
  saveAccountUser(subDir, { id: 'sa', email: 'sa@example.com', authToken: 'token-sa' })
  saveAccountUser(subDir, { id: 'sb', email: 'sb@example.com', authToken: 'token-sb' })
  saveAccountUser(subDir, { id: 'sc', email: 'sc@example.com', authToken: 'token-sc' })
  const subConfig = loadConfig()
  subConfig.server.host = '127.0.0.1'
  subConfig.server.port = 0
  subConfig.server.apiKeys = ['sk-test']
  subConfig.upstream.credentialsDir = subDir
  subConfig.session.pollIntervalSec = 3600
  const subRuntimes = new AccountRuntimes(subConfig)
  const subServer = await startServer({
    config: subConfig,
    runtimes: subRuntimes,
    ...(() => {
      const rt = subRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const subPort = subServer.address().port
  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const seenAccounts = new Map()
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`http://127.0.0.1:${subPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        user: 'sub2api-fixed-user', // 恒定 user，不应成为会话 key
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    const acc = res.headers.get('x-freebuff-proxy-account')
    seenAccounts.set(acc, (seenAccounts.get(acc) || 0) + 1)
    // 无会话分组：请求头也不回传 conv-key
    assert.equal(res.headers.get('x-freebuff-proxy-conv-key'), null)
  }
  assert.equal(seenAccounts.get('sa@example.com'), 6)
  assert.equal(seenAccounts.get('sb@example.com'), undefined)
  assert.equal(seenAccounts.get('sc@example.com'), undefined)
  assert.equal(sessionPosts, 1, `expected one admission, got ${sessionPosts}`)
  await subRuntimes.shutdown()
  subServer.close()
  fs.rmSync(subDir, { recursive: true, force: true })
}

// 上游 500 报错 → 冷却当前账号并换号重试
{
  const e5Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-e500-'))
  saveAccountUser(e5Dir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(e5Dir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const e5Config = loadConfig()
  e5Config.server.host = '127.0.0.1'
  e5Config.server.port = 0
  e5Config.server.apiKeys = ['sk-test']
  e5Config.upstream.credentialsDir = e5Dir
  e5Config.session.pollIntervalSec = 3600
  const e5Runtimes = new AccountRuntimes(e5Config)
  const e5Server = await startServer({
    config: e5Config,
    runtimes: e5Runtimes,
    ...(() => {
      const rt = e5Runtimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const e5Port = e5Server.address().port
  mockMode = 'err_500_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${e5Port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  assert.equal(completionAttempts, 2)
  const e5Accounts = e5Runtimes.list()
  const e5a = e5Accounts.find((x) => x.email === 'a@example.com')
  assert.equal(e5a.available, false)
  assert.equal(e5a.cooldownCode, 'internal_error')
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  await e5Runtimes.shutdown()
  e5Server.close()
  fs.rmSync(e5Dir, { recursive: true, force: true })
  mockMode = 'ok'
}

// free_mode_capacity_deferred → 同一热 session 重试且不冷却
{
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-cap-'))
  saveAccountUser(capDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(capDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const capConfig = loadConfig()
  capConfig.server.host = '127.0.0.1'
  capConfig.server.port = 0
  capConfig.server.apiKeys = ['sk-test']
  capConfig.upstream.credentialsDir = capDir
  capConfig.session.pollIntervalSec = 3600
  const capRuntimes = new AccountRuntimes(capConfig)
  const capServer = await startServer({
    config: capConfig,
    runtimes: capRuntimes,
    ...(() => {
      const rt = capRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const capPort = capServer.address().port
  mockMode = 'capacity_once'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${capPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  // 实测同一 session 立即重试可恢复，无需为瞬时容量再开一个 session。
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'a@example.com')
  assert.equal(sessionPosts, 1, `capacity retry should reuse session, got ${sessionPosts}`)
  const capAccounts = capRuntimes.list()
  assert.equal(
    capAccounts.find((x) => x.email === 'a@example.com').available,
    true,
    'capacity_deferred 不应冷却账号',
  )
  assert.equal(capAccounts.find((x) => x.email === 'b@example.com').available, true)
  await capRuntimes.shutdown()
  capServer.close()
  fs.rmSync(capDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// 持续 capacity_deferred → 返回错误但不冷却（下次请求仍可复用）
{
  const capDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-cap2-'))
  saveAccountUser(capDir2, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(capDir2, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const capConfig2 = loadConfig()
  capConfig2.server.host = '127.0.0.1'
  capConfig2.server.port = 0
  capConfig2.server.apiKeys = ['sk-test']
  capConfig2.upstream.credentialsDir = capDir2
  capConfig2.session.pollIntervalSec = 3600
  const capRuntimes2 = new AccountRuntimes(capConfig2)
  const capServer2 = await startServer({
    config: capConfig2,
    runtimes: capRuntimes2,
    ...(() => {
      const rt = capRuntimes2.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const capPort2 = capServer2.address().port
  mockMode = 'capacity_all'
  sessionPosts = 0
  completionAttempts = 0
  const res2 = await fetch(`http://127.0.0.1:${capPort2}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res2.status, 429)
  const capAccounts2 = capRuntimes2.list()
  assert.equal(
    capAccounts2.every((x) => x.available),
    true,
    '全部 capacity_deferred 也不应冷却任何账号',
  )
  await capRuntimes2.shutdown()
  capServer2.close()
  fs.rmSync(capDir2, { recursive: true, force: true })
  mockMode = 'ok'
}

// startAgentRun 500 → 冷却当前账号换下一个，最终成功
{
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-run500-'))
  saveAccountUser(runDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(runDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const runConfig = loadConfig()
  runConfig.server.host = '127.0.0.1'
  runConfig.server.port = 0
  runConfig.server.apiKeys = ['sk-test']
  runConfig.upstream.credentialsDir = runDir
  runConfig.session.pollIntervalSec = 3600
  const runRuntimes = new AccountRuntimes(runConfig)
  const runServer = await startServer({
    config: runConfig,
    runtimes: runRuntimes,
    ...(() => {
      const rt = runRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const runPort = runServer.address().port
  mockMode = 'run_500_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${runPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  const runAccounts = runRuntimes.list()
  const runA = runAccounts.find((x) => x.email === 'a@example.com')
  assert.equal(runA.available, false)
  assert.equal(runA.cooldownCode, 'start_agent_run_failed')
  await runRuntimes.shutdown()
  runServer.close()
  fs.rmSync(runDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// startAgentRun 403（start_agent_run_failed，非账号级封禁 code）→ 也应冷却
// 当前账号换下一个，最终成功（回归：403 不在换号条件内，曾不换号、首次即报错给用户）
{
  const run403Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-run403-'))
  saveAccountUser(run403Dir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(run403Dir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const run403Config = loadConfig()
  run403Config.server.host = '127.0.0.1'
  run403Config.server.port = 0
  run403Config.server.apiKeys = ['sk-test']
  run403Config.upstream.credentialsDir = run403Dir
  run403Config.session.pollIntervalSec = 3600
  const run403Runtimes = new AccountRuntimes(run403Config)
  const run403Server = await startServer({
    config: run403Config,
    runtimes: run403Runtimes,
    ...(() => {
      const rt = run403Runtimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const run403Port = run403Server.address().port
  mockMode = 'run_403_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${run403Port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  const run403Accounts = run403Runtimes.list()
  const run403A = run403Accounts.find((x) => x.email === 'a@example.com')
  assert.equal(run403A.available, false)
  assert.equal(run403A.cooldownCode, 'start_agent_run_failed')
  await run403Runtimes.shutdown()
  run403Server.close()
  fs.rmSync(run403Dir, { recursive: true, force: true })
  mockMode = 'ok'
}

// 网络错误（fetch 抛异常）→ 换号重试，最终成功
{
  const netDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-net-'))
  saveAccountUser(netDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(netDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const netConfig = loadConfig()
  netConfig.server.host = '127.0.0.1'
  netConfig.server.port = 0
  netConfig.server.apiKeys = ['sk-test']
  netConfig.upstream.credentialsDir = netDir
  netConfig.session.pollIntervalSec = 3600
  const netRuntimes = new AccountRuntimes(netConfig)
  const netServer = await startServer({
    config: netConfig,
    runtimes: netRuntimes,
    ...(() => {
      const rt = netRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const netPort = netServer.address().port
  mockMode = 'network_err_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${netPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  assert.equal(sessionPosts, 2, `expected 2 session POSTs, got ${sessionPosts}`)
  await netRuntimes.shutdown()
  netServer.close()
  fs.rmSync(netDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// 同账号 gate 连续失败两次 → 升级为换号，最终成功
{
  const g2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-gate2-'))
  saveAccountUser(g2Dir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(g2Dir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  const g2Config = loadConfig()
  g2Config.server.host = '127.0.0.1'
  g2Config.server.port = 0
  g2Config.server.apiKeys = ['sk-test']
  g2Config.upstream.credentialsDir = g2Dir
  g2Config.session.pollIntervalSec = 3600
  const g2Runtimes = new AccountRuntimes(g2Config)
  const g2Server = await startServer({
    config: g2Config,
    runtimes: g2Runtimes,
    ...(() => {
      const rt = g2Runtimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const g2Port = g2Server.address().port
  mockMode = 'gate_twice_a'
  sessionPosts = 0
  completionAttempts = 0
  calls = []
  const res = await fetch(`http://127.0.0.1:${g2Port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(res.headers.get('x-freebuff-proxy-account'), 'b@example.com')
  // a 两次 gate（1 次会话 + 1 次同号 re-admit），b 一次 → 3 次 session POST、3 次 completions
  assert.equal(sessionPosts, 3, `expected 3 session POSTs, got ${sessionPosts}`)
  assert.equal(completionAttempts, 3, `expected 3 completions, got ${completionAttempts}`)
  const g2Accounts = g2Runtimes.list()
  const g2a = g2Accounts.find((x) => x.email === 'a@example.com')
  assert.equal(g2a.available, false)
  assert.equal(g2a.cooldownCode, 'session_superseded')
  await g2Runtimes.shutdown()
  g2Server.close()
  fs.rmSync(g2Dir, { recursive: true, force: true })
  mockMode = 'ok'
}




// --- 幽灵连接：上游流 idle 超时（zero bytes 未落地）→ 换号重试 ---
{
  const stDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-stall-'))
  saveAccountUser(stDir, { id: 'sa', email: 'sa@example.com', authToken: 'token-sa' })
  saveAccountUser(stDir, { id: 'sb', email: 'sb@example.com', authToken: 'token-sb' })
  const stConfig = loadConfig()
  stConfig.server.host = '127.0.0.1'
  stConfig.server.port = 0
  stConfig.server.apiKeys = ['sk-test']
  stConfig.upstream.credentialsDir = stDir
  stConfig.session.pollIntervalSec = 3600
  stConfig.limits.streamIdleTimeoutSec = 1

  const stRuntimes = new AccountRuntimes(stConfig)
  const stServer = await startServer({
    config: stConfig,
    runtimes: stRuntimes,
    ...(() => {
      const rt = stRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const stPort = stServer.address().port

  // spa 的流式响应只开不关（幽灵连接，一个字节都不吐）→ 连接被掐断而不是永远挂着
  mockMode = 'stall_zero'
  sessionPosts = 0
  completionAttempts = 0
  const started = Date.now()
  let stRes
  try {
    stRes = await fetch(`http://127.0.0.1:${stPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
    })
    let stBody = ''
    try { stBody = await stRes.text() } catch { stBody = '' }
    assert.ok(
      stBody.trim() === '' || stBody.includes('hi') || stBody.includes('hello'),
      `unexpected body: ${stBody.slice(0, 60)}`,
    )
  } catch (fetchErr) {
    // 连接被掐断导致 fetch 直接失败也符合预期（不挂死即可）
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed < 30_000, `stall zero test took too long: ${elapsed}ms`)

  // 幽灵连接（流 idle 超时被掐断）→ 账号短暂冷却（stallCooldownSec 默认 30s）：
  // 该账号刚被掐断过一条卡死链路，下一请求应切到另一个账号，而不是继续撞同一条链路。
  mockMode = 'ok'
  const stRes2 = await fetch(`http://127.0.0.1:${stPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(stRes2.status, 200, await stRes2.clone().text())
  assert.ok(stRes2.headers.get('x-freebuff-proxy-account'), 'expected an account')
  assert.equal(sessionPosts, 2, `stall 后应切换到另一账号重新 admit, got ${sessionPosts}`)
  assert.equal(
    stRuntimes.list().find((x) => x.email === 'sa@example.com').available,
    false,
    '被掐断的账号应短暂冷却',
  )
  await stRuntimes.shutdown()
  stServer.close()
  fs.rmSync(stDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// --- 幽灵连接：上游流 idle 超时（partial bytes 已落地）→ 冷却当前账号 + 断开连接 ---
//   后续请求应切到另一个可用账号
{
  const spDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-stall-partial-'))
  saveAccountUser(spDir, { id: 'spa', email: 'spa@example.com', authToken: 'token-spa' })
  saveAccountUser(spDir, { id: 'spb', email: 'spb@example.com', authToken: 'token-spb' })
  const spConfig = loadConfig()
  spConfig.server.host = '127.0.0.1'
  spConfig.server.port = 0
  spConfig.server.apiKeys = ['sk-test']
  spConfig.upstream.credentialsDir = spDir
  spConfig.session.pollIntervalSec = 3600
  spConfig.limits.streamIdleTimeoutSec = 1
  // stallCooldownSec=0：关闭掐断后的冷却（保留旧行为可配置）——验证该开关
  // 关闭时，幽灵连接只断开连接、下一请求仍可复用同一会话
  spConfig.limits.stallCooldownSec = 0

  const spRuntimes = new AccountRuntimes(spConfig)
  const spServer = await startServer({
    config: spConfig,
    runtimes: spRuntimes,
    ...(() => {
      const rt = spRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const spPort = spServer.address().port

  // 第一个请求打到 spa：partial stall（已下发部分字节后卡死）→ 连接被掐断，
  // 客户端收到截断的 SSE 而不是永远挂着
  mockMode = 'stall_partial'
  sessionPosts = 0
  completionAttempts = 0
  const spStart = Date.now()
  const spRes1 = await fetch(`http://127.0.0.1:${spPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  let spText1 = ''
  try { spText1 = await spRes1.text() } catch { spText1 = '' }
  assert.ok(
    spText1.trim() === '' || spText1.includes('hi'),
    `expected truncated SSE body, got: ${spText1.slice(0, 60)}`,
  )
  assert.ok(Date.now() - spStart < 30_000, `partial stall test took too long: ${Date.now() - spStart}ms`)

  // 幽灵连接不冷却同账号（只是断开连接）；第二个请求仍可复用同一会话
  mockMode = 'ok'
  const spRes2 = await fetch(`http://127.0.0.1:${spPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(spRes2.status, 200, await spRes2.clone().text())
  const spAccount = spRes2.headers.get('x-freebuff-proxy-account')
  assert.ok(spAccount, `expected an account, got empty`)
  assert.equal(sessionPosts, 1, `should reuse one session, got ${sessionPosts}`)

  await spRuntimes.shutdown()
  spServer.close()
  fs.rmSync(spDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// --- 账号并发上限=1（慢流场景）：单账号同时 1 条流，满员即换号 ---
{
  const scDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-serial-'))
  saveAccountUser(scDir, { id: 'sca', email: 'sca@example.com', authToken: 'token-sca' })
  saveAccountUser(scDir, { id: 'scb', email: 'scb@example.com', authToken: 'token-scb' })
  const scConfig = loadConfig()
  scConfig.server.host = '127.0.0.1'
  scConfig.server.port = 0
  scConfig.server.apiKeys = ['sk-test']
  scConfig.upstream.credentialsDir = scDir
  scConfig.session.pollIntervalSec = 3600
  scConfig.limits.maxConcurrentRequests = 12

  const scRuntimes = new AccountRuntimes(scConfig, {
    getAccountConcurrency: () => 1,
  })
  const scServer = await startServer({
    config: scConfig,
    runtimes: scRuntimes,
    ...(() => {
      const rt = scRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const scPort = scServer.address().port

  // 慢流 mock：每次 chunk 延迟 ~100ms，总时长 ~800ms；记录并发峰值
  let streamActive = 0
  let streamActiveMax = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return origFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        let closed = false
        streamActive++
        if (streamActive > streamActiveMax) streamActiveMax = streamActive
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            const chunks = [
              'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"h"}}]}\n\n',
              'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"delta":{"content":"i"}}]}\n\n',
              'data: {"id":"c3","object":"chat.completion.chunk","choices":[{"delta":{"content":"!"}}]}\n\n',
              'data: [DONE]\n\n',
            ]
            async function emit(i) {
              if (i >= chunks.length || closed) {
                streamActive = Math.max(0, streamActive - 1)
                if (!closed) controller.close()
                return
              }
              controller.enqueue(enc.encode(chunks[i]))
              await new Promise((r) => setTimeout(r, 100))
              emit(i + 1)
            }
            emit(0)
          },
          cancel() {
            closed = true
            streamActive = Math.max(0, streamActive - 1)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      // 非 stream 模式立刻完成
      return jsonRes({
        id: 'c1', object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      })
    }
    return origFetch(url, init)
  }

  mockMode = 'ok'
  streamActive = 0
  streamActiveMax = 0
  sessionPosts = 0
  completionAttempts = 0

  // 6 个并发 stream 请求
  const scReq = Array.from({ length: 6 }, () =>
    fetch(`http://127.0.0.1:${scPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
  )
  const scResponses = await Promise.all(scReq)
  const scAccounts = []
  for (const r of scResponses) {
    assert.equal(r.status, 200, await r.clone().text())
    const accountHeader = r.headers.get('x-freebuff-proxy-account')
    scAccounts.push(accountHeader)
  }
  // 粘性优先：单账号并发上限 1 → 6 条流全部排在 sca 上（不启用第二个账号）
  assert.equal(new Set(scAccounts).size, 1, `expected one sticky account, got ${JSON.stringify(scAccounts)}`)
  assert.equal(sessionPosts, 1, `expected one admission, got ${sessionPosts}`)
  assert.equal(streamActiveMax, 1, `expected max 1 concurrent stream, got ${streamActiveMax}`)

  globalThis.fetch = origFetch
  await scRuntimes.shutdown()
  scServer.close()
  fs.rmSync(scDir, { recursive: true, force: true })
}

// --- 账号并发上限：一个账号可同时转发 N 条 SSE 流；满了换到下一个账号 ---
{
  const ccDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-cc-'))
  saveAccountUser(ccDir, { id: 'cca', email: 'cca@example.com', authToken: 'token-cca' })
  saveAccountUser(ccDir, { id: 'ccb', email: 'ccb@example.com', authToken: 'token-ccb' })
  const ccConfig = loadConfig()
  ccConfig.server.host = '127.0.0.1'
  ccConfig.server.port = 0
  ccConfig.server.apiKeys = ['sk-test']
  ccConfig.upstream.credentialsDir = ccDir
  ccConfig.session.pollIntervalSec = 3600
  ccConfig.limits.maxConcurrentRequests = 12
  // 模拟控制台把每账号并发上限调到 2
  const ccRuntimes = new AccountRuntimes(ccConfig, {
    getAccountConcurrency: () => 2,
  })
  const ccServer = await startServer({
    config: ccConfig,
    runtimes: ccRuntimes,
    ...(() => {
      const rt = ccRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const ccPort = ccServer.address().port

  let streamActive = 0
  let streamActiveMax = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return origFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        let closed = false
        streamActive++
        if (streamActive > streamActiveMax) streamActiveMax = streamActive
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            const chunks = ['h', 'i', '!', '\n']
            async function emit(i) {
              if (i >= chunks.length || closed) {
                streamActive = Math.max(0, streamActive - 1)
                if (!closed) controller.close()
                return
              }
              controller.enqueue(enc.encode(`data: {"x":"${chunks[i]}"}\n\n`))
              await new Promise((r) => setTimeout(r, 100))
              emit(i + 1)
            }
            emit(0)
          },
          cancel() {
            closed = true
            streamActive = Math.max(0, streamActive - 1)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return jsonRes({
        id: 'c1', object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      })
    }
    return origFetch(url, init)
  }

  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  const ccReqs = Array.from({ length: 6 }, () =>
    fetch(`http://127.0.0.1:${ccPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
  )
  const ccResponses = await Promise.all(ccReqs)
  const ccAccounts = []
  for (const r of ccResponses) {
    assert.equal(r.status, 200, await r.clone().text())
    ccAccounts.push(r.headers.get('x-freebuff-proxy-account'))
  }
  // 粘性优先：每账号并发上限 2 → 6 条流全部挤在 cca 上（2 条并行、其余排队），
  // 不主动启用第二个账号（只有排队超时才溢出）
  assert.equal(new Set(ccAccounts).size, 1, `expected one sticky account, got ${JSON.stringify(ccAccounts)}`)
  assert.equal(sessionPosts, 1, `expected one admission, got ${sessionPosts}`)
  assert.equal(streamActiveMax, 2, `expected max 2 concurrent streams, got ${streamActiveMax}`)
  // 监控字段：账号行带 在途/上限
  const ccRow = ccRuntimes.list().find((x) => x.email === 'cca@example.com')
  assert.equal(ccRow.concurrency, 2)
  assert.ok(Number.isInteger(ccRow.inFlight) && ccRow.inFlight <= 2)

  globalThis.fetch = origFetch
  await ccRuntimes.shutdown()
  ccServer.close()
  fs.rmSync(ccDir, { recursive: true, force: true })
}

// --- regression: spread 关 + 并发上限 3 → 满了换号，不把并发钉死在一个账号 ---
// 用户场景：关闭免费模型分散（模型实际已收费），上限设 3；并发超出 3 时必须
// 换到下一个有空闲槽位的账号，而不是在满员账号上无限排队。
{
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-capspill-'))
  saveAccountUser(capDir, { id: 'cpa', email: 'cpa@example.com', authToken: 'token-cpa' })
  saveAccountUser(capDir, { id: 'cpb', email: 'cpb@example.com', authToken: 'token-cpb' })
  const capConfig = loadConfig()
  capConfig.server.host = '127.0.0.1'
  capConfig.server.port = 0
  capConfig.server.apiKeys = ['sk-test']
  capConfig.upstream.credentialsDir = capDir
  capConfig.session.pollIntervalSec = 3600
  capConfig.limits.maxConcurrentRequests = 12
  const capRuntimes = new AccountRuntimes(capConfig, {
    getAccountConcurrency: () => 3,   // 用户设置的每账号并发上限
  })
  const capServer = await startServer({
    config: capConfig,
    runtimes: capRuntimes,
    ...(() => {
      const rt = capRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const capPort = capServer.address().port

  let streamActive = 0
  let streamActiveMax = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return origFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        let closed = false
        streamActive++
        if (streamActive > streamActiveMax) streamActiveMax = streamActive
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            async function emit(i) {
              if (i >= 5 || closed) {
                streamActive = Math.max(0, streamActive - 1)
                if (!closed) controller.close()
                return
              }
              controller.enqueue(enc.encode(`data: {"x":"${i}"}\n\n`))
              await new Promise((r) => setTimeout(r, 100))
              emit(i + 1)
            }
            emit(0)
          },
          cancel() {
            closed = true
            streamActive = Math.max(0, streamActive - 1)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return jsonRes({
        id: 'c1', object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      })
    }
    return origFetch(url, init)
  }

  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  // 8 个并发流，上限 3 → 全部挤在 cpa（3 并行 + 其余排队），不启用第二个账号
  const capReqs = Array.from({ length: 8 }, () =>
    fetch(`http://127.0.0.1:${capPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
  )
  const capResponses = await Promise.all(capReqs)
  const capAccounts = []
  for (const r of capResponses) {
    assert.equal(r.status, 200, await r.clone().text())
    capAccounts.push(r.headers.get('x-freebuff-proxy-account'))
  }
  const byEmail = {}
  for (const a of capAccounts) byEmail[a] = (byEmail[a] || 0) + 1
  // 核心断言：粘性优先——8 条流全在 cpa 上（3 条并行 + 排队），
  // 不为了并发去启用从未用过的 cpb（换号 = 多买一条 Freebucks 计费会话）
  assert.deepEqual(byEmail, { 'cpa@example.com': 8 }, `应全部粘在 cpa, got ${JSON.stringify(byEmail)}`)
  assert.equal(sessionPosts, 1, `只应 admit 一次, got ${sessionPosts}`)
  assert.equal(streamActiveMax, 3, `单账号并发上限 3 → 上游并发峰值应为 3, got ${streamActiveMax}`)
  assert.equal(
    capRuntimes.list().find((r) => r.key === 'cpb').used,
    false,
    'cpb 不应被启用',
  )

  // 冷态顺序请求仍复用热 session（不无谓 admit）：
  sessionPosts = 0
  const seq = await fetch(`http://127.0.0.1:${capPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(seq.status, 200, await seq.clone().text())
  assert.equal(sessionPosts, 0, `热 session 复用：顺序请求不应再 admit, got ${sessionPosts}`)

  globalThis.fetch = origFetch
  await capRuntimes.shutdown()
  capServer.close()
  fs.rmSync(capDir, { recursive: true, force: true })
}

// --- regression: 调度模式 spread（并发优先）→ 满员立刻换号，启用第二个账号 ---
// 用户场景：设了「每账号并发 2」却看到 4 个在途全挤在一个账号上。spread 模式下
// 排序把"有空闲槽位"提到最前，满员账号不再压住空闲账号；且 busy 必须排在
// used **之前**（否则"已用但满员"会一直压住"空闲但从未用过"的号）。
{
  const sdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-spread-'))
  saveAccountUser(sdDir, { id: 'sda', email: 'sda@example.com', authToken: 'token-sda' })
  saveAccountUser(sdDir, { id: 'sdb', email: 'sdb@example.com', authToken: 'token-sdb' })
  const sdConfig = loadConfig()
  sdConfig.server.host = '127.0.0.1'
  sdConfig.server.port = 0
  sdConfig.server.apiKeys = ['sk-test']
  sdConfig.upstream.credentialsDir = sdDir
  sdConfig.session.pollIntervalSec = 3600
  sdConfig.limits.maxConcurrentRequests = 12
  let sdMode = 'spread'
  const sdRuntimes = new AccountRuntimes(sdConfig, {
    getAccountConcurrency: () => 2,
    getSchedulingMode: () => sdMode,
  })
  const sdServer = await startServer({
    config: sdConfig,
    runtimes: sdRuntimes,
    ...(() => {
      const rt = sdRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const sdPort = sdServer.address().port

  // 按账号分别统计并发峰值：断言的是"单账号不超过上限"，而不是全局并发
  // （全局 4 路是预期的，两个账号各 2 路）。
  const sdActiveByToken = new Map()
  const sdPeakByToken = new Map()
  const sdOrigFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return sdOrigFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        const headers = init.headers || {}
        const token =
          (headers.Authorization || headers.authorization || 'unknown')
            .replace('Bearer ', '')
        let closed = false
        const bump = (d) => {
          const cur = Math.max(0, (sdActiveByToken.get(token) || 0) + d)
          sdActiveByToken.set(token, cur)
          if (cur > (sdPeakByToken.get(token) || 0)) sdPeakByToken.set(token, cur)
        }
        bump(1)
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            async function emit(i) {
              if (i >= 5 || closed) {
                bump(-1)
                if (!closed) controller.close()
                return
              }
              controller.enqueue(enc.encode(`data: {"x":"${i}"}\n\n`))
              await new Promise((r) => setTimeout(r, 100))
              emit(i + 1)
            }
            emit(0)
          },
          cancel() {
            closed = true
            bump(-1)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
    }
    return sdOrigFetch(url, init)
  }

  mockMode = 'ok'
  sessionPosts = 0
  completionAttempts = 0
  // 4 个并发流、每账号上限 2 → spread 必须铺到**两个**账号上（各 2 路）
  const sdReqs = Array.from({ length: 4 }, () =>
    fetch(`http://127.0.0.1:${sdPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
  )
  const sdResponses = await Promise.all(sdReqs)
  const sdAccounts = []
  for (const r of sdResponses) {
    assert.equal(r.status, 200, await r.clone().text())
    sdAccounts.push(r.headers.get('x-freebuff-proxy-account'))
  }
  const sdByEmail = {}
  for (const a of sdAccounts) sdByEmail[a] = (sdByEmail[a] || 0) + 1
  // 核心断言：4 路并发 + 上限 2 → 两个账号各 2 路（不再全挤在一个号上）
  assert.equal(Object.keys(sdByEmail).length, 2, `spread 应铺到 2 个账号, got ${JSON.stringify(sdByEmail)}`)
  assert.equal(sdByEmail['sda@example.com'] || 0, 2, `sda 应 2 路, got ${JSON.stringify(sdByEmail)}`)
  assert.equal(sdByEmail['sdb@example.com'] || 0, 2, `sdb 应 2 路, got ${JSON.stringify(sdByEmail)}`)
  // 每个账号的峰值都必须 <= 上限 2（并发真的铺开了，但没超上限）
  for (const [token, peak] of sdPeakByToken) {
    assert.ok(peak <= 2, `账号 ${token} 并发峰值应 <=2, got ${peak}`)
  }
  assert.equal(sdPeakByToken.size, 2, '两个账号都应被真正用上')
  // 两个账号各 admit 一次（每账号一条会话，不多买）
  assert.equal(sessionPosts, 2, `两个账号各 admit 一次, got ${sessionPosts}`)

  globalThis.fetch = sdOrigFetch
  await sdRuntimes.shutdown()
  sdServer.close()
  fs.rmSync(sdDir, { recursive: true, force: true })
}

// --- regression: 账号时间轴持久化（导入/凭证更新/累计调度时长）---
{
  const tsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-timeline-'))
  saveAccountUser(tsDir, { id: 'tsa', email: 'tsa@example.com', authToken: 'token-tsa' })
  const tsConfig = loadConfig()
  tsConfig.server.host = '127.0.0.1'
  tsConfig.server.port = 0
  tsConfig.server.apiKeys = ['sk-test']
  tsConfig.upstream.credentialsDir = tsDir
  tsConfig.session.pollIntervalSec = 3600
  const tsRuntimes = new AccountRuntimes(tsConfig, { getAccountConcurrency: () => 1 })
  // 导入时间：新账号应立刻有一个 importedAt（来自凭据文件创建时间）
  const tsRow = tsRuntimes.list().find((a) => a.key === 'tsa')
  assert.ok(tsRow, 'tsa 应在账号列表里')
  assert.ok(tsRow.importedAt, `importedAt 不应为空, got ${tsRow.importedAt}`)
  assert.equal(tsRow.scheduledMs, 0, '新账号累计调度时长应为 0')
  // 凭证更新时间：只有真的写了凭据才记录（导入路径会调用 markCredentialUpdated）
  assert.equal(tsRow.credentialUpdatedAt, null, '未调用前应为 null')
  tsRuntimes.markCredentialUpdated('tsa')
  const tsRow2 = tsRuntimes.list().find((a) => a.key === 'tsa')
  assert.ok(tsRow2.credentialUpdatedAt, `markCredentialUpdated 后应非空`)
  // 累计调度时长：模拟会话在途 1.2s 后归零
  const tsSessions = tsRuntimes.get('tsa').sessions
  tsSessions.beginRequest()
  assert.ok(tsSessions.currentSchedulingMs() >= 0, '在途时应有本轮调度时长')
  await new Promise((r) => setTimeout(r, 1200))
  const runningMs = tsSessions.currentSchedulingMs()
  assert.ok(runningMs >= 1000, `本轮运行时长应 >=1s, got ${runningMs}`)
  tsSessions.endRequest()
  tsRuntimes.flushState()
  const tsRow3 = tsRuntimes.list().find((a) => a.key === 'tsa')
  assert.ok(tsRow3.scheduledMs >= 1000, `累计调度时长应 >=1s, got ${tsRow3.scheduledMs}`)
  assert.equal(tsRow3.currentSchedulingMs, 0, '本轮结束后实时时长应归零')
  // 重启（同 dataDir 新建实例）后这些值必须还在 —— 持久化的意义就在这里
  const tsRuntimes2 = new AccountRuntimes(tsConfig, { getAccountConcurrency: () => 1 })
  const tsRow4 = tsRuntimes2.list().find((a) => a.key === 'tsa')
  assert.ok(tsRow4.scheduledMs >= 1000, `重启后累计调度时长应保留, got ${tsRow4.scheduledMs}`)
  assert.ok(tsRow4.importedAt, '重启后导入时间应保留')
  assert.ok(tsRow4.credentialUpdatedAt, '重启后凭证更新时间应保留')
  // 起算点必须被清掉（上一进程已死，否则会显示假的"本轮运行 3 天"）
  assert.equal(tsRow4.schedulingSince, null, '重启后不应残留本轮起算点')
  await tsRuntimes2.shutdown()
  await tsRuntimes.shutdown()
  fs.rmSync(tsDir, { recursive: true, force: true })
}

// --- 会话临近过期：提前 re-admit 平滑切换（不再把新请求发到马上过期的会话）---
{
  const expDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-expire-'))
  saveAccountUser(expDir, { id: 'ea', email: 'ea@example.com', authToken: 'token-ea' })
  saveAccountUser(expDir, { id: 'eb', email: 'eb@example.com', authToken: 'token-eb' })
  const expConfig = loadConfig()
  expConfig.server.host = '127.0.0.1'
  expConfig.server.port = 0
  expConfig.server.apiKeys = ['sk-test']
  expConfig.upstream.credentialsDir = expDir
  expConfig.session.pollIntervalSec = 3600
  const expRuntimes = new AccountRuntimes(expConfig)
  const expServer = await startServer({
    config: expConfig,
    runtimes: expRuntimes,
    ...(() => {
      const rt = expRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const expPort = expServer.address().port
  const expChat = () => fetch(`http://127.0.0.1:${expPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })

  mockMode = 'ok'
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  // 会话有效期只有 30s < reAdmitLeadSec(60s)：第二个请求必须提前换新会话
  sessionExpiryMs = 30_000
  const e1 = await expChat()
  assert.equal(e1.status, 200, await e1.clone().text())
  assert.equal(sessionPosts, 1)
  assert.equal(e1.headers.get('x-freebuff-proxy-account'), 'ea@example.com')
  // 多账号场景：近过期会话在同一账号 re-admit 续期，而不是换到 eb 新建 session
  const e2 = await expChat()
  assert.equal(e2.status, 200, await e2.clone().text())
  assert.equal(sessionPosts, 2, `近过期会话应提前 re-admit, got ${sessionPosts}`)
  assert.ok(sessionDeletes >= 1, 're-admit 前应先释放旧会话')
  assert.equal(e2.headers.get('x-freebuff-proxy-account'), 'ea@example.com')
  assert.equal(
    expRuntimes.list().find((x) => x.email === 'eb@example.com').requests,
    0,
    '近过期会话应在本账号续期，不换账号',
  )

  // 有效期恢复正常（1h > lead）后：e3 先把还差 30s 的旧会话换掉（第 3 次 admit），
  // e4 起新会话剩余 1h，不再重复 admit
  sessionExpiryMs = 3600_000
  const e3 = await expChat()
  assert.equal(e3.status, 200, await e3.clone().text())
  assert.equal(sessionPosts, 3, `切换后的请求应 admit 一次, got ${sessionPosts}`)
  const e4 = await expChat()
  assert.equal(e4.status, 200, await e4.clone().text())
  assert.equal(sessionPosts, 3, `正常有效期应复用会话, got ${sessionPosts}`)

  sessionExpiryMs = 3600_000
  await expRuntimes.shutdown()
  expServer.close()
  fs.rmSync(expDir, { recursive: true, force: true })
}

// --- 账号并发信号量单元测试：容量、排队、超时、动态调大 ---
{
  const capPool = new AccountRuntimes(loadConfig(), {
    getAccountConcurrency: () => 2,
  })
  const r1 = await capPool.acquireChat('cap-key', 0)
  const r2 = await capPool.acquireChat('cap-key', 0)
  assert.equal(capPool.chatInFlight('cap-key'), 2)
  assert.equal(capPool.isChatBusy('cap-key'), true)
  // 满员时排队，超时 → account_busy
  let timedOut = null
  try {
    await capPool.acquireChat('cap-key', 50)
  } catch (err) {
    timedOut = err
  }
  assert.equal(timedOut?.code, 'account_busy')
  // 释放一个槽位 → 排队者立即获得
  const waiting = capPool.acquireChat('cap-key', 500)
  r2()
  const r3 = await waiting
  assert.equal(capPool.chatInFlight('cap-key'), 2)
  // 动态调大容量 → 队列里再排的人立即获得
  const waiting2 = capPool.acquireChat('cap-key', 500)
  capPool.chatLockFor('cap-key').setCapacity(4)
  const r4 = await waiting2
  assert.equal(capPool.chatInFlight('cap-key'), 3)
  r1(); r3(); r4()
  assert.equal(capPool.chatInFlight('cap-key'), 0)
  // 全部断开重连：重置信号量，在途清零、排队者放行
  const r5 = await capPool.acquireChat('cap-key', 0)
  const waiting3 = capPool.acquireChat('cap-key', 500)
  await capPool.reconnectAll()
  // 旧持有被清除；排队者被放行（已拿到槽位，会在 chat 流程重新 re-admit）
  assert.ok(capPool.chatInFlight('cap-key') <= 1, 'reconnect 后旧持有应被清除')
  const r6 = await waiting3
  r5(); r6()
  assert.equal(capPool.chatInFlight('cap-key'), 0)
  await capPool.shutdown()
}

// --- 全部断开重连 API：比重启更轻量，释放 session + 重置并发信号量 ---
{
  const rcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-reconnect-'))
  saveAccountUser(rcDir, { id: 'ra', email: 'ra@example.com', authToken: 'token-ra' })
  const rcConfig = loadConfig()
  rcConfig.server.host = '127.0.0.1'
  rcConfig.server.port = 0
  rcConfig.server.apiKeys = ['sk-test']
  rcConfig.upstream.credentialsDir = rcDir
  rcConfig.session.pollIntervalSec = 3600
  const { UserStore: RCUS } = await import('../src/web/user-store.js')
  const { WebSessionStore: RCWS } = await import('../src/web/session-store.js')
  const { LoginFlowManager: RCLFM } = await import('../src/web/login-flows.js')
  const { ProxyStore: RCPS } = await import('../src/web/proxy-store.js')
  const { SettingsStore: RCSS } = await import('../src/web/settings-store.js')
  const rcUsers = new RCUS(path.join(rcDir, 'users.json'))
  rcUsers.create({ username: 'admin', password: 'secret123', role: 'admin' })
  rcUsers.create({ username: 'viewer', password: 'secret123', role: 'user' })
  const rcWS = new RCWS(path.join(rcDir, 'web-sessions.json'), 3600_000)
  const rcLFM = new RCLFM({ file: path.join(rcDir, 'login-flows.json'), credentialsDir: rcDir, config: rcConfig })
  const rcPS = new RCPS(path.join(rcDir, 'proxies.json'))
  const rcSS = new RCSS(path.join(rcDir, 'settings.json'))
  const rcRuntimes = new AccountRuntimes(rcConfig)
  const rcServer = await startServer({
    config: rcConfig,
    runtimes: rcRuntimes,
    userStore: rcUsers,
    webSessions: rcWS,
    loginFlows: rcLFM,
    proxyStore: rcPS,
    settingsStore: rcSS,
  })
  const rcPort = rcServer.address().port
  const login = async (username) => {
    const r = await fetch(`http://127.0.0.1:${rcPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'secret123' }),
    })
    assert.equal(r.status, 200)
    return r.headers.get('set-cookie').split(';')[0]
  }
  const adminCookie = await login('admin')
  const viewerCookie = await login('viewer')

  // 先 admit 一个活跃 session
  mockMode = 'ok'
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  const rcChat = await fetch(`http://127.0.0.1:${rcPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(rcChat.status, 200, await rcChat.clone().text())
  assert.equal(sessionPosts, 1)
  assert.equal(rcRuntimes.list()[0].session.status, 'active')

  // 未登录 → 401；非 admin → 403
  {
    const anon = await fetch(`http://127.0.0.1:${rcPort}/api/system/reconnect`, { method: 'POST' })
    assert.equal(anon.status, 401)
    const viewer = await fetch(`http://127.0.0.1:${rcPort}/api/system/reconnect`, {
      method: 'POST',
      headers: { cookie: viewerCookie },
    })
    assert.equal(viewer.status, 403)
  }

  // admin 全部断开重连 → 200，session 被释放（下个请求自动重建）
  const rcRes = await fetch(`http://127.0.0.1:${rcPort}/api/system/reconnect`, {
    method: 'POST',
    headers: { cookie: adminCookie },
  })
  assert.equal(rcRes.status, 200, await rcRes.clone().text())
  const rcJson = await rcRes.json()
  assert.equal(rcJson.ok, true)
  assert.equal(rcJson.accounts[0].ok, true)
  assert.equal(rcRuntimes.list()[0].session.status, 'none', 'reconnect 应释放 session')
  assert.ok(sessionDeletes >= 1, 'reconnect 应调用上游 DELETE')

  // 下个请求自动重建全新 session
  const rcChat2 = await fetch(`http://127.0.0.1:${rcPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(rcChat2.status, 200, await rcChat2.clone().text())
  assert.equal(sessionPosts, 2, `reconnect 后应重新 admit, got ${sessionPosts}`)

  await rcRuntimes.shutdown()
  rcServer.close()
  fs.rmSync(rcDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// --- 重启 API 端点测试（不执行实际重启）---
{
  const rsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-restart-'))
  const rsConfig = loadConfig()
  rsConfig.server.host = '127.0.0.1'
  rsConfig.server.port = 0
  rsConfig.server.apiKeys = ['sk-test']
  rsConfig.upstream.credentialsDir = rsDir
  rsConfig.session.pollIntervalSec = 3600

  // 不需要实际 Freebuff 账号（重启不依赖上游）
  const rsRuntimes = new AccountRuntimes(rsConfig)
  // 重启回调标记
  let restarted = false
  const { UserStore: US } = await import('../src/web/user-store.js')
  const { WebSessionStore: WS } = await import('../src/web/session-store.js')
  const { LoginFlowManager: LFM } = await import('../src/web/login-flows.js')
  const { ProxyStore: PS } = await import('../src/web/proxy-store.js')
  const { SettingsStore: SS } = await import('../src/web/settings-store.js')
  const rsUsers = new US(path.join(rsDir, 'users.json'))
  rsUsers.create({ username: 'admin', password: 'secret123', role: 'admin' })
  const rsWS = new WS(path.join(rsDir, 'web-sessions.json'), 3600_000)
  const rsLFM = new LFM({ file: path.join(rsDir, 'login-flows.json'), credentialsDir: rsDir, config: rsConfig })
  const rsPS = new PS(path.join(rsDir, 'proxies.json'))
  const rsSS = new SS(path.join(rsDir, 'settings.json'))
  const rsServer = await startServer({
    config: rsConfig,
    runtimes: rsRuntimes,
    userStore: rsUsers,
    webSessions: rsWS,
    loginFlows: rsLFM,
    proxyStore: rsPS,
    settingsStore: rsSS,
    restart: () => { restarted = true },
  })
  const rsPort = rsServer.address().port

  // 未登录 → 401
  {
    const res = await fetch(`http://127.0.0.1:${rsPort}/api/system/restart`, { method: 'POST' })
    assert.equal(res.status, 401)
  }

  // 登录后 POST → 200 且 restart 回调被调用
  const loginRes = await fetch(`http://127.0.0.1:${rsPort}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret123' }),
  })
  assert.equal(loginRes.status, 200, await loginRes.clone().text())
  const cookies = loginRes.headers.get('set-cookie')
  assert.ok(cookies, 'expected set-cookie')

  const rrRes = await fetch(`http://127.0.0.1:${rsPort}/api/system/restart`, {
    method: 'POST',
    headers: { cookie: cookies.split(';')[0] },
  })
  assert.equal(rrRes.status, 200, await rrRes.clone().text())
  // setTimeout 300ms 后调用 restart → 等一会儿
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(restarted, true, 'restart callback should have been called')

  rsServer.close()
  fs.rmSync(rsDir, { recursive: true, force: true })
}

// --- 免费模型会话剩余 <5 分钟不再调度（提前 re-admit）；付费模型用到接近过期 ---
{
  const ldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-lead-'))
  saveAccountUser(ldDir, { id: 'lda', email: 'lda@example.com', authToken: 'token-lda' })
  const ldConfig = loadConfig()
  ldConfig.upstream.credentialsDir = ldDir
  ldConfig.session.pollIntervalSec = 3600
  ldConfig.session.reAdmitLeadSec = 60
  ldConfig.session.freeModelReAdmitLeadSec = 300
  const ldPool = new AccountRuntimes(ldConfig)
  const ldSm = ldPool.get('lda').sessions
  mockMode = 'ok'

  // 模型分类：免费（daily）vs 付费（premium）；未知模型按免费保守处理
  assert.equal(isFreeModel('deepseek/deepseek-v4-flash'), true)
  assert.equal(isFreeModel('mimo/mimo-v2.5'), true)
  assert.equal(isFreeModel('deepseek/deepseek-v4-pro'), false)
  assert.equal(isFreeModel('openai/gpt-5.6-luna'), false)
  assert.equal(isFreeModel('unknown/vendor-model'), true)

  // 免费模型：会话剩余 4 分钟（< 5 分钟阈值）→ 不再可用，提前 re-admit 换新会话
  sessionExpiryMs = 4 * 60_000
  sessionPosts = 0
  await ldSm.ensureSession('deepseek/deepseek-v4-flash')
  assert.equal(sessionPosts, 1)
  assert.equal(
    ldSm.isUsableForModel('deepseek/deepseek-v4-flash'),
    false,
    '免费会话剩余 4 分钟应视为不可复用（不足 5 分钟不调度）',
  )
  await ldSm.ensureSession('deepseek/deepseek-v4-flash')
  assert.equal(sessionPosts, 2, '免费会话剩余 <5 分钟应提前 re-admit')

  // 付费模型：会话剩余 4 分钟（> 60s lead）→ 仍可复用（不浪费已付费会话）
  sessionExpiryMs = 4 * 60_000
  await ldSm.ensureSession('deepseek/deepseek-v4-pro')
  assert.equal(
    ldSm.isUsableForModel('deepseek/deepseek-v4-pro'),
    true,
    '付费会话剩余 4 分钟应可复用（60s 提前量）',
  )
  // 付费模型：剩余 30s < 60s lead → 才不可复用
  ldSm.session.expiresAt = new Date(Date.now() + 30_000).toISOString()
  assert.equal(
    ldSm.isUsableForModel('deepseek/deepseek-v4-pro'),
    false,
    '付费会话剩余 30s 应不可复用（接近过期）',
  )

  sessionExpiryMs = 3600_000
  await ldPool.shutdown()
  fs.rmSync(ldDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// --- 幽灵连接：下游背压（客户端不读）→ idle 超时后账号锁必须释放 ---
//   回归：write() 返回 false 后裸等 drain（无 idle 定时器），客户端"活着但
//   不再读"（网络波动/卡顿）会永久挂起 → 账号 chat 锁占死、后续请求全部超时
{
  const bdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-backpressure-'))
  saveAccountUser(bdDir, { id: 'bda', email: 'bda@example.com', authToken: 'token-bda' })
  const bdConfig = loadConfig()
  bdConfig.server.host = '127.0.0.1'
  bdConfig.server.port = 0
  bdConfig.server.apiKeys = ['sk-test']
  bdConfig.upstream.credentialsDir = bdDir
  bdConfig.session.pollIntervalSec = 3600
  bdConfig.limits.streamIdleTimeoutSec = 1
  // 本用例只验证"背压 → idle 超时 → 锁释放"，不验证掐断后冷却（由 stall_zero 覆盖）
  bdConfig.limits.stallCooldownSec = 0

  const bdRuntimes = new AccountRuntimes(bdConfig)
  const bdServer = await startServer({
    config: bdConfig,
    runtimes: bdRuntimes,
    ...(() => {
      const rt = bdRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const bdPort = bdServer.address().port

  // 原始 TCP 客户端：发请求后绝不读响应（窗口满 → 背压）
  mockMode = 'bigstall'
  sessionPosts = 0
  completionAttempts = 0
  const sock = net.connect(bdPort, '127.0.0.1')
  try {
    sock.setRecvBufferSize(1024) // 缩小接收窗口，尽快触发背压
  } catch {
    // 平台不支持则忽略
  }
  const bdBody = JSON.stringify({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  sock.write(
    `POST /v1/chat/completions HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${bdPort}\r\n` +
      `Authorization: Bearer sk-test\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(bdBody)}\r\n\r\n` +
      bdBody,
  )
  // 先等请求真正获取到账号锁（否则 waitFor(===0) 在锁未获取时就成立、空转通过）
  await waitFor(
    '背压请求应获取账号锁',
    () => bdRuntimes.chatInFlight('bda') === 1,
    10_000,
  )
  // 客户端不读响应 → 大块写触发下游背压；账号锁必须在 idle 超时（1s）后释放
  await waitFor(
    '背压卡死时账号锁应在 idle 超时后释放',
    () => bdRuntimes.chatInFlight('bda') === 0,
    10_000,
  )
  sock.destroy()

  // 锁已释放 → 下一个请求立即可用（不再排队超时）
  mockMode = 'ok'
  const bdRes = await fetch(`http://127.0.0.1:${bdPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(bdRes.status, 200, await bdRes.clone().text())
  await bdRes.text()

  await bdRuntimes.shutdown()
  bdServer.close()
  fs.rmSync(bdDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// --- 账号被卡死（在途流占死唯一并发槽）时，其他连接换号成功而不是全部超时 ---
{
  const waDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-wedge-'))
  saveAccountUser(waDir, { id: 'wa', email: 'wa@example.com', authToken: 'token-wa' })
  saveAccountUser(waDir, { id: 'wb', email: 'wb@example.com', authToken: 'token-wb' })
  const waConfig = loadConfig()
  waConfig.server.host = '127.0.0.1'
  waConfig.server.port = 0
  waConfig.server.apiKeys = ['sk-test']
  waConfig.upstream.credentialsDir = waDir
  waConfig.session.pollIntervalSec = 3600
  waConfig.limits.streamIdleTimeoutSec = 1
  waConfig.limits.accountMaxConcurrency = 1

  const waRuntimes = new AccountRuntimes(waConfig) // 默认粘性调度（集中用一个账号）
  const waServer = await startServer({
    config: waConfig,
    runtimes: waRuntimes,
    ...(() => {
      const rt = waRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const waPort = waServer.address().port
  const waChat = (model = 'deepseek/deepseek-v4-flash', stream = true) =>
    fetch(`http://127.0.0.1:${waPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hello' }] }),
    })

  mockMode = 'hold_once'
  sessionPosts = 0
  completionAttempts = 0
  // A：wa 占住唯一并发槽（hold 流保持打开）
  const resA = await waChat()
  assert.equal(resA.status, 200)
  assert.equal(waRuntimes.chatInFlight('wa'), 1, 'hold 流应占用 wa 的唯一并发槽')
  // B：立刻打第二个请求 → 粘性调度先在 wa 上有界排队；卡死的流会被 idle
  // 超时（1s）掐断释放槽位，B 随即在 wa 上成功，而不是全部超时。
  const t0 = Date.now()
  const resB = await waChat()
  assert.equal(resB.status, 200, await resB.clone().text())
  assert.equal(
    resB.headers.get('x-freebuff-proxy-account'),
    'wa@example.com',
    '粘性优先：卡死流被 idle 超时掐断后，排队请求仍在 wa 上完成',
  )
  assert.ok(Date.now() - t0 < 15_000, `排队应有界快速完成, took ${Date.now() - t0}ms`)
  await resB.text()
  // 放行 A 的 hold（可能已被 idle 超时掐断，容错）
  releaseHoldStreams()
  try { await resA.text() } catch { /* 被 idle 掐断也符合预期 */ }

  await waRuntimes.shutdown()
  waServer.close()
  fs.rmSync(waDir, { recursive: true, force: true })
  mockMode = 'ok'
}

await runtimes.shutdown()
server.close()

// --- open api: /v1/freebuff/accounts/import + DELETE (Bearer API Key) ---
{
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-import-'))
  saveAccountUser(importDir, {
    id: 'imp1',
    email: 'imp-one@example.com',
    name: 'ImpOne',
    authToken: 'token-imp-1',
  })
  const cfg = loadConfig()
  cfg.server.host = '127.0.0.1'
  cfg.server.port = 0
  cfg.server.apiKeys = ['sk-import-test']
  cfg.upstream.credentialsDir = importDir
  cfg.session.pollIntervalSec = 3600
  cfg.limits.maxConcurrentRequests = 2
  const runtimes2 = new AccountRuntimes(cfg)
  const settingsStore2 = new SettingsStore(path.join(importDir, 'settings.json'))
  const srv2 = await startServer({
    config: cfg,
    runtimes: runtimes2,
    ...(() => {
      const rt = runtimes2.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
    settingsStore: settingsStore2,
  })
  const p2 = srv2.address().port
  const b2 = `http://127.0.0.1:${p2}`

  // 401: 无鉴权拒绝
  let r = await fetch(`${b2}/v1/freebuff/accounts/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.z', authToken: 't' }),
  })
  assert.strictEqual(r.status, 401, '无鉴权导入应 401')

  // 单个导入
  r = await fetch(`${b2}/v1/freebuff/accounts/import`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-import-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'imp2',
      email: 'imp-two@example.com',
      name: 'ImpTwo',
      authToken: 'token-imp-2',
    }),
  })
  assert.strictEqual(r.status, 200, '单账号导入应 200')
  const imp1 = await r.json()
  assert.strictEqual(imp1.ok, true, '导入 ok')
  assert.strictEqual(imp1.imported.length, 1, '导入 1 个')
  assert.strictEqual(imp1.imported[0].email, 'imp-two@example.com', '导入邮箱正确')

  // 批量导入（数组）
  r = await fetch(`${b2}/v1/freebuff/accounts/import`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-import-test', 'content-type': 'application/json' },
    body: JSON.stringify([
      { id: 'imp3', email: 'imp-three@example.com', authToken: 'token-imp-3' },
      { id: 'imp4', email: 'imp-four@example.com', authToken: 'token-imp-4' },
      { email: 'bad-no-token@example.com' }, // 缺 authToken → failure
    ]),
  })
  assert.strictEqual(r.status, 200, '批量导入应 200')
  const impN = await r.json()
  assert.strictEqual(impN.imported.length, 2, '批量成功 2 个')
  assert.strictEqual(impN.failures.length, 1, '批量失败 1 个')

  // 列表包含导入账号
  r = await fetch(`${b2}/v1/freebuff/accounts`, {
    headers: { authorization: 'Bearer sk-import-test' },
  })
  const list = await r.json()
  const emails = list.data.map((row) => row.email)
  assert.ok(emails.includes('imp-two@example.com'), '列表含导入账号 imp-two')
  assert.ok(emails.includes('imp-three@example.com'), '列表含导入账号 imp-three')

  // DELETE 单个（按 email）
  r = await fetch(`${b2}/v1/freebuff/accounts`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer sk-import-test', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'imp-three@example.com' }),
  })
  assert.strictEqual(r.status, 200, '删除应 200')
  const del = await r.json()
  assert.strictEqual(del.existed, true, '按 email 删除应 existed:true')

  // 删除后列表不含
  r = await fetch(`${b2}/v1/freebuff/accounts`, {
    headers: { authorization: 'Bearer sk-import-test' },
  })
  const list2 = await r.json()
  assert.ok(
    !list2.data.some((row) => row.email === 'imp-three@example.com'),
    '删除后列表不含 imp-three',
  )

  await runtimes2.shutdown()
  srv2.close()
  fs.rmSync(importDir, { recursive: true, force: true })
}


// ── Freebucks 计量改版（issue #7）：空闲释放 / 余额拦截 / 新会话预算 ──
//
// 上游 2026-09 起：admit 一次按「单价(N/h)」买断整小时，**早退 DELETE 不退**
// （只退还 session_units；见 docs/account-scheduling-and-refund.md §3）。
// 旧代理把 session 留到过期、报错时把每个账号都 admit 一遍——一次故障就买断
// 好几条整小时。下面回归针对这两个问题。
{
  const fbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-fb-'))
  saveAccountUser(fbDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  saveAccountUser(fbDir, { id: 'b', email: 'b@example.com', authToken: 'token-b' })
  saveAccountUser(fbDir, { id: 'c', email: 'c@example.com', authToken: 'token-c' })
  const fbConfig = loadConfig()
  fbConfig.server.host = '127.0.0.1'
  fbConfig.server.port = 0
  fbConfig.server.apiKeys = ['sk-test']
  fbConfig.upstream.credentialsDir = fbDir
  fbConfig.session.pollIntervalSec = 3600
  // 空闲释放调到 150ms（测试用），预算 2
  fbConfig.session.idleReleaseSec = 0.15
  fbConfig.limits.maxNewSessionsPerRequest = 2
  const fbRuntimes = new AccountRuntimes(fbConfig)
  const fbServer = await startServer({
    config: fbConfig,
    runtimes: fbRuntimes,
    ...(() => {
      const rt = fbRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const fbPort = fbServer.address().port
  const fbChat = (body) =>
    fetch(`http://127.0.0.1:${fbPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

  const futureReset = new Date(Date.now() + 6 * 3600_000).toISOString()
  const freebucks25 = {
    balance: 25,
    daily: { limit: 25, spent: 0, remaining: 25, resetAt: futureReset },
    wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
    prices: { 'deepseek/deepseek-v4-flash': 2 },
  }

  // (1) **已付费时段内不释放**（2026-09-14 一手实测后改）：
  //     上游一次 admit 就是买断一小时，POST 当场扣满整小时单价，回执带 expiresAt。
  //     这一小时内继续用边际成本为 0，而 DELETE 后那一小时作废、重开要重买。
  //     所以空闲超过 idleReleaseSec 也**不得**释放；要等付费时段结束。
  mockMode = 'ok'
  mockFreebucks = freebucks25
  sessionPosts = 0
  sessionDeletes = 0
  deleteInstanceIds = []
  completionAttempts = 0
  {
    const res = await fbChat({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(res.status, 200, await res.clone().text())
    assert.equal(sessionPosts, 1, 'first request admits one session')
    const sm = fbRuntimes.get('a').sessions
    // 拿到 freebucks 计量块（余额 / 单价 / 重置时间）
    const snap0 = sm.getSnapshot()
    assert.equal(snap0.freebucks?.balance, 25, 'freebucks balance parsed')
    assert.equal(snap0.freebucks?.prices?.['deepseek/deepseek-v4-flash'], 2, 'price parsed')
    assert.equal(sm.freebucksFor('deepseek/deepseek-v4-flash').affordable, true)

    // 付费时段判定本身
    assert.equal(sm.inPaidWindow(), true, '刚 admit（expiresAt=+1h）应判为在付费时段内')
    // (REUSE-COUNT) 「我们在省钱」必须可被前端量化：一次 admit = 买断一小时，
    // 之后的每次复用都是零边际成本。计数器要如实反映 admit/reuse。
    assert.equal(sm.admitCount, 1, '首次请求应记为买过 1 条会话')
    assert.equal(sm.reuseCount, 0, '此时还没有复用')
    {
      const again = await fbChat({
        model: 'deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: 'reuse-me' }],
      })
      assert.equal(again.status, 200, await again.clone().text())
      assert.equal(sessionPosts, 1, '复用不得再 admit（那一小时已买断）')
      assert.equal(sm.admitCount, 1, '复用不应增加 admitCount')
      assert.equal(sm.reuseCount, 1, '同一小时内第二次请求应记为 1 次复用')
      const row = fbRuntimes.list().find((x) => x.key === 'a')
      assert.equal(row.admitCount, 1, '账号列表必须暴露 admitCount（前端显示"买过几条"）')
      assert.equal(row.reuseCount, 1, '账号列表必须暴露 reuseCount（前端显示"复用几次"）')
    }
    assert.ok(
      sm.paidWindowRemainingMs() > 0,
      '付费时段剩余应 > 0',
    )
    // 快照把 expiresAt 一路带到前端
    assert.ok(snap0.expiresAt, '快照应带 expiresAt（付费时段依据）')

    // 空闲时长远超 idleReleaseSec（150ms），但付费时段内**必须一条都不删**。
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(sessionDeletes, 0, '付费时段内空闲不得释放（那一小时已买断）')
    assert.equal(sm.getSnapshot().status, 'active', '付费时段内会话应保持 active')

    // 付费时段结束后（把 expiresAt 拨到过去）→ 空闲释放恢复生效
    sm.session.expiresAt = new Date(Date.now() - 1000).toISOString()
    sm.session.remainingMs = 0
    assert.equal(sm.inPaidWindow(), false, '过期后不应再判为在付费时段内')
    sm._armIdleRelease()
    await waitFor('付费时段结束后空闲释放触发 DELETE', () => sessionDeletes >= 1, 4_000)
    assert.equal(deleteInstanceIds[0], 'inst-1', 'DELETE 必须带 x-freebuff-instance-id')
    const snap = sm.getSnapshot()
    assert.equal(snap.status, 'none', '空闲释放后会话应已结束')
    assert.equal(snap.lastRefund?.refund, mockRefund, '退款回执应记录')
    // 账号列表把 Freebucks 暴露给控制台
    const row = fbRuntimes.list().find((x) => x.key === 'a')
    assert.equal(row.freebucks?.balance, 25, '账号列表应带 freebucks')

    // (1.5) 退款流水必须落盘：只有 lastRefund 一个内存字段时，"退款是不是失败
    //       了 / 金额对不对"根本无法审计（重启就丢）。流水要同时给出
    //       refund（上游实退）与 expected（按实际占用应付），差额才可对账。
    fbRuntimes.accountState.flush()
    const rlog = fbRuntimes.accountState.refunds('a')
    assert.ok(rlog.length >= 1, '退款流水应至少有一条')
    assert.equal(rlog[0].refund, mockRefund, '流水应记上游实退金额')
    assert.equal(rlog[0].instanceId, 'inst-1', '流水应记 instanceId')
    assert.equal(rlog[0].model, 'deepseek/deepseek-v4-flash')
    assert.equal(rlog[0].price, 2, '流水应记当时单价，便于换算 expected')
    assert.ok(
      typeof rlog[0].holdMs === 'number' && rlog[0].holdMs >= 0,
      '流水应记实际占用时长',
    )
    assert.ok(
      typeof rlog[0].expected === 'number',
      `流水应给出应付金额（对账用），got ${JSON.stringify(rlog[0])}`,
    )
    assert.equal(
      fbRuntimes.list().find((x) => x.key === 'a').refundTotal,
      mockRefund,
      '累计退款应出现在账号列表里',
    )
    // 账号生命周期字段必须能到前端（分区功能的数据来源）
    const listRow = fbRuntimes.list().find((x) => x.key === 'a')
    assert.ok(listRow.firstSeenAt, '列表应带 firstSeenAt（账号加入时间）')
    assert.ok(
      !Number.isNaN(Date.parse(listRow.firstSeenAt)),
      'firstSeenAt 应是可解析的时间',
    )
    assert.ok(
      Array.isArray(listRow.refunds) && listRow.refunds.length >= 1,
      '列表应带退款流水',
    )
    // 注：/api/accounts 是 `{ object, data: runtimes.list() }` 的**直通**（web
    // 会话鉴权，本块未搭该设施），所以上面 list() 的断言就等于端点契约。
  }

  // (2) 余额买不起该模型 → 不 admit（不发 POST），直接跳过该账号。
  mockFreebucks = {
    ...freebucks25,
    balance: 0.5,
    daily: { limit: 25, spent: 24.5, remaining: 0.5, resetAt: futureReset },
  }
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  {
    // 粘性调度：warm 请求全部落在同一个账号（a）上，它的 freebucks 会更新成
    // "只剩 0.5"。b/c 从未被使用过，压根不该被碰到。
    for (let i = 0; i < 2; i++) {
      const warm = await fbChat({
        model: 'deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: `warm-${i}` }],
      })
      assert.equal(warm.status, 200, await warm.clone().text())
      assert.equal(warm.headers.get('x-freebuff-proxy-account'), 'a@example.com')
    }
    assert.equal(fbRuntimes.list().find((x) => x.key === 'b').used, false, 'b 不应被使用')
    // 把三个号都标成"余额只剩 0.5"（等价于它们各自的 session 响应都回写过计量块）
    for (const key of ['a', 'b', 'c']) {
      const sm = fbRuntimes.get(key).sessions
      sm.freebucks = {
        balance: 0.5,
        daily: { limit: 25, spent: 24.5, remaining: 0.5, resetAt: futureReset },
        wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
        prices: { 'deepseek/deepseek-v4-flash': 2 },
        quotaExempt: false,
        planId: null,
        monthly: null,
        peak: null,
        updatedAt: new Date().toISOString(),
      }
      await sm.release()
      assert.equal(
        sm.freebucksFor('deepseek/deepseek-v4-flash').affordable,
        false,
        `${key} 余额 0.5 < 单价 2 应判为买不起`,
      )
    }
    const postsBefore = sessionPosts
    const res = await fbChat({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(res.status, 429, await res.clone().text())
    const j = await res.json()
    // 全部账号都是"余额买不起"→ 独立错误码，与"没号/都在冷却"区分开
    // （前者等每日池刷新即可，后者要加号），控制台/调用方才分得清处境。
    assert.equal(
      j.error.code,
      'freebucks_exhausted',
      `全账号余额不足应报 freebucks_exhausted，got ${JSON.stringify(j.error)}`,
    )
    assert.ok(
      (j.error.details?.failures || []).length >= 3 &&
        (j.error.details?.failures || []).every(
          (f) => f.code === 'freebucks_exhausted',
        ),
      `每个账号都应记为 freebucks_exhausted，got ${JSON.stringify(j.error.details)}`,
    )
    assert.equal(
      sessionPosts,
      postsBefore,
      '余额不足不得再 admit 新会话（admit 一次即买断整小时）',
    )
  }

  // (2.2) 同号重试（forceReadmit）也必须过额度闸门：它会先 DELETE 再 admit，
  //       等于**新买一条计费会话**。余额买不起还去 admit，正好命中上游
  //       "所需 Freebucks > 余额 → 直接封号"的判定——这是最现实的一条封号路径。
  {
    const model = 'deepseek/deepseek-v4-flash'
    const fbLow = {
      balance: 0.5,
      daily: { limit: 25, spent: 24.5, remaining: 0.5, resetAt: futureReset },
      wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
      prices: { [model]: 2 },
      quotaExempt: false,
      planId: null,
      monthly: null,
      peak: null,
      updatedAt: new Date().toISOString(),
    }
    for (const key of ['a', 'b', 'c']) {
      fbRuntimes.get(key).sessions.freebucks = { ...fbLow }
    }
    // 同号 gate 重试路径：给一个 session 可恢复的 gate code，走 forceReadmit 分支
    const postsBefore = sessionPosts
    let threw = null
    try {
      await fbRuntimes.reacquireAfterGate(model, {
        preferredKey: 'a',
        gateCode: 'session_expired',
      })
    } catch (err) {
      threw = err
    }
    assert.ok(threw, '余额不足时同号重试必须失败，而不是硬买一条新会话')
    assert.equal(
      threw.code,
      'freebucks_exhausted',
      `应报 freebucks_exhausted，got ${threw.code}: ${threw.message}`,
    )
    assert.equal(
      sessionPosts,
      postsBefore,
      '余额不足不得经 forceReadmit 再 admit 新会话（再买断一小时 + 触发封号判定）',
    )
    fbRuntimes.clearCooldown('a', model)
  }

  // (2.4) session_units 是**独立**于 Freebucks 的第二道闸门：一手实测证明一笔会话
  //       两本账都扣（units +1.0 且 Freebucks −单价），所以 units 用尽时同样不得
  //       去 admit（上游会用 rate_limited 拒掉，白跑一次往返）。注意 recentCount
  //       是**小数**，比较必须用 >=。见
  //       .agents/notes/implemented/architecture/2026-09-14-two-ledgers-parallel-gates.md
  {
    const model = 'deepseek/deepseek-v4-flash'
    // Freebucks 故意留得足足的 —— 只有 units 卡住，才能证明两道闸门是独立的。
    for (const key of ['a', 'b', 'c']) {
      const sm = fbRuntimes.get(key).sessions
      sm.freebucks = {
        balance: 999,
        daily: { limit: 999, spent: 0, remaining: 999, resetAt: futureReset },
        wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
        prices: { [model]: 2 },
        quotaExempt: false,
        planId: null,
        monthly: null,
        peak: null,
        updatedAt: new Date().toISOString(),
      }
      // units 已满：6/6（实测里 recentCount 可为小数，这里同时覆盖整数边界）。
      sm.quota = {
        byModel: {
          [model]: {
            model,
            limit: 6,
            pool: 'limited',
            poolLabel: 'Daily',
            resetAt: futureReset,
            recentCount: 6,
          },
        },
        rateLimit: null,
        updatedAt: new Date().toISOString(),
      }
      await sm.release()
      const u = sm.sessionUnitsFor(model)
      assert.equal(u.known, true, `${key} 应识别出 units 账本`)
      assert.equal(u.exhausted, true, `${key} units 6/6 应判为用尽`)
      assert.equal(u.remaining, 0, `${key} 剩余应为 0`)
      // 小数边界：5.4/6 未满、6/6 已满（不能用整数假设）
      assert.equal(
        sm.sessionUnitsFor(model).exhausted,
        true,
        'units 比较必须覆盖等号边界',
      )
    }
    const postsBefore = sessionPosts
    const res = await fbChat({
      model,
      messages: [{ role: 'user', content: 'units-gate' }],
    })
    assert.equal(res.status, 429, await res.clone().text())
    const j = await res.json()
    assert.equal(
      j.error.code,
      'units_exhausted',
      `全账号 units 用尽应报 units_exhausted，got ${JSON.stringify(j.error)}`,
    )
    assert.equal(
      sessionPosts,
      postsBefore,
      'units 用尽不得再 admit 新会话（两本账都扣，白跑一次往返）',
    )
    // fail-open：没有 units 行的模型不得被这道闸门误拦。
    const noRow = fbRuntimes.get('a').sessions.sessionUnitsFor('openai/gpt-5.6-nope')
    assert.equal(noRow.known, false, '无 units 行的模型必须 fail-open')
    assert.equal(noRow.exhausted, false, '无 units 行的模型不得被判用尽')
    // 清场：后续用例不该继承这里的 6/6（否则会一直被 units 闸门拦下）。
    for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.quota = null
  }

  // (2.5) 重启后额度闸门不得失忆：账号账本（account-state.json）落盘 →
  //       新进程起来后仍知道"这个号余额买不起"，不会拿重启当重置去撞已知
  //       余额不足的账号（那正是封禁的触发条件）。
  {
    const model = 'deepseek/deepseek-v4-flash'
    // 把 a 标成"余额 0.5 < 单价 2"，走完整落盘路径（不是直接改内存）。
    const smA = fbRuntimes.get('a').sessions
    smA.freebucks = {
      balance: 0.5,
      daily: { limit: 25, spent: 24.5, remaining: 0.5, resetAt: futureReset },
      wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
      prices: { [model]: 2 },
      quotaExempt: false,
      planId: null,
      monthly: null,
      peak: null,
      updatedAt: new Date().toISOString(),
    }
    fbRuntimes._persistAccountState('a', { freebucks: smA.freebucks })
    fbRuntimes.accountState.flush()

    const stateFile = fbRuntimes.accountState.file
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.ok(
      onDisk.accounts?.a?.freebucks,
      'freebucks 必须落盘（否则重启后闸门失忆）',
    )
    assert.equal(onDisk.accounts.a.freebucks.balance, 0.5)
    assert.ok(onDisk.accounts?.a?.firstSeenAt, '账号加入时间必须落盘')
    assert.equal(
      typeof onDisk.accounts?.a?.requests,
      'number',
      '请求计数必须落盘',
    )

    // 模拟"进程重启"：同一 dataDir 上重新构造一套 runtime。
    const restarted = new AccountRuntimes(fbConfig)
    const rtA = restarted.get('a')
    assert.equal(
      rtA.sessions.freebucks?.balance,
      0.5,
      '重启后必须从账本回灌 freebucks',
    )
    const fbAfter = rtA.sessions.freebucksFor(model)
    assert.equal(fbAfter.known, true, '重启后额度应仍是"已知"（不得 fail-open）')
    assert.equal(
      fbAfter.affordable,
      false,
      '重启后仍必须判定为买不起（fail-open 就等于拿重启当额度重置）',
    )
    await restarted.shutdown()
  }

  // (2.6) 账本回灌的前缀撞车：账号 key "acc" 与 "acc2" 是不同账号，冷却/记录
  //       绝不能因为 startsWith 就互相串台（单字符 key 的用例测不出来）。
  {
    const pDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-prefix-'))
    try {
      saveAccountUser(pDir, { id: 'acc', email: 'acc@x.com', authToken: 't1' })
      saveAccountUser(pDir, { id: 'acc2', email: 'acc2@x.com', authToken: 't2' })
      const pCfg = loadConfig()
      pCfg.upstream.credentialsDir = pDir
      pCfg.session.pollIntervalSec = 3600
      const p1 = new AccountRuntimes(pCfg)
      p1.get('acc')
      p1.get('acc2')
      // 只冷却 acc2（账号级 + 模型级各一条），走真实 markCooldown 路径
      p1.markCooldown('acc2', { code: 'rate_limited' })
      p1.markCooldown('acc2', { code: 'model_unavailable' }, 'some/model')
      // 关键：触发一次针对 **acc** 的归集（clearCooldown 也会写账本）。
      // 没有这一步，startsWith('acc') 的撞车永远不会真正发生——acc 从不被写，
      // 于是 bug 潜伏而测试恒绿（第一版就是这么写空的）。
      p1.clearCooldown('acc')
      p1.accountState.flush()

      // 归集必须精确：acc2 的冷却绝不能写进 acc 的记录（startsWith("acc")
      // 会把 "acc2" 一起匹配进来——单字符 key 的用例测不出这种前缀撞车）。
      const accRec = p1.accountState.account('acc')
      assert.ok(
        !accRec.cooldowns || Object.keys(accRec.cooldowns).length === 0,
        `acc 的记录不得含任何冷却，got ${JSON.stringify(accRec.cooldowns)}`,
      )
      const acc2Rec = p1.accountState.account('acc2')
      assert.ok(
        acc2Rec.cooldowns?.acc2,
        'acc2 的账号级冷却应记在 acc2 自己名下',
      )
      assert.ok(
        acc2Rec.cooldowns?.['acc2\0some/model'],
        'acc2 的模型级冷却应记在 acc2 自己名下',
      )

      // 回灌同样要精确
      const p2 = new AccountRuntimes(pCfg)
      p2.get('acc')
      p2.get('acc2')
      assert.equal(
        p2.isCoolingDown('acc'),
        false,
        'acc 不得继承 acc2 的冷却（前缀撞车）',
      )
      assert.equal(p2.isCoolingDown('acc2'), true, 'acc2 的账号级冷却应回灌')
      assert.equal(
        p2.isCoolingDown('acc2', 'some/model'),
        true,
        'acc2 的模型级冷却应回灌',
      )
      await p2.shutdown()
      // 封禁时间要落盘：chat 阶段撞到 banned 与探测发现 banned 同等重要，
      // 控制台"已被封禁"分区靠它（否则重启后这个号会被当成干净号）。
      const p3 = new AccountRuntimes(pCfg)
      p3.get('acc')
      p3.markCooldown('acc', { code: 'banned' })
      p3.accountState.flush()
      assert.ok(
        p3.accountState.account('acc').bannedAt,
        'banned 冷却必须记下 bannedAt',
      )
      const p4 = new AccountRuntimes(pCfg)
      const accRow = p4.list().find((x) => x.key === 'acc')
      assert.ok(accRow.bannedAt, '重启后 bannedAt 仍应在账号列表里')
      await p3.shutdown()
      await p4.shutdown()
    } finally {
      fs.rmSync(pDir, { recursive: true, force: true })
    }
  }

  // (3) 单请求新会话预算：chat 一直 500（账号级故障 → 换号），3 个账号最多
  //     新建 2 个计费会话，不会把每个账号都买一条计费会话。
  mockFreebucks = null
  // 清掉 (2) 里缓存的"余额 0.5"（否则这一步会被余额拦截，测不到预算）
  for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.freebucks = null
  mockMode = 'err_500_all'
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  {
    const res = await fbChat({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(res.status, 429, await res.clone().text())
    const j = await res.json()
    assert.equal(j.error.code, 'no_available_account')
    assert.equal(sessionPosts, 2, `新会话预算 2，不得轮询全部账号，got ${sessionPosts}`)
    assert.ok(
      (j.error.details?.failures || []).some(
        (f) => f.code === 'session_budget_exhausted',
      ),
      '应记录 session_budget_exhausted',
    )
    // 失败账号的会话必须被早退释放（拿退款），不能空挂后台
    await waitFor('失败账号会话被释放', () => sessionDeletes >= 1, 3_000)
  }


  // (4) 排队等 chat 锁的请求不得被空闲释放误删会话（选号阶段就 admit、请求
  //     还没走到 beginRequest，在途计数为 0——只看在途会误删）。
  mockFreebucks = null
  for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.freebucks = null
  mockMode = 'hold_once'
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  {
    const resA = await fbChat({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hold' }],
    })
    assert.equal(resA.status, 200, 'held stream should start')
    const heldKey = resA.headers.get('x-freebuff-proxy-account-id')
    const sm = fbRuntimes.get(heldKey).sessions
    assert.equal(sm.inFlightCount(), 1, 'hold 流应在途')
    // B 排在同一条会话的 chat 锁后面（每账号并发 1，粘性调度先排队不换号）
    const pendingB = fbChat({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'queued' }],
    })
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(
      sessionDeletes,
      0,
      '有请求排队等待该会话时，空闲释放不得删会话',
    )
    releaseHoldStreams()
    await resA.text()
    const resB = await pendingB
    assert.equal(resB.status, 200, await resB.clone().text())
    assert.equal(
      resB.headers.get('x-freebuff-proxy-account-id'),
      heldKey,
      '排队请求应复用同一账号的会话，不得换号',
    )
    assert.equal(sessionPosts, 1, '排队请求应复用同一会话，不得新建')
  }


  // (5) DELETE 失败**不得丢弃 instanceId**（issue：取消失败 = 会话再也删不掉、
  //     一直占着上游会话槽位）。失败后句柄保留并退避重试，第二次成功才清空会话。
  sessionPosts = 0
  sessionDeletes = 0
  deleteFailuresLeft = 1
  mockMode = 'ok'
  {
    const key = 'a'
    const sm = fbRuntimes.get(key).sessions
    await sm.ensureSession('deepseek/deepseek-v4-flash')
    assert.ok(sm.getSnapshot().instanceId, 'admit 后应有 instanceId')
    const ok = await sm.release()
    assert.equal(ok, false, '首次 DELETE 失败应返回 false（不谎报成功）')
    assert.equal(sm.getSnapshot().instanceId, sm.session.instanceId, '句柄必须保留')
    assert.equal(sm._releasePending, true, '应标记待重试')
    // 退避重试（第一次 delay=0，立即重试）后应成功并清空
    await waitFor('释放失败后自动重试成功', () => sm.getSnapshot().status === 'none', 3_000)
    assert.equal(sm._releasePending, false, '成功后清除待重试标记')
    assert.equal(sm.getSnapshot().status, 'none', '成功后句柄应清空')
  }

  // (6) 严格释放（「断开全部连接」/「重启服务」用）：等到真的删掉才返回 ok。
  sessionPosts = 0
  sessionDeletes = 0
  deleteFailuresLeft = 0
  {
    const r = await fbRuntimes.releaseAllStrict()
    assert.equal(r.ok, true, `严格释放应全部成功：${JSON.stringify(r.failed)}`)
    assert.ok(r.released >= 1, '至少释放一条会话')
  }
  {
    // 上游一直删不掉 → 如实返回失败明细，绝不谎报"已全部断开"
    const sm = fbRuntimes.get('a').sessions
    await sm.ensureSession('deepseek/deepseek-v4-flash')
    deleteFailuresLeft = 99
    const r = await fbRuntimes.releaseAllStrict()
    assert.equal(r.ok, false, '删不掉时必须 ok=false')
    assert.ok(r.failed.length >= 1, '必须带上失败明细')
    assert.ok(r.failed[0].instanceId, '失败明细要带 instanceId（供排查/扫尾）')
    assert.ok(sm.getSnapshot().instanceId, '失败后句柄仍保留')
    deleteFailuresLeft = 0
    await sm.release()
  }

  // (7) 会话句柄落盘 sessions.json（重启/换容器后仍能寻址 DELETE 退款）：
  //     admit 写入、释放清空、遗留句柄进 orphans 由启动扫尾清理。
  {
    const idx = path.join(path.dirname(fbDir), 'sessions.json')
    const storeFile = fbRuntimes.handleStore.file
    assert.ok(
      storeFile.startsWith(path.dirname(fbDir)),
      `句柄索引应与凭据目录同级，got ${storeFile}`,
    )
    sessionPosts = 0
    sessionDeletes = 0
    deleteFailuresLeft = 0
    const sm = fbRuntimes.get('b').sessions
    await sm.ensureSession('deepseek/deepseek-v4-flash')
    const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    assert.ok(
      onDisk.sessions.some((s) => s.key === 'b' && s.instanceId),
      'admit 后句柄应落盘',
    )
    // 模拟"进程被杀"：内存句柄丢弃，文件里仍有记录 → 下次启动扫尾应删掉它
    const store = new SessionHandleStore(storeFile)
    assert.ok(store.listOrphans().length >= 1, '上次运行遗留的句柄应视为待清理')
    // 账号已删除 / 凭据解析不到时：不得谎报清理成功，句柄要保留在文件里
    const skipped = await store.cleanupOrphans(() => null)
    assert.equal(skipped.cleaned, 0, '解析不到账号时不得谎报已清理')
    assert.ok(skipped.skipped >= 1, '解析不到的句柄应计入 skipped 并保留')
    assert.ok(store.listOrphans().length >= 1, '跳过的句柄必须保留')
    // 用真实 upstream 解析器再跑一次：应清掉所有遗留句柄
    await store.cleanupOrphans((key) => fbRuntimes.byKey.get(key)?.upstream)
    assert.equal(store.listOrphans().length, 0, '启动扫尾后不应残留待清理句柄')
    // —— 启动扫尾必须是**有界**的：一个连不通的上游（DNS 黑洞/代理挂起/已被删的
    // 账号）曾让每条 DELETE 各等 30s×3 次重放，服务十几分钟不进监听状态，用户看到
    // 的就是「起不来，删 sessions.json 就好了」。预算用完的句柄只许 deferred（留到
    // 下次启动继续），绝不许把启动路径拖住。
    {
      const hangFile = path.join(path.dirname(storeFile), 'sessions-hang.json')
      fs.writeFileSync(hangFile, JSON.stringify({
        version: 1,
        sessions: [],
        orphans: Array.from({ length: 4 }, (_, i) => ({
          key: 'a',
          instanceId: `hang-${i}`,
          model: 'deepseek/deepseek-v4-flash',
        })),
      }))
      const hangStore = new SessionHandleStore(hangFile)
      // 永远拿不到结果的上游：模拟黑洞代理 / 上游不响应
      const blackHole = { freebuffSession: () => new Promise(() => {}) }
      const started = Date.now()
      const res = await Promise.race([
        hangStore.cleanupOrphans(() => blackHole, { budgetMs: 300 }),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
      ])
      const elapsed = Date.now() - started
      assert.notEqual(res, 'timeout', '扫尾必须在预算内返回，绝不能挂住启动路径')
      assert.ok(elapsed < 2_500, `扫尾耗时必须受预算约束，实际 ${elapsed}ms`)
      assert.equal(res.cleaned, 0, '连不上时不得谎报已清理')
      assert.ok(res.failed + res.deferred >= 4, '未清理的句柄必须如实计入 failed/deferred')
      assert.equal(hangStore.listOrphans().length, 4, '预算用完的句柄必须保留（信息不丢）')
    }
    sm.getSnapshot()
    if (sm.hasLiveSlot()) await sm.release()
  }


  // (7.5) 结算挂起 ≠ 退款 0：上游回 freebucksRefundPending 时必须**保留句柄**
  //       并继续重放，绝不能在 1.5s 后就把 instanceId 丢掉、把 pending 读成
  //       "退款 0"。这是 2026-09 实测到的真 bug（旧代码只重放一次就 drop，
  //       而实测上游 1.5s/7s/17s/37s/67s 全是 pending）。
  {
    const sm = fbRuntimes.get('b').sessions
    const storeFile = fbRuntimes.handleStore.file
    mockMode = 'ok'
    mockFreebucks = null
    deleteFailuresLeft = 0
    sessionDeletes = 0
    deleteInstanceIds = []
    // 上游持续挂起：DELETE 只回 pending、不给金额
    mockRefundPending = true
    try {
      await sm.ensureSession('deepseek/deepseek-v4-flash')
      const live = sm.getSnapshot()
      assert.ok(live.instanceId, 'admit 后应有 instanceId')
      const instanceId = live.instanceId

      await sm.release()

      // 必须重放（>1 次）而不是试一次就放弃
      assert.ok(
        sessionDeletes >= 2,
        '挂起时必须继续重放 DELETE，实际只发了 ' + sessionDeletes + ' 次',
      )
      // 重放必须始终带同一个 instanceId（丢了就再也删不掉这条会话）
      for (const id of deleteInstanceIds) {
        assert.equal(id, instanceId, '重放必须带同一个 instanceId')
      }
      // 关键回归：句柄**绝不能丢**——丢了这笔预扣就永远要不回来
      const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
      const kept =
        onDisk.orphans.some((o) => o.instanceId === instanceId) ||
        onDisk.sessions.some((x) => x.instanceId === instanceId)
      assert.ok(kept, '结算挂起时 instanceId 必须保留在句柄存储里')
      // 绝不能把 pending 记成"退款 0"
      const snap = sm.getSnapshot()
      assert.notEqual(
        snap.lastRefund?.refund,
        0,
        'pending 不得被读成退款 0（那是把没结算完错读成退了 0 元）',
      )

      // —— 摘除走的是启动扫尾 cleanupOrphans（此刻已无 live session，
      //    release() 不会再发 DELETE）。先验证**仍挂起时扫尾也不摘**：
      const swept = await fbRuntimes.handleStore.cleanupOrphans(
        (key) => fbRuntimes.byKey.get(key)?.upstream,
      )
      assert.equal(swept.cleaned, 0, '仍挂起时扫尾不得宣称已清理')
      assert.ok(swept.failed >= 1, '仍挂起时应计入 failed 并保留句柄')
      const mid = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
      assert.ok(
        mid.orphans.some((o) => o.instanceId === instanceId),
        '仍挂起时扫尾后句柄必须还在',
      )

      // 现在让上游结算完成（终态、无金额 = 退款 0），扫尾应真正摘掉句柄
      mockRefundPending = false
      const swept2 = await fbRuntimes.handleStore.cleanupOrphans(
        (key) => fbRuntimes.byKey.get(key)?.upstream,
      )
      assert.equal(swept2.cleaned, 1, '结算到终态后扫尾应清理掉这条句柄')
      const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
      const stillThere =
        after.orphans.some((o) => o.instanceId === instanceId) ||
        after.sessions.some((x) => x.instanceId === instanceId)
      assert.ok(
        !stillThere,
        '拿到终态回执后句柄必须清掉（否则重启扫尾会无限重放）',
      )
    } finally {
      mockRefundPending = false
      if (sm.hasLiveSlot()) await sm.release()
    }
  }

  // (8) 最终失败也必须早退释放会话（不再等空闲释放 / 挂到过期白扣时长）
  mockFreebucks = null
  for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.freebucks = null
  mockMode = 'err_500_all'
  sessionPosts = 0
  sessionDeletes = 0
  completionAttempts = 0
  {
    const res = await fbChat({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'final-fail' }],
    })
    assert.equal(res.status, 429, await res.clone().text())
    await waitFor('最终失败后会话被早退释放', () => sessionDeletes >= 1, 3_000)
  }

  mockMode = 'ok'
  mockFreebucks = null
  await fbRuntimes.shutdown()
  fbServer.close()
  fs.rmSync(fbDir, { recursive: true, force: true })
}

// ===========================================================================
// (STALL) 全局请求闸门绝不允许无界排队
//
// 线上故障：进程一切正常（CPU/日志/控制台都对）却"一段时间完全不接单"，
// 只有重启才恢复。根因是旧 acquireRequestSlot 把超限请求 push 进一个**没有任何
// 超时**的 _waitQueue：只要有几个请求"占着槽位却永久挂起"（客户端声明了
// Content-Length 却不再发完请求体 → readRequestBody 的 for-await 永不返回），
// 槽位被永久吃掉，后续所有请求排进队列再也出不来。
//
// 本用例用真实 server + 真实半开 socket 复现该场景，断言：
//   1. 排满时后续请求**有界**返回 429 server_busy（而不是永久挂起）；
//   2. 半开请求被 bodyReadTimeoutMs 掐掉后，槽位与队列都回到 0。
// 旧实现下第 1 条会永久挂起 → 用例超时失败（真实红灯）。
{
  const stallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-stall-'))
  saveAccountUser(stallDir, {
    id: 'stall1',
    email: 'stall@example.com',
    authToken: 'token-stall-1',
  })
  const stCfg = loadConfig()
  stCfg.server.host = '127.0.0.1'
  stCfg.server.port = 0
  stCfg.server.apiKeys = ['sk-test']
  stCfg.upstream.credentialsDir = stallDir
  stCfg.session.pollIntervalSec = 3600
  stCfg.limits.maxConcurrentRequests = 2
  stCfg.limits.slotWaitMs = 800
  stCfg.limits.bodyReadTimeoutMs = 2_500

  const stRuntimes = new AccountRuntimes(stCfg)
  const stServer = await startServer({ config: stCfg, runtimes: stRuntimes })
  const stPort = stServer.address().port

  // 半开 chat 请求：声明很大的 Content-Length，只发一个字节就再也不发。
  const halfOpen = []
  for (let i = 0; i < 2; i += 1) {
    const sock = net.connect(stPort, '127.0.0.1')
    sock.on('error', () => {})
    await new Promise((r) => sock.on('connect', r))
    sock.write(
      'POST /v1/chat/completions HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Authorization: Bearer sk-test\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 999999\r\n\r\n',
    )
    sock.write('{"model":"deepseek/deepseek-v4-flash"')
    halfOpen.push(sock)
  }
  // 让两个请求都真正进入"占着槽位读 body"的状态
  await waitFor('两个半开请求占满全局槽位', () => {
    const s = requestSlotStats()
    return s.inFlight >= 2
  }, 3_000)

  const occupied = requestSlotStats()
  assert.equal(occupied.inFlight, 2, '两个半开请求应占满全部 2 个槽位')

  // 此刻来一个**完全正常**的请求：必须被有界拒绝，绝不永久排队。
  const t0 = Date.now()
  // 用本用例自己的 server（共享 chat() 的 server 在更早已经 close 了）
  const busy = await fetch(`http://127.0.0.1:${stPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'x' }],
    }),
  })
  const waited = Date.now() - t0
  assert.equal(
    busy.status,
    429,
    '闸门排满时必须有界拒绝（429 server_busy），而不是永久挂起',
  )
  const busyBody = await busy.json()
  assert.equal(busyBody.error.code, 'server_busy', '拒绝码必须是 server_busy')
  assert.ok(
    waited < 2_000,
    `排队必须是有界的：实测等待 ${waited}ms，应 < 2000ms（slotWaitMs=800）`,
  )

  // 半开请求被 bodyReadTimeoutMs 掐掉后，槽位与队列必须归零（无泄漏）。
  for (const sock of halfOpen) sock.destroy()
  await waitFor('半开请求超时后槽位全部归还', () => {
    const s = requestSlotStats()
    return s.inFlight === 0 && s.queued === 0
  }, 8_000)
  const after = requestSlotStats()
  assert.equal(after.inFlight, 0, '读 body 超时后必须归还槽位（不得泄漏）')
  assert.equal(after.queued, 0, '队列必须清空')

  await stRuntimes.shutdown()
  stServer.close()
  fs.rmSync(stallDir, { recursive: true, force: true })
}

// ===========================================================================
// (FBGATE) 封号判定的**两条**条件都必须拦（issue #11 实测）
//
// 上游对"余额不够"的封号判定有两条：
//   ① Freebucks 跑完了（今日池 daily.remaining <= 0）
//   ② 本次请求所需 Freebucks 高于剩余余额（balance < prices[model]）
// 曾经的实现只判 ②，于是"池子跑完但 balance 还留着数字"的账号会被放行，
// 照样送去撞封禁。本用例锁死两条都拦，并断言 reason 能区分是哪一条。
{
  const sm = new SessionManager({
    config: loadConfig(),
    accountKey: 'fbgate',
    upstream: {},
  })

  const price = 25
  const model = 'deepseek/deepseek-v4-flash'

  // ① 今日池跑完，但余额看着还够 —— 必须拦（这正是以前漏掉的那条）
  sm.freebucks = {
    balance: 100,
    daily: { limit: 85, spent: 85, remaining: 0, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const dailyGone = sm.freebucksFor(model)
  assert.equal(
    dailyGone.affordable,
    false,
    '今日池跑完（daily.remaining <= 0）必须拦——否则命中上游封号条件①',
  )
  assert.equal(dailyGone.reason, 'daily_exhausted', '必须标明是池子跑完')

  // ② 余额买不起本次请求 —— 必须拦
  sm.freebucks = {
    balance: 1,
    daily: { limit: 85, spent: 20, remaining: 65, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const poor = sm.freebucksFor(model)
  assert.equal(poor.affordable, false, '余额 < 单价 必须拦——上游封号条件②')
  assert.equal(poor.reason, 'balance_shortfall', '必须标明是余额不足')

  // 两条都不命中 → 放行（不能误伤正常账号）
  sm.freebucks = {
    balance: 100,
    daily: { limit: 85, spent: 20, remaining: 65, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const ok = sm.freebucksFor(model)
  assert.equal(ok.affordable, true, '额度充足必须放行（不得误伤）')
  assert.equal(ok.reason, null, '放行时不应有 reason')

  // `limit = 0` 表示"没有池子"，不是"池子跑完"——不得误判为耗尽
  sm.freebucks = {
    balance: 100,
    daily: { limit: 0, spent: 0, remaining: 0, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const noPool = sm.freebucksFor(model)
  assert.equal(
    noPool.affordable,
    true,
    'daily.limit=0 是"没有池子"，不是"池子跑完"，不得误拦',
  )

  // quotaExempt 账号不受池与余额限制
  sm.freebucks = {
    balance: 0,
    daily: { limit: 85, spent: 85, remaining: 0, resetAt: null },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: true,
    monthly: null,
  }
  assert.equal(
    sm.freebucksFor(model).affordable,
    true,
    'quotaExempt 账号不受池/余额限制',
  )

  // 每日池 resetAt 已过 → 本地数字视为过期，放行一次真实 admit 重新校准
  sm.freebucks = {
    balance: 0,
    daily: {
      limit: 85,
      spent: 85,
      remaining: 0,
      resetAt: new Date(Date.now() - 60_000).toISOString(),
    },
    wallet: { balance: 0 },
    prices: { [model]: price },
    quotaExempt: false,
    monthly: null,
  }
  const stale = sm.freebucksFor(model)
  assert.equal(
    stale.affordable,
    true,
    'resetAt 已过说明本地数字过期，必须放行重新校准（否则账号被永久锁死）',
  )
  assert.equal(stale.stale, true, '必须标记为 stale')
}

// (FBGATE-CONSISTENCY) 控制台的"额度不足"判定必须与后端 freebucksFor 的两条
// 封号条件一致 —— 曾经前端判了"今日池跑完"而后端没判，导致控制台显示"已用尽"
// 却仍被送去调度。这里用源码断言把两处钉在一起，防止再次漂移。
{
  const dashSrc = fs.readFileSync(
    new URL('../dashboard/app.js', import.meta.url),
    'utf8',
  )
  const smSrc = fs.readFileSync(
    new URL('../src/session-manager.js', import.meta.url),
    'utf8',
  )
  assert.ok(
    /daily\.remaining\)\s*<=\s*0[\s\S]{0,80}daily\.limit\)\s*>\s*0/.test(dashSrc),
    '控制台必须保留"今日池跑完"的判定（daily.remaining <= 0 且 limit > 0）',
  )
  assert.ok(
    /dailyRemaining\s*<=\s*0/.test(smSrc),
    '后端 freebucksFor 必须判定"今日池跑完"——否则与控制的分类口径漂移',
  )
  assert.ok(
    /shortOnBalance/.test(smSrc),
    '后端 freebucksFor 必须判定"余额买不起"',
  )
  // 后端必须能区分"池跑完"与"余额不足"，否则日志/错误信息会误导排查方向
  assert.ok(
    /daily_exhausted/.test(smSrc),
    '后端必须区分出 daily_exhausted（否则排查时只看到"余额不够"）',
  )
  assert.ok(
    /balance_shortfall/.test(smSrc),
    '后端必须区分出 balance_shortfall',
  )
  // 前端必须与后端一致地覆盖"池跑完"这条，不能只判余额
  assert.ok(
    /dailyGone/.test(dashSrc),
    '控制台必须保留 dailyGone（今日池跑完）判定',
  )
}

// (REFUND-COPY) 计费结论（2026-09-14 一手实测后重钉）不得被写回旧说法
//
// 上游 **一次 admit = 买断一小时**：POST 当场扣满整小时单价（实测 Freebucks
// 5 → 0，回执带 expiresAt）。早退 DELETE 的实际结果两本账不对称：
//   - session_units：**当场按比例退**（实测 1.1 → 0.2）
//   - Freebucks：只回 freebucksRefundPending，实测 3 次重放 DELETE、2 分钟
//     内**未到账**；而 24 个「账号 × 模型」组合里 22 个是 Freebucks 先见底
// 所以"早退会退还 Freebucks / 挂着空闲会话才花钱"是**已被证伪**的说法，必须
// 钉死：用户会照着它去调 idle_release_sec，方向正好是反的。
// 详见 docs/freebucks-strategy.html 与 docs/account-scheduling-and-refund.md §3。
{
  const dashSrc = fs.readFileSync(
    new URL('../dashboard/app.js', import.meta.url),
    'utf8',
  )
  const cfgSrc = fs.readFileSync(
    new URL('../src/config.js', import.meta.url),
    'utf8',
  )
  const yamlSrc = fs.readFileSync(
    new URL('../config.example.yaml', import.meta.url),
    'utf8',
  )
  const cssSrc = fs.readFileSync(
    new URL('../dashboard/style.css', import.meta.url),
    'utf8',
  )
  const settingsSrc = fs.readFileSync(
    new URL('../src/web/settings-store.js', import.meta.url),
    'utf8',
  )
  // 覆盖**整个仓库**：一开始只扫了 3 个文件，结果 README / bin/pricing.js /
  // docs/deployment.md / proxy.js 等 10+ 处漏网——其中 README 与 CLI 输出
  // 直接给用户看，错了最误导。改为遍历全仓（排除第三方与运行时数据）。
  // 2026-09-13 **反转**：早退 DELETE 会按实际占用退还 Freebucks（见文档 §3）。
  // 现在钉死的是"不退"这一类已被证伪的说法，防止它再被写回来。
  // 钉死的是**已被证伪**的那一类说法：早退能拿回 Freebucks / 挂着空闲才花钱 /
  // 越早释放越省。它们和实测（买断一小时，早退拿不回）正好相反。
  const STALE_COPY =
    /按实际占用退还\s*Freebucks|退还未用时长|退还未用部分|停止为空转时长付费|挂着的空闲会话(在按小时计价|才是花钱)|越早释放越省|早退.{0,12}省钱/
  const SKIP_DIR = new Set(['node_modules', '.git', 'data', 'data-test'])
  const walk = (dir, out = []) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!SKIP_DIR.has(ent.name)) walk(path.join(dir, ent.name), out)
      } else if (/\.(js|mjs|cjs|md|ya?ml|json)$/.test(ent.name)) {
        out.push(path.join(dir, ent.name))
      }
    }
    return out
  }
  const root = new URL('..', import.meta.url).pathname
  const scanned = walk(root).filter((p) => !p.includes('/test/repro-'))
  assert.ok(scanned.length > 20, `全仓扫描应覆盖足够多文件，实际 ${scanned.length}`)
  for (const abs of scanned) {
    const rel = path.relative(root, abs)
    // 本文档（§3/§7）需要**引用**这些旧说法来解释纠错过程，豁免；
    // smoke 自身含正则字面量，也豁免（它就是这个守卫）。
    if (rel === 'docs/account-scheduling-and-refund.md') continue
    if (rel === 'test/smoke.mjs') continue
    // Agent Notes 记录的是**历史决策与它的错在哪**（本次反转正需要引用旧说法），豁免。
    if (rel.startsWith('.agents/notes/')) continue
    // AGENTS.md 是最高优先级约定，**必须一起扫**：它一旦写着旧口径，后来的人会直接照着做。
    // CLAUDE.md 只是指向它的符号链接，跳过以免同一内容报两次。
    if (rel === 'CLAUDE.md') continue
    const src = fs.readFileSync(abs, 'utf8')
    const hit = src.match(STALE_COPY)
    assert.ok(
      !hit,
      `${rel} 出现了已被证伪的说法「${hit && hit[0]}」（早退 DELETE **会**按实际占用退还 Freebucks；pending = 结算未完成，见 docs/account-scheduling-and-refund.md §3）`,
    )
  }
  // idleReleaseSec 现在是**付费时段结束之后**的空闲释放时长（付费时段内一律不释放，
  // 见 session-manager._armIdleRelease）。保持 60s：过期后尽快腾槽位给别的模型。
  assert.ok(
    /idleReleaseSec:\s*60/.test(cfgSrc),
    'config.js 的 idleReleaseSec 默认应为 60s（付费时段结束后的空闲释放）',
  )
  assert.ok(
    /idle_release_sec:\s*60/.test(yamlSrc),
    'config.example.yaml 的 idle_release_sec 默认应为 60s',
  )
  // 退款追问仍是常驻行为：pending 期间要靠重放 DELETE 取回执。实测确认
  // pending 在本小时内不落地（所以**不能**把它当成"钱会回来"来决策释放时机），
  // 但句柄不能丢——丢了连追问的机会都没有。
  const handlesSrc = fs.readFileSync(
    new URL('../src/session-handles.js', import.meta.url),
    'utf8',
  )
  assert.ok(
    /async sweepPendingRefunds/.test(handlesSrc),
    '会话句柄库必须提供 sweepPendingRefunds（周期性追问待结算退款）',
  )
  const serveSrc2 = fs.readFileSync(
    new URL('../bin/serve.js', import.meta.url),
    'utf8',
  )
  assert.ok(
    /sweepPendingRefunds/.test(serveSrc2) && /setInterval/.test(serveSrc2),
    'serve.js 必须周期性调用 sweepPendingRefunds——只扫一次等于放弃那笔预扣',
  )
  // 控制台必须给出"推荐值"（按账号池实时算），而不是让用户猜
  assert.ok(
    /function idleReleaseAdvice/.test(dashSrc),
    '控制台必须提供 idleReleaseAdvice（按账号池实时算推荐值）',
  )
  // (REUSE-UI) 「我们在省钱」必须能一眼看到：全局复用率 + 每账号 admit/reuse 计数。
  // 复用发生在已买断的一小时内 → 边际成本 0，所以复用率就是省掉的重买比例。
  {
    const src = fs.readFileSync(
      new URL('../dashboard/app.js', import.meta.url),
      'utf8',
    )
    assert.ok(
      /会话复用率/.test(src),
      '总览必须有「会话复用率」卡片（让用户直观看到在省钱）',
    )
    assert.ok(
      /a\.admitCount/.test(src) && /a\.reuseCount/.test(src),
      '账号行必须显示 admitCount / reuseCount（买过几条 · 复用几次）',
    )
    const mgrSrc = fs.readFileSync(
      new URL('../src/session-manager.js', import.meta.url),
      'utf8',
    )
    assert.ok(
      /this\.reuseCount \+= 1/.test(mgrSrc),
      'ensureSession 的热路径必须累加 reuseCount',
    )
  }

  // (PAID-HOUR-UI) 付费时段内 `rem=0` 是"已付款"的正常状态，绝不能标成「额度不足」。
  // 少了这条，"买断一小时"上线后每个正在被正常使用的账号都会显示成耗尽。
  {
    const src = fs.readFileSync(
      new URL('../dashboard/app.js', import.meta.url),
      'utf8',
    )
    assert.ok(
      /inPaidWindow/.test(src),
      'classifyAccount 必须用付费时段（inPaidWindow）把 rem=0 的已付款账号判为可用',
    )
    assert.ok(
      /if \(fb && !inPaidWindow\)/.test(src),
      'Freebucks 耗尽判定必须在付费时段之外才生效',
    )
    // 付费时段依据 expiresAt 必须真的传到前端，否则上面的判定永远不成立
    const ctxSrc = fs.readFileSync(
      new URL('../src/app-context.js', import.meta.url),
      'utf8',
    )
    assert.ok(
      /expiresAt: snap\.expiresAt/.test(ctxSrc),
      '账号快照必须把 session.expiresAt 暴露给控制台（付费时段判定的依据）',
    )
  }
  assert.ok(
    /idle-release-advice/.test(dashSrc),
    '控制台必须渲染推荐值区块',
  )

  // (LOW-BALANCE-GROUP) 用户自定义「低额度」分组：余额低于阈值就归类过去，
  // 但**仍然参与调度**——它是预警不是故障。默认 15 FB（≈ deepseek-v4-flash 单价）。
  assert.ok(
    /id: 'lowbalance'/.test(dashSrc),
    "控制台必须有 'lowbalance' 分组",
  )
  assert.ok(
    /function lowBalanceHit/.test(dashSrc),
    '低额度分组必须有 lowBalanceHit 判定',
  )
  // 归到「低额度」之后仍照常参与选号：该判定绝不能出现在后端调度路径里
  for (const rel of ['src/proxy.js', 'src/app-context.js', 'src/session-manager.js']) {
    let src = ''
    try { src = fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8') } catch { continue }
    assert.ok(
      !/lowBalanceThreshold|lowbalance/.test(src),
      rel + ' 不得读取 lowBalanceThreshold：低额度只是前端分组，不能影响调度',
    )
  }
  assert.ok(
    /lowBalanceThreshold: 15/.test(settingsSrc),
    'settings-store 的 lowBalanceThreshold 默认应为 15',
  )
  // (WIDE-LAYOUT) 账号表 10 列，容器过窄会把「时间轴」挤成竖排单字
  assert.ok(
    /max-width: 1560px/.test(cssSrc),
    '#app 容器应放宽到 1560px（账号表列多）',
  )
  assert.ok(
    /\.acct-time/.test(cssSrc),
    '时间轴单元格需要 .acct-time 样式（禁止被压成竖排单字）',
  )
  assert.ok(
    /acct-time/.test(dashSrc),
    'accountTimeCell 必须使用 .acct-time 类',
  )
  // 推荐值是「按账号池实时算」的，所以设置页必须真的把账号拉进来。
  // /api/proxy 只回代理信息、不含 session.model —— 曾因此让推荐值恒等于默认值
  // （永远显示"还没有账号"），点进去看到的建议是假的。这里钉死这个数据依赖。
  assert.ok(
    /async function renderProxySettings[\s\S]{0,900}api\('\/api\/overview'\)/.test(dashSrc),
    'renderProxySettings 必须额外拉 /api/overview 填充 state.accounts（推荐值依赖它）',
  )
}

// ===========================================================================
// (AGENT-LEAK) 更新凭证 / 改代理池丢弃 runtime 时，必须关闭出网 agent
//
// 每个账号 runtime 构造时都会 new ProxyAgent（带 keep-alive 连接池）。
// "更新凭证/导入账号/切换代理池"都会重建 runtime —— 若旧 agent 不 close，
// 它的 socket 会随操作次数单调累积，表现为**运行越久越慢**、连接越难建立。
// 修复前实测：12 轮更新 → 13 个常驻 socket；修复后 → 1 个。
{
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((r) => origin.listen(0, '127.0.0.1', r))
  const oport = origin.address().port

  // 一个真正会转发 CONNECT 的代理，让请求能正常完成、连接进入 keep-alive
  const proxySrv = http.createServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  proxySrv.on('connect', (req, clientSock) => {
    const [host, port] = req.url.split(':')
    const up = net.connect(Number(port), host, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      up.pipe(clientSock)
      clientSock.pipe(up)
    })
    up.on('error', () => clientSock.destroy())
    clientSock.on('error', () => up.destroy())
  })
  await new Promise((r) => proxySrv.listen(0, '127.0.0.1', r))
  const pport = proxySrv.address().port
  const socks = () =>
    new Promise((r) => proxySrv.getConnections((_, n) => r(n)))

  const leakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-leak-'))
  const leakCfg = loadConfig()
  leakCfg.server.credentialsDir = leakDir
  leakCfg.upstream.credentialsDir = leakDir
  leakCfg.upstream.proxy = `http://127.0.0.1:${pport}`
  leakCfg.upstream.apiBase = `http://127.0.0.1:${oport}`
  leakCfg.session.pollIntervalSec = 3600
  saveAccountUser(leakDir, {
    id: 'leak1',
    email: 'leak@example.com',
    authToken: 'tok1',
  })

  const leakRuntimes = new AccountRuntimes(leakCfg)
  const hit = async () => {
    const rt = leakRuntimes.get('leak1')
    try {
      const res = await rt.upstream.raw('/api/v1/me', {
        method: 'GET',
        timeoutMs: 5_000,
      })
      await res.text()
    } catch {
      // 忽略：本用例只关心连接是否被回收
    }
  }

  try {
    await hit()
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(await socks(), 1, '首次请求后应恰好有 1 条 keep-alive 连接')

    // 反复"更新凭证"：每次都 invalidate（丢弃旧 runtime）
    for (let i = 0; i < 12; i += 1) {
      await leakRuntimes.invalidate('leak1')
      await hit()
    }
    await new Promise((r) => setTimeout(r, 800))
    const after = await socks()
    assert.ok(
      after <= 3,
      `12 轮"更新凭证"后 socket 必须被回收（实测 ${after} 个）；` +
        '累积即说明旧 runtime 的出网 agent 没有被 close',
    )
  } finally {
    await leakRuntimes.shutdown()
    origin.close()
    proxySrv.close()
    fs.rmSync(leakDir, { recursive: true, force: true })
  }
}

// --- 回归：客户端在"首字节前的静默等待"中断开 → 绝不钉死账号并发 ---
// 线上症状：跑着跑着完全不接单，只有重启才恢复。根因是调度阶段的等待
// （全局槽位 / 账号 chat 锁）完全不感知客户端断开：客户端（DSH/sub2api）早已
// 超时走人，代理却还在闷等，并且拿到账号锁后继续把整个上游流程跑完——
// 死请求占着账号并发（默认仅 2，且粘性调度把请求集中到同一账号），
// 攒够几个就再也没有新请求能拿到锁。
{
  const cgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-clientgone-'))
  saveAccountUser(cgDir, { id: 'cg', email: 'cg@example.com', authToken: 'token-cg' })
  const cgConfig = loadConfig()
  cgConfig.server.host = '127.0.0.1'
  cgConfig.server.port = 0
  cgConfig.server.apiKeys = ['sk-test']
  cgConfig.upstream.credentialsDir = cgDir
  cgConfig.session.pollIntervalSec = 3600
  // 单账号、并发 1：唯一槽位被占用后，第二个请求必须排队 —— 正是线上场景。
  cgConfig.limits.accountMaxConcurrency = 1
  cgConfig.limits.streamIdleTimeoutSec = 1
  // 把账号锁等待拉长，确保"断开前"确实处于等待态（旧代码会一直等下去）。
  cgConfig.limits.accountChatWaitMs = 120_000
  cgConfig.limits.schedulingBudgetMs = 60_000

  const cgRuntimes = new AccountRuntimes(cgConfig)
  const cgServer = await startServer({
    config: cgConfig,
    runtimes: cgRuntimes,
    ...(() => {
      const rt = cgRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const cgPort = cgServer.address().port

  mockMode = 'hold_once'
  sessionPosts = 0
  completionAttempts = 0

  // A：占住唯一并发槽（流被挂起保持打开）
  const resA = await fetch(`http://127.0.0.1:${cgPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hold' }],
    }),
  })
  assert.equal(resA.status, 200)
  await waitFor('A 应占住唯一并发槽', () => cgRuntimes.chatInFlight('cg') === 1)

  // B：用裸 socket 发第二个流式请求（要能在等待中途"拔线"——fetch 做不到），
  // 拿到账号锁之前就断开，模拟客户端等不住自行超时。
  const beforeAttempts = completionAttempts
  const rawSock = net.connect(cgPort, '127.0.0.1')
  const bodyStr = JSON.stringify({
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'will-abort' }],
  })
  await new Promise((resolve, reject) => {
    rawSock.once('connect', resolve)
    rawSock.once('error', reject)
  })
  rawSock.write(
    'POST /v1/chat/completions HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${cgPort}\r\n` +
      'Authorization: Bearer sk-test\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(bodyStr)}\r\n` +
      'Connection: close\r\n\r\n' +
      bodyStr,
  )
  // 等 B 真正进入"排队等账号锁"状态，再断开。旧代码在这里会一直等到
  // accountChatWaitMs（120s）才对客户端超时；新代码感知断开立即退出。
  await new Promise((r) => setTimeout(r, 300))
  rawSock.destroy()

  // 关键断言：B 断开后，死请求不得继续推进上游请求。
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, 1_500))
  assert.equal(
    completionAttempts,
    beforeAttempts,
    '客户端断开后代理仍继续推进上游请求（死请求钉死账号并发）',
  )

  // 释放 A 的挂起流，确认账号并发能正常回归 0（槽位没有泄漏）。
  releaseHoldStreams()
  try {
    await resA.text()
  } catch {
    /* 被 idle 掐断也符合预期 */
  }
  await waitFor(
    'A 结束后账号并发应回到 0（锁未泄漏）',
    () => cgRuntimes.chatInFlight('cg') === 0,
    8_000,
    25,
  )
  assert.ok(
    Date.now() - t0 < 20_000,
    `断开处理应快速收场, took ${Date.now() - t0}ms`,
  )

  await cgRuntimes.shutdown()
  cgServer.close()
  fs.rmSync(cgDir, { recursive: true, force: true })
  mockMode = 'ok'
}

// ===========================================================================
// (DATA-FILES) 数据目录 JSON 的统一读取口径
//
// 真实事故：镜像升级后容器起不来，用户删掉几个 /data/*.json 才恢复，而日志里
// 只有一行容易被忽略的 warn。根因是每个 store 各自 try/catch，坏了就当空数据
// 继续跑 —— 于是"配置悄悄回落默认值""账号履历全丢"都没人告诉你。
// 这里锁死三件事：
//   ① 损坏文件必须被**显式记账**（启动横幅 / 控制台自检读的就是这份账）；
//   ② users.json 损坏**绝不静默重建管理员**（loadStatus 必须是 invalid）；
//   ③ 派生缓存（catalog-cache.json）损坏时不能安静地当"从没同步过"，要留证。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-datastore-'))
  const write = (name, content) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    return p
  }
  const broken = '{"broken": tru' // 截断 + 非法字面量，最接近写盘被中断的真实形态

  // ① 六个控制面 store：正常文件 → ok；损坏文件 → invalid（都登记进审计）
  const usersPath = write('users.json', JSON.stringify({ version: 1, users: [] }))
  const settingsPath = write('settings.json', JSON.stringify({ version: 1, accountMaxConcurrency: 3 }))
  const proxiesPath = write('proxies.json', broken)
  const modelsPath = write('custom-models.json', JSON.stringify({ version: 1, models: [], hidden: [] }))
  const webSessPath = write('web-sessions.json', JSON.stringify({ version: 1, sessions: [] }))

  const userStore = new UserStore(usersPath)
  assert.equal(userStore.loadStatus, 'ok', 'users.json 正常时必须报 ok')
  const settingsStore = new SettingsStore(settingsPath)
  assert.equal(settingsStore.get().accountMaxConcurrency, 3, 'settings.json 必须能读回设置')
  const proxyStore = new ProxyStore(proxiesPath)
  assert.equal(proxyStore.loadStatus, 'invalid', '损坏的 proxies.json 必须报 invalid')
  assert.deepEqual(proxyStore.list(), [], '损坏的代理池按空处理（不抛）')

  // 代理池里的脏值（null / 数字 / 畸形 URL）必须被丢弃：原样传下去会在
  // 构造出网 agent 时抛 ERR_INVALID_URL —— 那是启动后的第一次出网就崩。
  {
    const dirtyProxies = write('proxies-dirty.json', JSON.stringify({
      version: 1,
      proxies: [null, 123, {}, 'not a url', 'http://127.0.0.1:7890', '  socks5://127.0.0.1:1080  '],
    }))
    const store = new ProxyStore(dirtyProxies)
    assert.doesNotThrow(() => store.list())
    assert.deepEqual(
      store.list(),
      ['http://127.0.0.1:7890', 'socks5://127.0.0.1:1080'],
      '只保留合法代理 URL（去空白），脏值全部丢弃',
    )
    assert.ok(
      dirtyDataFiles().some((e) => e.file === path.resolve(dirtyProxies)),
      '丢弃脏代理必须记账（否则用户以为代理设置被静默重置）',
    )
    const { sanitizeProxyList: san } = await import('../src/util/json-store.js')
    assert.deepEqual(san([{ url: 'http://a:1' }]), { urls: [], dropped: 1 }, '对象形态的代理条目按非法处理')
    assert.deepEqual(san('http://a:1'), { urls: [], dropped: 0 }, '非数组输入不抛异常')
  }
  const modelStore2 = new ModelStore(modelsPath)
  assert.equal(modelStore2.loadStatus, 'ok', 'custom-models.json 正常时必须报 ok')
  const webSessions = new WebSessionStore(webSessPath, 3600_000)
  assert.equal(webSessions.loadStatus, 'ok', 'web-sessions.json 正常时必须报 ok')

  // 缺文件 = missing（首次启动），不是 invalid —— 否则全新部署会被误报成损坏
  const missingStore = new ProxyStore(path.join(dir, 'nope.json'))
  assert.equal(missingStore.loadStatus, 'missing', '文件不存在必须报 missing 而不是 invalid')

  // 审计按**绝对路径**记账（同一进程里可能有多个同名文件，如测试各自的临时目录）
  const byPath = new Map(dataFileAudit().map((e) => [e.file, e]))
  const rec = byPath.get(path.resolve(proxiesPath))
  assert.equal(rec?.status, 'invalid', '损坏文件必须出现在装载审计里')
  assert.ok(rec?.reason, '损坏必须带上原因（否则用户无从下手）')
  assert.ok(
    invalidDataFiles().some((e) => e.file === path.resolve(proxiesPath)),
    '损坏文件必须出现在 invalidDataFiles()（启动横幅/控制台自检都读它）',
  )

  // ② users.json 损坏：状态必须是 invalid，且**不能**被当成"没有账号"
  //    —— 否则 bin/serve.js 的拒绝启动分支永远走不到，又会静默重建管理员。
  const brokenUsers = write('users-broken.json', broken)
  const brokenUserStore = new UserStore(brokenUsers)
  assert.equal(
    brokenUserStore.loadStatus,
    'invalid',
    '损坏的 users.json 必须报 invalid（bin/serve.js 据此拒绝启动）',
  )
  assert.equal(brokenUserStore.users.length, 0, '损坏时不得凭空造出用户')

  // ③ 派生缓存损坏：必须登记为 invalid，且把损坏文件挪到一边留证（不静默覆盖）
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-catalogleak-'))
  const cachePath = path.join(cacheDir, CATALOG_CACHE_FILENAME)
  fs.writeFileSync(cachePath, broken)
  const quarantined = quarantineFile(cachePath)
  assert.ok(quarantined && fs.existsSync(quarantined), '损坏的派生缓存必须被挪走留证')
  assert.ok(!fs.existsSync(cachePath), '挪走后原路径应为空，交给同步重新生成')
  assert.ok(
    quarantined.includes('.corrupt-'),
    '备份文件名必须带 .corrupt- 前缀，便于用户识别与清理',
  )

  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(cacheDir, { recursive: true, force: true })
}

// ===========================================================================
// (DATA-ENTRIES) 数据文件里的**非法条目**绝不能把启动带崩
//
// 真实故障（v1.13.0 定位并修复）：某些历史版本/手工编辑会在数组里留下 null 或
// 非对象条目，而各 store 原先直接信任整个数组，于**构造期**就抛 TypeError：
//   - web-sessions.json 的 [null] → _prune() 读 s.expiresAt → 进程退出
//     （还没开始监听端口 → docker 里就是"更新镜像后起不来"）；
//   - login-flows.json 的 [null]  → load() 读 f.id → 同上；
//   - users.json 混入 null/非对象 → all() 读 u.username → 同上。
// 这些都是**合法 JSON**，语法级自检一律报 ok，所以"自检说正常、进程起不来"。
// 现在口径：逐条丢弃坏条目 + 留证 + 审计区分"文件损坏"与"脏条目"，绝不因此拒绝启动。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-dataentries-'))
  const write = (name, body) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
    return p
  }

  // ① 纯函数：坏条目被丢弃、好条目保留、无数组时为空
  {
    const mixed = ensureObjectEntries(
      { items: [null, 1, 'x', { id: 'ok' }] },
      'items',
      (i) => Boolean(i) && typeof i === 'object' && !Array.isArray(i),
    )
    assert.equal(mixed.items.length, 1, '非法条目必须被丢弃，合法条目必须保留')
    assert.equal(mixed.dropped, 3, '丢弃数量必须如实上报')
    assert.ok(mixed.reason && /非法条目/.test(mixed.reason), '丢弃必须给出原因摘要')
    const none = ensureObjectEntries({}, 'items', () => true)
    assert.deepEqual(none.items, [], '没有该字段时按空数组处理')
    assert.equal(none.dropped, 0, '没有字段时不算丢弃')
  }

  // ② web-sessions.json：混入 null 曾让服务在监听端口之前就崩
  {
    const p = write('ws-dirty.json', { version: 1, sessions: [null, { token: 't1', username: 'a', createdAt: 'x', expiresAt: new Date(Date.now() + 3600_000).toISOString() }] })
    let store
    assert.doesNotThrow(() => { store = new WebSessionStore(p, 3600_000) }, '含 null 的 web-sessions.json 绝不能在构造期抛')
    assert.equal(store.sessions.length, 1, '合法会话必须保留（用户不该被莫名登出）')
    assert.equal(store.droppedEntries, 1, '丢弃条数必须记账')
    assert.ok(store.droppedBackup && fs.existsSync(store.droppedBackup), '被丢弃的原文必须留证（丢数据不能丢证据）')
    assert.equal(store.loadStatus, 'ok', '文件本身合法 → 状态仍是 ok，不是"损坏"')
    const rec = dataFileAudit().find((e) => e.file === path.resolve(p))
    assert.equal(rec?.droppedEntries, 1, '审计里必须能看到"脏条目"')
    assert.ok(
      dirtyDataFiles().some((e) => e.file === path.resolve(p)),
      '脏条目文件必须出现在 dirtyDataFiles()（控制台与启动日志据此区分处置办法）',
    )
    assert.ok(
      !invalidDataFiles().some((e) => e.file === path.resolve(p)),
      '"脏条目"不能报成"文件损坏"——处置办法完全不同（前者无需人工干预）',
    )
  }

  // ③ login-flows.json：混入 null 曾在 load() 里抛（同样是启动期崩溃）
  {
    const p = write('lf-dirty.json', { version: 1, flows: [null, { id: 'f1', status: 'pending', createdAt: 'x' }] })
    let mgr
    assert.doesNotThrow(() => {
      mgr = new LoginFlowManager({ file: p, credentialsDir: path.join(dir, 'cred'), config: {}, onCredentialSaved: null })
    }, '含 null 的 login-flows.json 绝不能在构造期抛')
    mgr.shutdown()
    assert.equal(mgr.flows.size, 1, '合法登录流程必须保留')
    assert.equal(mgr.droppedEntries, 1, '丢弃条数必须记账')
    assert.doesNotThrow(() => mgr.list(), 'list() 不能在脏数据后仍抛')
  }

  // ④ users.json：混入 null 曾让 all() 在启动期抛；好用户必须留下
  {
    const p = write('users-dirty.json', {
      version: 1,
      users: [null, 'x', { username: 'admin', salt: 's', passwordHash: '00', role: 'admin', apiKey: 'k' }],
    })
    let store
    assert.doesNotThrow(() => { store = new UserStore(p) }, '含 null 的 users.json 绝不能在构造期抛')
    assert.equal(store.users.length, 1, '合法用户必须保留（否则等于账号被删）')
    assert.equal(store.loadStatus, 'ok', '还有可用用户时按 ok 处理')
    assert.equal(store.all().length, 1, 'all() 必须能在脏数据之后正常返回')
    assert.ok(store.getByUsername('admin'), '合法管理员必须可登录')
  }

  // ⑤ users 数组**全部**非法 = 拿不到任何登录凭据 → 必须按损坏拒绝启动，
  //    绝不能当成"还没有账号"而静默重建 admin（那会让人以为账号全丢了）
  {
    const p = write('users-allbad.json', { version: 1, users: [null, 1, 'x'] })
    const store = new UserStore(p)
    assert.equal(store.loadStatus, 'invalid', 'users 数组全非法必须报 invalid（bin/serve.js 据此拒绝启动）')
    assert.equal(store.users.length, 0, '不得凭空造出用户')
  }

  // ④b UTF-8 BOM：Windows 记事本 / 导出工具写出的文件开头带 U+FEFF。
  //     它是无害的，但 JSON.parse 直接报 "Unexpected token '\uFEFF'" →
  //     users.json 被判"损坏" → 拒绝启动（真实用户场景）。必须剥掉。
  {
    const p = path.join(dir, 'users-bom.json')
    fs.writeFileSync(
      p,
      '\uFEFF' + JSON.stringify({ version: 1, users: [{ username: 'admin', salt: 's', passwordHash: '00', role: 'admin', apiKey: 'k' }] }),
    )
    const store = new UserStore(p)
    assert.equal(store.loadStatus, 'ok', '带 BOM 的 users.json 必须能正常读取（BOM 要剥掉，别当成损坏）')
    assert.equal(store.users.length, 1, '带 BOM 时用户数据必须完整')
    const sess = path.join(dir, 'ws-bom.json')
    fs.writeFileSync(sess, '\uFEFF' + JSON.stringify({ version: 1, sessions: [] }))
    assert.doesNotThrow(() => new WebSessionStore(sess, 3600_000), '带 BOM 的 web-sessions.json 不能抛')
  }

  // ⑤b 脏凭据文件必须被**点名**，不能静默消失（用户会以为账号丢了）
  {
    const credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-creds-'))
    fs.writeFileSync(path.join(credDir, 'good.json'), JSON.stringify({
      id: 'id-1', email: 'a@b.com', authToken: 't',
    }))
    fs.writeFileSync(path.join(credDir, 'broken.json'), '{"broken": tru')
    fs.writeFileSync(path.join(credDir, 'notoken.json'), JSON.stringify({ id: 'id-2', email: 'c@d.com' }))
    // id 是 '.' → safeAccountStem 会抛；以前这个异常直接冒到启动流程把服务带崩
    fs.writeFileSync(path.join(credDir, 'badkey.json'), JSON.stringify({ id: '.', email: 'x@y.com', authToken: 't' }))
    let accounts
    assert.doesNotThrow(() => { accounts = listAccounts(credDir) }, '无法当文件名的账号 key 不能让 listAccounts 抛异常')
    assert.equal(accounts.length, 1, '只有合法凭据能进账号列表')
    assert.equal(
      invalidCredentialFiles.length,
      3,
      '脏凭据文件（含 key 非法的）必须被记账（否则控制台里账号凭空消失、无从排查）',
    )
    assert.ok(
      invalidCredentialFiles.some((p) => p.endsWith('badkey.json')),
      'key 非法的凭据也必须被点名，而不是让服务崩溃',
    )
    assert.ok(
      invalidCredentialFiles.some((p) => p.endsWith('broken.json')) &&
        invalidCredentialFiles.some((p) => p.endsWith('notoken.json')),
      '必须点名到具体文件',
    )
    fs.rmSync(credDir, { recursive: true, force: true })
  }

  // ⑥ sessions.json / account-state.json 的脏条目只能降级，不能抛
  {
    const p = write('sh-dirty.json', { version: 1, sessions: [null], orphans: [null, { key: 'a', instanceId: 'i' }] })
    let sh
    assert.doesNotThrow(() => { sh = new SessionHandleStore(p) }, '含 null 的会话句柄索引绝不能抛')
    // 「控制台说一切正常、进程却起不来」的教训：脏条目必须记账（否则删 sessions.json
    // 就成了唯一出路）。合法句柄要留下，坏条目要留证，文件本身仍算 ok。
    assert.equal(sh.loadStatus, 'ok', '含脏条目的 sessions.json 仍应算 ok（不是损坏）')
    assert.equal(sh.listOrphans().length, 1, '合法句柄必须保留（否则那些槽位再也回收不了）')
    assert.equal(sh.listOrphans()[0].instanceId, 'i', '保留的必须是有 key+instanceId 的那条')
    const shRec = dataFileAudit().find((e) => e.file === path.resolve(p))
    assert.equal(shRec?.droppedEntries, 2, '丢弃条数必须记账（控制台据此显示「脏条目」）')
    assert.ok(shRec?.droppedBackup && fs.existsSync(shRec.droppedBackup), '被丢弃的原文必须留证')
    assert.equal(shRec?.openHandles, 1, '待结算句柄数必须登记（控制台「系统」页据此提示）')
    assert.ok(
      !invalidDataFiles().some((e) => e.file === path.resolve(p)),
      '脏条目不能报成文件损坏（处置办法不同：前者无需人工干预）',
    )
    // 结构完全不对（sessions 不是数组）同样只是降级，不得抛
    const bad = write('sh-shape.json', { version: 1, sessions: 'oops', orphans: [] })
    assert.doesNotThrow(() => new SessionHandleStore(bad), 'sessions 字段结构不对绝不能抛')
    const ast = write('as-dirty.json', { version: 1, accounts: { a: null, b: 'x', c: { requests: 1 } } })
    const { AccountStateStore } = await import('../src/account-state-store.js')
    assert.doesNotThrow(() => new AccountStateStore(ast), '含脏记录的账号账本绝不能抛')
  }

  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
// (CONSOLE-REFRESH) 控制台「局部刷新」必须是原地更新，不能"多出一条栏目"
//
// 实测故障：总览页点「局部刷新」会多出一条版面、旧内容还在。根因是刷新用
// $('.table-wrap') 选中了**第一个分区的表**，把"整张新表"替换进去 —— 新表被塞
// 进第一个 <details>，旧分区原样留着。用户页更直接：把 view.innerHTML 清空重建。
// 这里用源码断言把两处钉死（这两个函数没法在 node 里直接跑，但结构是确定的）。
{
  const dashSrc = fs.readFileSync(
    new URL('../dashboard/app.js', import.meta.url),
    'utf8',
  )
  assert.ok(
    /id: 'accounts-sections'/.test(dashSrc),
    '账号分区必须有个带 id 的专用容器（局部刷新按它整体替换）',
  )
  assert.ok(
    /\$\('#accounts-sections'\)/.test(dashSrc),
    '局部刷新必须定位到 accounts-sections，而不是第一个 .table-wrap',
  )
  assert.ok(
    !/\$\('\.table-wrap', \$\('#app'\)\)/.test(dashSrc),
    '不得再用 $(".table-wrap", …) 做刷新定位——那正是"多出一条栏目"的根因',
  )
  assert.ok(
    /function refreshUsersTable/.test(dashSrc) && !/onclick: \(\) => renderUsers\(view\)/.test(dashSrc),
    '用户页「局部刷新」必须走 refreshUsersTable，不能 renderUsers(view) 重建整页',
  )
  // SVG 图标必须补自闭合斜杠：手写 <circle ...> 会吞掉相邻节点（同一类渲染错乱）
  assert.ok(
    /function normalizeSvgPaths/.test(dashSrc) && /normalizeSvgPaths\(paths\)/.test(dashSrc),
    'icon() 必须对 SVG 片段做自闭合归一，否则相邻节点会被解析器吞掉',
  )
}


// (SRC-GUARD) 源码级防回归：变量遮蔽与被改名的残留引用。
//
// 真实事故：`src/web/api.js` 的 handle() 里 `const path = url.pathname` 把
// `import path from 'node:path'` 整个遮蔽，`/api/system/data-status` 里
// `path.basename()` 变 "is not a function" → 该接口一路 500 到用户手里；
// 修名后又在同文件漏改一行（`No route for ${method} ${path}`）→ ReferenceError。
// 这两种都只在"运行时真的调到那一行"才炸，静态自检必须兜住。
{
  const srcFiles = ['../src/web/api.js', '../src/proxy.js', '../src/server.js']
  for (const rel of srcFiles) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
    const name = rel.replace('../', '')
    const usesNodePath = /^\s*import\s+(?:\*\s+as\s+)?path\s*,?\s*(?:from\s+)?['"]node:path['"]/m.test(src)
    // ① 不得在局部重新声明 `path`（会遮蔽 node:path 模块）
    assert.ok(
      !/\bconst\s+path\s*=/.test(src),
      `${name}: 不得用 const path = ... 遮蔽 node:path 模块（曾导致 path.basename is not a function）`,
    )
    // ② 路由变量必须叫 route/pathname，不得再出现 `path === '/...'` 这种旧命名
    assert.ok(
      !/\bpath\s*===\s*['"]\//.test(src),
      `${name}: 路由变量必须叫 route/pathname，不得沿用已废弃的 path`,
    )
    // ③ 模板串里不得再引用裸 path：改名只改一半就是这个形态（ReferenceError）
    assert.ok(
      !/\$\{[^}]*\bpath\b[^}]*\}/.test(src),
      `${name}: 模板串里引用了裸 path（改名漏改一行 → ReferenceError）`,
    )
    // ③ 用了 node:path 就必须真的 import 了它
    if (/\bpath\.(?:basename|join|resolve|dirname|extname|sep)\b/.test(src)) {
      assert.ok(usesNodePath, `${name}: 用了 path.* 就必须 import path from 'node:path'`)
    }
  }
}


// (REFUND-QUEUE) 待结算退款队列：这是**钱**，行为必须钉死。
//
// 语义（见 .agents/notes/implemented/bug-fix/2026-09-13-refund-reversed.md）：
//   - 上游回 freebucksRefundPending => 结算未完成，**入队并持续重放 DELETE 追问**；
//   - 只有拿到终态回执（含 refund: 0）才允许出队；
//   - 重放失败 / 账号没了 / 仍 pending，一律**保留记录**——绝不静默丢弃那笔预扣。
{
  const refundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-refund-'))
  const refundFile = path.join(refundDir, 'sessions.json')
  const store = new SessionHandleStore(refundFile)
  try {
    store.notePendingRefund('k1', 'inst-1', 'm/x')
    assert.equal(store.listPendingRefunds().length, 1, 'pending 应入队')
    assert.equal(
      JSON.parse(fs.readFileSync(refundFile, 'utf8')).pendingRefunds.length,
      1,
      'pending 必须落盘——否则进程重启就再也追不回那笔预扣',
    )

    let body = { status: 'ended', freebucksRefundPending: true }
    const upstream = { freebuffSession: async () => body }
    let r = await store.sweepPendingRefunds(() => upstream)
    assert.equal(r.pending, 1, '仍 pending 时应计入 pending')
    assert.equal(store.listPendingRefunds().length, 1, '仍 pending 时绝不出队')

    // 终态退 0：也是终态，必须出队
    body = { status: 'ended', freebucksRefund: 0 }
    let settledInfo = null
    r = await store.sweepPendingRefunds(() => upstream, {
      onSettled: (i) => { settledInfo = i },
    })
    assert.equal(r.settled, 1, '退 0 是终态')
    assert.equal(store.listPendingRefunds().length, 0, 'settled 应出队')
    assert.equal(settledInfo.refund, 0)

    // 非终态非 pending：保留，绝不当作退 0
    store.notePendingRefund('k2', 'inst-2', 'm/y')
    body = { status: 'active' }
    r = await store.sweepPendingRefunds(() => upstream)
    assert.equal(r.pending, 1, '既非终态也非 pending 时必须保留')
    assert.equal(store.listPendingRefunds().length, 1)

    // 账号已删/凭据变更：跳过但保留
    r = await store.sweepPendingRefunds(() => null)
    assert.equal(r.skipped, 1)
    assert.equal(store.listPendingRefunds().length, 1, '无凭据也不能丢记录')

    // 重放失败：保留
    const boom = { freebuffSession: async () => { throw new Error('ECONNRESET') } }
    r = await store.sweepPendingRefunds(() => boom)
    assert.equal(r.failed, 1)
    assert.equal(store.listPendingRefunds().length, 1, '重放失败也必须保留')

    // 重启后从盘里恢复（这是「跨重启追问」的全部依据）
    store.notePendingRefund('k3', 'inst-3', 'm/z')
    const reloaded = new SessionHandleStore(refundFile)
    assert.equal(
      reloaded.listPendingRefunds().length,
      2,
      '重启后待结算退款队列必须还在',
    )

    // drop 事件同时清 orphan 与 pending（钱已回到手）
    reloaded.handleEvent({ type: 'drop', key: 'k3', instanceId: 'inst-3' })
    assert.equal(reloaded.listPendingRefunds().length, 1)
  } finally {
    fs.rmSync(refundDir, { recursive: true, force: true })
  }
}

globalThis.fetch = originalFetch
fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('smoke ok')
