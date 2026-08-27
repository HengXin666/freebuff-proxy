import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { loadConfig } from '../src/config.js'
import { AccountRuntimes } from '../src/app-context.js'
import { startServer } from '../src/server.js'
import { configureLogger } from '../src/util/log.js'
import {
  requireModelId,
  isFreeModel,
  buildModelsListResponse,
  agentIdForModel,
  agentFallbackForModel,
} from '../src/model.js'
import { saveAccountUser, listAccounts, readAccountUser } from '../src/auth-store.js'
import {
  ensureFreebuffSystemMessages,
  ensureFreebuffToolSignature,
  normalizeReasoningFields,
  normalizeOutputBudget,
  FREEBUFF_SIGNATURE_TOOL_NAME,
  FREEBUFF_SYSTEM_OPENING,
} from '../src/free-mode.js'
import {
  applyMinimalRouting,
  applyStandardRouting,
  bandOf,
  classifyTask,
  coreFor,
  personaFor,
  resolveMode,
  SPEC_PERSONA,
  REACT_PERSONA,
  WEAK_PRO,
  WEAK_FLASH,
  STANDARD_FLASH_PERSONA,
  STANDARD_PRO_PERSONA,
  WE_CHAIN_ANCHOR_FLASH,
  GUIDE_WEAK,
  GUIDE_DEEP,
} from '../src/routing.js'
import { SettingsStore } from '../src/web/settings-store.js'
import {
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
} from '../src/upstream/client.js'

configureLogger({ level: 'error' })

const originalFetch = globalThis.fetch
let calls = []
/** @type {'ok' | 'gate_once' | 'rate_limit_a' | 'rate_limit_completion' | 'err_500_a' | 'capacity_once' | 'capacity_all' | 'run_500_a' | 'network_err_a' | 'gate_twice_a' | 'hold_once' | 'legacy_luna_once'} */
let mockMode = 'ok'
let sessionPosts = 0
let sessionDeletes = 0
let completionAttempts = 0
/** 会话有效期（毫秒）：近过期/重连测试用 */
let sessionExpiryMs = 3600_000
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
  if (u.includes('/api/v1/freebuff/session') && method === 'POST') {
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
    })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'GET') {
    return jsonRes({ status: 'none', accessTier: 'full' })
  }
  if (u.includes('/api/v1/freebuff/session') && method === 'DELETE') {
    sessionDeletes++
    return jsonRes({ status: 'none' })
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
      // agent 兜底：主 agent（base2）被拒，base3 孪生成功
      if (mockMode === 'agent_fallback' && body.agentId === 'base2-free-deepseek-flash') {
        return jsonRes(
          { error: 'free_mode_invalid_agent_model', message: 'Free mode is only available for specific agent and model combinations.' },
          403,
        )
      }
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
    assert.equal(body.codebuff_metadata.cost_mode, 'free')
    assert.ok(body.codebuff_metadata.freebuff_instance_id)
    assert.equal(
      body.codebuff_metadata.run_id,
      '00000000-0000-4000-8000-000000000001',
    )
    assert.ok(Array.isArray(body.messages))
    assert.equal(body.messages[0].role, 'system')
    assert.ok(
      String(body.messages[0].content).startsWith(FREEBUFF_SYSTEM_OPENING),
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
  assert.equal(signedTools.length, 2)
  assert.equal(signedTools[1].function.name, FREEBUFF_SIGNATURE_TOOL_NAME)
  assert.equal(ensureFreebuffToolSignature(originalTools, false), originalTools)
  assert.deepEqual(ensureFreebuffToolSignature([], true), [])
  assert.equal(
    ensureFreebuffToolSignature(signedTools, true),
    signedTools,
  )
}

// --- unit: minimal routing (dsh-routing-suite protocol, proxy-side) ---
{
  // task classification: build → react, fix → spec, ambiguous → weak
  assert.equal(classifyTask('帮我写一个爬虫脚本抓取数据'), 1)
  assert.equal(classifyTask('修复这个崩溃的 bug 并排查原因'), 0)
  assert.equal(classifyTask('你好，随便聊聊'), 'weak')
  assert.equal(classifyTask(''), 'weak')
  assert.equal(classifyTask(undefined), 'weak')

  // bands
  assert.equal(bandOf(0), 'spec')
  assert.equal(bandOf(0.3), 'transition')
  assert.equal(bandOf(1), 'react')
  assert.equal(bandOf('weak'), 'weak')

  // 路由风格钉死（we/let's 链 / let me 链 / weak / auto 分类）
  assert.equal(resolveMode('spec', '从零开发一个网页应用'), 0)
  assert.equal(resolveMode('react', '请修复这个报错'), 1)
  assert.equal(resolveMode('weak', '从零开发一个网页应用'), 'weak')
  assert.equal(resolveMode('auto', '从零开发一个网页应用'), 1)
  assert.equal(resolveMode(null, '从零开发一个网页应用'), 1)
  assert.equal(resolveMode(undefined, '请修复这个报错'), 0)

  // personas by mode + model
  assert.equal(personaFor(0, 'deepseek/deepseek-v4-pro'), SPEC_PERSONA)
  assert.equal(personaFor(1, 'deepseek/deepseek-v4-pro'), REACT_PERSONA)
  assert.equal(personaFor('weak', 'deepseek/deepseek-v4-pro'), WEAK_PRO)
  assert.equal(personaFor('weak', 'deepseek/deepseek-v4-flash'), WEAK_FLASH)
  assert.deepEqual(coreFor(0), ['read', 'edit', 'glob', 'grep'])
  assert.deepEqual(coreFor(1), ['read', 'write', 'edit'])

  const allTools = [
    { type: 'function', function: { name: 'read' } },
    { type: 'function', function: { name: 'edit' } },
    { type: 'function', function: { name: 'glob' } },
    { type: 'function', function: { name: 'grep' } },
    { type: 'function', function: { name: 'write' } },
    { type: 'function', function: { name: 'bash' } },
    { type: 'function', function: { name: 'todo_write' } },
    { type: 'function', function: { name: 'skill' } },
    { type: 'function', function: { name: 'workflow' } },
  ]

  // fix task → spec persona 置顶 + 读优先工具面；客户端 system 保留在后面；
  // 无引导（非 weak）；其他字段（model/stream/thinking）原样保留
  {
    const out = applyMinimalRouting(
      {
        model: 'deepseek/deepseek-v4-pro',
        stream: true,
        thinking: { type: 'enabled' },
        messages: [
          { role: 'system', content: 'You are Buffy, the strategic coding assistant.\n\nKeep the role.' },
          { role: 'user', content: '请修复这个报错并排查根因' },
        ],
        tools: allTools,
      },
      'deepseek/deepseek-v4-pro',
    )
    assert.equal(out.model, 'deepseek/deepseek-v4-pro')
    assert.equal(out.stream, true)
    assert.deepEqual(out.thinking, { type: 'enabled' })
    assert.equal(out.messages[0].role, 'system')
    assert.ok(out.messages[0].content.startsWith(FREEBUFF_SYSTEM_OPENING))
    assert.ok(out.messages[0].content.includes(SPEC_PERSONA))
    // spec 模式缀上 we/let's 集体链锚定
    assert.ok(!out.messages[0].content.includes('Plan and reason collectively'))
    // 套件 applyPersona 语义：客户端 persona 段被替换，其余 section 保留在同一条
    // system 消息里（路由 persona 在前，Keep the role 在后）——不再是前置两条 system
    assert.ok(out.messages[0].content.indexOf(SPEC_PERSONA) < out.messages[0].content.indexOf('Keep the role'))
    assert.ok(!out.messages[0].content.includes('Keep the role.\n\nYou are'))
    // end_turn 由 proxy.js 的 ensureFreebuffToolSignature 在改写后追加，此处不出现
    assert.deepEqual(
      out.tools.map((t) => t.function.name),
      ['read', 'edit', 'glob', 'grep', 'bash'],
    )
    // 非 weak 不追加引导（替换后的 system + user = 2）
    assert.equal(out.messages.length, 2)
  }

  // build task → react persona + 写优先工具面
  {
    const out = applyMinimalRouting(
      {
        messages: [{ role: 'user', content: '从零开发一个网页应用' }],
        tools: allTools,
      },
      'deepseek/deepseek-v4-pro',
    )
    assert.ok(out.messages[0].content.includes(REACT_PERSONA))
    // 过滤保持原始工具顺序
    assert.deepEqual(
      out.tools.map((t) => t.function.name),
      ['read', 'edit', 'write', 'bash'],
    )
  }

  // 模糊任务 → weak persona + 近距离引导（简单任务用 GUIDE_WEAK）
  {
    const out = applyMinimalRouting(
      {
        messages: [{ role: 'user', content: '你好' }],
        tools: allTools,
      },
      'deepseek/deepseek-v4-pro',
    )
    assert.ok(out.messages[0].content.includes(WEAK_PRO))
    assert.equal(out.messages.length, 3) // system + user + guide
    assert.equal(out.messages[2].role, 'user')
    assert.equal(out.messages[2].content, GUIDE_WEAK)
  }

  // 复杂任务 → GUIDE_DEEP（>120 字符且无强 build/fix 关键词 → weak + 深度引导）
  {
    const longNeutral =
      '我们需要综合考虑当前的状况和未来的目标，从不同维度评估可能的走向，并给出一个平衡的结论，涵盖利弊、风险与收益，同时说明在哪些情况下应该调整优先级，在哪些情况下保持现状即可，另外还需要注意资源与时间上的约束，以及不同阶段之间如何衔接才能让整体推进更加顺畅。'
    assert.ok(longNeutral.length > 120)
    const out = applyMinimalRouting(
      {
        messages: [{ role: 'user', content: longNeutral }],
      },
      'deepseek/deepseek-v4-pro',
    )
    assert.equal(out.messages.at(-1).content, GUIDE_DEEP)
  }

  // Flash 模型 → weak 用 WEAK_FLASH
  {
    const out = applyMinimalRouting(
      { messages: [{ role: 'user', content: '随便聊聊' }] },
      'deepseek/deepseek-v4-flash',
    )
    assert.ok(out.messages[0].content.includes(WEAK_FLASH))
  }

  // Flash + spec（auto 分类命中）：system 保持纯 spec 句（远距锚定在 flash 上反噬），
  // 改由近距离 user 消息注入 we/let's 首 token 锚定
  {
    const out = applyMinimalRouting(
      { messages: [{ role: 'user', content: '请修复这个报错' }], tools: allTools },
      'deepseek/deepseek-v4-flash',
    )
    assert.ok(out.messages[0].content.includes(SPEC_PERSONA))
    assert.ok(!out.messages[0].content.includes('Plan and reason collectively')) // persona 逐字符原样
    assert.equal(out.messages.at(-1).role, 'user')
    assert.equal(out.messages.at(-1).content, WE_CHAIN_ANCHOR_FLASH)
  }

  // Flash + spec 钉死（build 任务也强制）：同样近距锚定
  {
    const out = applyMinimalRouting(
      { messages: [{ role: 'user', content: '从零开发一个网页应用' }], tools: allTools },
      'deepseek/deepseek-v4-flash',
      { modeOverride: 'spec' },
    )
    assert.ok(out.messages[0].content.includes(SPEC_PERSONA))
    assert.ok(!out.messages[0].content.includes('Plan and reason collectively'))
    assert.equal(out.messages.at(-1).content, WE_CHAIN_ANCHOR_FLASH)
  }

  // Pro + spec：远距 persona 锚定，无近距引导
  {
    const out = applyMinimalRouting(
      { messages: [{ role: 'user', content: '请修复这个报错' }] },
      'deepseek/deepseek-v4-pro',
    )
    assert.ok(!out.messages[0].content.includes('Plan and reason collectively'))
    assert.equal(out.messages.at(-1).role, 'user')
    assert.equal(out.messages.at(-1).content, '请修复这个报错')
  }

  // 工具循环轮次（最后一条是 tool 结果）→ flash+spec 锚定仍注入（修复思维链衰减）
  {
    const out = applyMinimalRouting(
      {
        messages: [
          { role: 'user', content: '做一个我的世界网页版' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'total 0' },
        ],
        tools: allTools,
      },
      'deepseek/deepseek-v4-flash',
      { modeOverride: 'spec' },
    )
    assert.equal(out.messages.at(-1).role, 'user')
    assert.equal(out.messages.at(-1).content, WE_CHAIN_ANCHOR_FLASH)
    // 已有 tool_calls → 工具放行全部
    assert.equal(out.tools.length, allTools.length)
  }

  // weak 模式工具循环轮次 → 引导仍注入
  {
    const out = applyMinimalRouting(
      {
        messages: [
          { role: 'user', content: '随便聊聊' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        ],
      },
      'deepseek/deepseek-v4-pro',
    )
    assert.equal(out.messages.at(-1).role, 'user')
    assert.equal(out.messages.at(-1).content, GUIDE_WEAK)
  }

  // assistant 文本回复是最后一条 → 不追加（避免"用户插话"）
  {
    const out = applyMinimalRouting(
      {
        messages: [
          { role: 'user', content: '做一个我的世界网页版' },
          { role: 'assistant', content: '好的，我来做。' },
        ],
      },
      'deepseek/deepseek-v4-flash',
      { modeOverride: 'spec' },
    )
    assert.equal(out.messages.at(-1).role, 'assistant')
  }

  // 历史已有 assistant tool_calls → 放行全部工具（首轮锚定完成，不再裁剪）
  {
    const out = applyMinimalRouting(
      {
        messages: [
          { role: 'user', content: '写一个脚本' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        ],
        tools: allTools,
      },
      'deepseek/deepseek-v4-pro',
    )
    assert.deepEqual(
      out.tools.map((t) => t.function.name),
      allTools.map((t) => t.function.name),
    )
    // 最后一个消息是 tool 结果 → 不追加引导
    assert.equal(out.messages.length, 4)
  }

  // 最后一个消息不是用户消息（assistant 文本回复）→ 不追加引导
  {
    const out = applyMinimalRouting(
      {
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '你好！有什么可以帮你？' },
        ],
      },
      'deepseek/deepseek-v4-pro',
    )
    assert.equal(out.messages.length, 3) // system + user + assistant
    assert.equal(out.messages[2].role, 'assistant')
  }

  // 标准预设形态：客户端 persona（"You are a coding agent powered by..."）被替换，
  // "### " 工具/工作区 section 保留在路由 persona 之后
  {
    const stdSystem =
      'You are a coding agent powered by the deepseek/deepseek-v4-flash model. Your working directory is /workspace.\n\n### 工具使用\n用 read/edit/write/glob/grep/bash 操作文件。\n### 工作区\nAGENTS.md 是最高优先级约定。'
    const out = applyMinimalRouting(
      { messages: [{ role: 'system', content: stdSystem }, { role: 'user', content: '修复 bug' }], tools: allTools },
      'deepseek/deepseek-v4-pro',
    )
    const sys0 = out.messages[0].content
    assert.ok(sys0.startsWith(FREEBUFF_SYSTEM_OPENING))
    assert.ok(sys0.includes(SPEC_PERSONA))
    // 原 persona 句被移除，其余 section 保留
    assert.ok(!sys0.includes('coding agent powered by'))
    assert.ok(sys0.includes('### 工具使用'))
    assert.ok(sys0.includes('AGENTS.md 是最高优先级约定'))
    assert.equal(out.messages.length, 2) // 替换后的 system + user
  }

  // 客户端 system 不以 "You are" 开头 → 无法识别 persona 段，回退前置 persona 消息
  {
    const out = applyMinimalRouting(
      { messages: [{ role: 'system', content: 'Be brief. 只给结论。' }, { role: 'user', content: '修复 bug' }] },
      'deepseek/deepseek-v4-pro',
    )
    assert.equal(out.messages[0].role, 'system')
    assert.ok(out.messages[0].content.startsWith(FREEBUFF_SYSTEM_OPENING))
    assert.equal(out.messages[1].content, 'Be brief. 只给结论。') // 原样保留
    assert.equal(out.messages.length, 3) // 前置 persona + 客户端 system + user
  }

  // 客户端没有 tools → 保持空
  {
    const out = applyMinimalRouting(
      { messages: [{ role: 'user', content: '修复 bug' }] },
      'deepseek/deepseek-v4-pro',
    )
    assert.deepEqual(out.tools, [])
  }

  // 路由风格钉死：build 任务强制 spec（we/let's 链）→ spec persona + 锚定 + 读优先工具
  {
    const out = applyMinimalRouting(
      { messages: [{ role: 'user', content: '从零开发一个网页应用' }], tools: allTools },
      'deepseek/deepseek-v4-pro',
      { modeOverride: 'spec' },
    )
    assert.ok(out.messages[0].content.includes(SPEC_PERSONA))
    assert.ok(!out.messages[0].content.includes('Plan and reason collectively'))
    assert.deepEqual(
      out.tools.map((t) => t.function.name),
      ['read', 'edit', 'glob', 'grep', 'bash'],
    )
  }

  // 路由风格钉死：fix 任务强制 react → react persona（无锚定）+ 写优先工具
  {
    const out = applyMinimalRouting(
      { messages: [{ role: 'user', content: '请修复这个报错' }], tools: allTools },
      'deepseek/deepseek-v4-pro',
      { modeOverride: 'react' },
    )
    assert.ok(out.messages[0].content.includes(REACT_PERSONA))
    assert.ok(!out.messages[0].content.includes('Plan and reason collectively'))
    assert.deepEqual(
      out.tools.map((t) => t.function.name),
      ['read', 'edit', 'write', 'bash'],
    )
  }

  // 工具保证：客户端工具全是非常规名 → 核心裁剪为空 → 保留原工具集（模型仍可调用工具）
  {
    const weirdTools = [
      { type: 'function', function: { name: 'web_search' } },
      { type: 'function', function: { name: 'fetch_page' } },
    ]
    const out = applyMinimalRouting(
      { messages: [{ role: 'user', content: '修复 bug' }], tools: weirdTools },
      'deepseek/deepseek-v4-pro',
    )
    assert.deepEqual(
      out.tools.map((t) => t.function.name),
      ['web_search', 'fetch_page'],
    )
  }

  // 特殊签名工具保证：原工具集里带 end_turn → 裁剪后必须保留
  {
    const signedTools = [
      { type: 'function', function: { name: 'read' } },
      { type: 'function', function: { name: 'edit' } },
      { type: 'function', function: { name: 'todo_write' } },
      { type: 'function', function: { name: 'end_turn' } },
    ]
    const out = applyMinimalRouting(
      { messages: [{ role: 'user', content: '修复 bug' }], tools: signedTools },
      'deepseek/deepseek-v4-pro',
    )
    const names = out.tools.map((t) => t.function.name)
    assert.deepEqual(names, ['read', 'edit', 'end_turn'])
  }

  // ── 标准模式（applyStandardRouting）：flash 恒走 weak + 深度引导静态并入 ──
  {
    // flash：恒用 STANDARD_FLASH_PERSONA（不按任务分类），深度思考引导静态并入
    // persona（v4-flash-godmode rc.6 教训：动态注入不可靠 → 静态并入，多轮稳定）
    const out = applyStandardRouting(
      {
        messages: [
          { role: 'system', content: 'You are a coding agent powered by the deepseek/deepseek-v4-flash model.\n\n### 工具使用\n用工具操作文件。' },
          { role: 'user', content: '从零开发一个网页应用' },
        ],
        tools: allTools,
      },
      'deepseek/deepseek-v4-flash',
    )
    const sys0 = out.messages[0].content
    assert.ok(sys0.startsWith(FREEBUFF_SYSTEM_OPENING))
    assert.ok(sys0.includes(STANDARD_FLASH_PERSONA))
    // 深度引导静态并入 persona（关键：多轮稳定，不依赖动态注入）
    assert.ok(sys0.includes('Think deeply about the architecture'))
    assert.ok(sys0.includes('decide the task type (build or fix)'))
    // 客户端 persona 段被替换、其余 section 保留（套件 applyPersona 语义）
    assert.ok(!sys0.includes('coding agent powered by'))
    assert.ok(sys0.includes('### 工具使用'))
    // 首轮 weak 核心工具面（read/write/edit + shell）
    assert.deepEqual(
      out.tools.map((t) => t.function.name),
      ['read', 'edit', 'write', 'bash'],
    )
    // 标准模式不追加逐轮动态引导（v4-flash-godmode rc.6 教训：动态注入不可靠，
    // 每轮 GUIDE 随轮次变化 → 思维链混用）。深度引导已静态并入 persona。
    assert.equal(out.messages.length, 2) // system + user
    assert.equal(out.messages.at(-1).role, 'user')
    assert.equal(out.messages.at(-1).content, '从零开发一个网页应用')
  }

  // 标准模式 Pro/其他模型 → STANDARD_PRO_PERSONA（w6c，无锚、无逐轮引导）
  {
    const out = applyStandardRouting(
      { messages: [{ role: 'user', content: '请全面重构这个系统的架构设计并优化性能' }] },
      'deepseek/deepseek-v4-pro',
    )
    assert.ok(out.messages[0].content.includes(STANDARD_PRO_PERSONA))
    assert.equal(out.messages.length, 2) // system + user，不追加引导
    assert.equal(out.messages.at(-1).content, '请全面重构这个系统的架构设计并优化性能')
  }

  // 标准模式 Pro：简单任务同样不追加引导（persona 恒定 = 多轮稳定）
  {
    const out = applyStandardRouting(
      { messages: [{ role: 'user', content: '修复这个报错' }] },
      'deepseek/deepseek-v4-pro',
    )
    assert.ok(out.messages[0].content.includes(STANDARD_PRO_PERSONA))
    assert.equal(out.messages.length, 2)
  }

  // 标准模式：历史已有 tool_calls → 放行全部工具（promote 语义，多轮不裁剪）
  {
    const out = applyStandardRouting(
      {
        messages: [
          { role: 'user', content: '写一个脚本' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        ],
        tools: allTools,
      },
      'deepseek/deepseek-v4-flash',
    )
    assert.deepEqual(
      out.tools.map((t) => t.function.name),
      allTools.map((t) => t.function.name),
    )
    // 无 system → 前置 persona（1）+ 原始 3 条 = 4；标准模式不追加逐轮引导
    assert.equal(out.messages.length, 4)
    assert.equal(out.messages.at(-1).role, 'tool')
    assert.equal(out.messages.at(-1).content, 'ok')
  }

  // 标准模式多轮稳定：第二轮（历史带 assistant 文本回复）仍注入标准 persona，
  // 且 persona 内容与首轮逐字一致（哈希不变，多轮触发不衰减）
  {
    const first = applyStandardRouting(
      { messages: [{ role: 'user', content: '帮我重构这个模块' }] },
      'deepseek/deepseek-v4-flash',
    )
    const second = applyStandardRouting(
      {
        messages: [
          { role: 'user', content: '帮我重构这个模块' },
          { role: 'assistant', content: '好的，我先看一下现有代码结构。' },
          { role: 'user', content: '继续，顺便加上单元测试' },
        ],
      },
      'deepseek/deepseek-v4-flash',
    )
    // 两轮注入的 persona 逐字一致（静态并入 → 多轮稳定触发）
    assert.equal(
      first.messages[0].content.includes(STANDARD_FLASH_PERSONA),
      true,
    )
    assert.equal(
      second.messages[0].content.includes(STANDARD_FLASH_PERSONA),
      true,
    )
    assert.ok(second.messages[0].content.includes('Think deeply about the architecture'))
  }
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
  assert.deepEqual(
    enabledBody.tools.map((tool) => tool.function.name),
    ['web_search', 'end_turn'],
  )

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

// minimal routing: 默认关闭 → 透传不改写；开启 → persona 置顶 + 首轮工具面裁剪
{
  // 本块专门验证 minimal 实现风格（旧行为），显式钉死，避免受默认 standard 影响
  settingsStore.save({ minimalRoutingStyle: 'minimal' })
  calls = []
  completionAttempts = 0
  const tools = [
    { type: 'function', function: { name: 'read' } },
    { type: 'function', function: { name: 'edit' } },
    { type: 'function', function: { name: 'glob' } },
    { type: 'function', function: { name: 'grep' } },
    { type: 'function', function: { name: 'write' } },
    { type: 'function', function: { name: 'bash' } },
    { type: 'function', function: { name: 'todo_write' } },
    { type: 'function', function: { name: 'skill' } },
  ]
  const msgs = [
    { role: 'system', content: 'You are Buffy, the strategic coding assistant.\n\nKeep the role.' },
    { role: 'user', content: '请修复这个报错并排查根因' },
  ]

  // 关闭：原样透传（仅 free-mode 门禁补齐），tools 只追加签名工具
  assert.equal(settingsStore.get().minimalRoutingEnabled, false)
  const offRes = await chat({
    model: 'deepseek/deepseek-v4-pro',
    messages: msgs,
    tools,
  })
  assert.equal(offRes.status, 200, await offRes.clone().text())
  const offCall = calls.find((c) => c.url.includes('/chat/completions'))
  const offBody = JSON.parse(offCall.body)
  assert.equal(offBody.messages.length, 2)
  assert.equal(offBody.messages[0].content, msgs[0].content)
  assert.deepEqual(
    offBody.tools.map((t) => t.function.name),
    ['read', 'edit', 'glob', 'grep', 'write', 'bash', 'todo_write', 'skill', 'end_turn'],
  )

  // 开启：spec persona 置顶（门禁标记保留）、客户端 system 在后、工具裁剪为
  // read/edit/glob/grep + bash + end_turn、非 weak 不追加引导
  settingsStore.save({ minimalRoutingEnabled: true })
  calls = []
  completionAttempts = 0
  const onRes = await chat({
    model: 'deepseek/deepseek-v4-pro',
    messages: msgs,
    tools,
  })
  assert.equal(onRes.status, 200, await onRes.clone().text())
  const onCall = calls.find((c) => c.url.includes('/chat/completions'))
  const onBody = JSON.parse(onCall.body)
  assert.equal(onBody.messages[0].role, 'system')
  assert.ok(onBody.messages[0].content.startsWith(FREEBUFF_SYSTEM_OPENING))
  assert.ok(onBody.messages[0].content.includes(SPEC_PERSONA))
  // 套件 applyPersona 语义：客户端 persona 段被路由 persona 替换，其余 section 保留
  assert.ok(onBody.messages[0].content.includes('Keep the role'))
  assert.ok(!onBody.messages[0].content.includes('Keep the role.\n\nYou are'))
  assert.equal(onBody.messages[1].role, 'user')
  assert.equal(onBody.messages.length, 2) // 替换后的 system + user，非 weak 无引导
  assert.deepEqual(
    onBody.tools.map((t) => t.function.name),
    ['read', 'edit', 'glob', 'grep', 'bash', 'end_turn'],
  )

  // 已有 tool_calls 历史 → 放行全部工具
  calls = []
  completionAttempts = 0
  const toolMsgs = [
    { role: 'user', content: '写一个脚本' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ]
  const toolRes = await chat({
    model: 'deepseek/deepseek-v4-pro',
    messages: toolMsgs,
    tools,
  })
  assert.equal(toolRes.status, 200, await toolRes.clone().text())
  const toolCall = calls.find((c) => c.url.includes('/chat/completions'))
  const toolBody = JSON.parse(toolCall.body)
  assert.deepEqual(
    toolBody.tools.map((t) => t.function.name),
    ['read', 'edit', 'glob', 'grep', 'write', 'bash', 'todo_write', 'skill', 'end_turn'],
  )

  // 路由风格钉死 spec：build 任务也被路由到 we/let's 集体链（spec persona + 锚定 + 读优先工具）
  settingsStore.save({ minimalRoutingMode: 'spec' })
  calls = []
  completionAttempts = 0
  const pinnedRes = await chat({
    model: 'deepseek/deepseek-v4-pro',
    messages: [{ role: 'user', content: '从零开发一个网页应用' }],
    tools,
  })
  assert.equal(pinnedRes.status, 200, await pinnedRes.clone().text())
  const pinnedCall = calls.find((c) => c.url.includes('/chat/completions'))
  const pinnedBody = JSON.parse(pinnedCall.body)
  assert.ok(pinnedBody.messages[0].content.includes(SPEC_PERSONA))
  assert.ok(!pinnedBody.messages[0].content.includes('Plan and reason collectively'))
  assert.deepEqual(
    pinnedBody.tools.map((t) => t.function.name),
    ['read', 'edit', 'glob', 'grep', 'bash', 'end_turn'],
  )
  settingsStore.save({ minimalRoutingMode: 'auto' })

  // Flash + spec 钉死：system 无远距锚定，近距 user 注入 we/let's 首 token 锚定
  settingsStore.save({ minimalRoutingMode: 'spec' })
  calls = []
  completionAttempts = 0
  const flashSpecRes = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: '从零开发一个网页应用' }],
    tools,
  })
  assert.equal(flashSpecRes.status, 200, await flashSpecRes.clone().text())
  const flashSpecCall = calls.find((c) => c.url.includes('/chat/completions'))
  const flashSpecBody = JSON.parse(flashSpecCall.body)
  assert.ok(flashSpecBody.messages[0].content.includes(SPEC_PERSONA))
  assert.ok(!flashSpecBody.messages[0].content.includes('Plan and reason collectively'))
  assert.equal(flashSpecBody.messages.at(-1).content, WE_CHAIN_ANCHOR_FLASH)
  settingsStore.save({ minimalRoutingMode: 'auto' })

  // 模糊任务（weak 模式）+ Flash 模型 → WEAK_FLASH persona + 近距离引导
  calls = []
  completionAttempts = 0
  const weakRes = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: '随便聊聊' }],
  })
  assert.equal(weakRes.status, 200, await weakRes.clone().text())
  const weakCall = calls.find((c) => c.url.includes('/chat/completions'))
  const weakBody = JSON.parse(weakCall.body)
  assert.ok(weakBody.messages[0].content.includes(WEAK_FLASH))
  assert.equal(weakBody.messages.at(-1).role, 'user')
  assert.equal(weakBody.messages.at(-1).content, GUIDE_WEAK)
  settingsStore.save({ minimalRoutingEnabled: false, minimalRoutingStyle: 'standard' })
}

// standard routing（默认实现风格）：flash 恒走 weak 内路由 + 深度引导静态并入 persona
{
  const tools = [
    { type: 'function', function: { name: 'read' } },
    { type: 'function', function: { name: 'edit' } },
    { type: 'function', function: { name: 'glob' } },
    { type: 'function', function: { name: 'grep' } },
    { type: 'function', function: { name: 'write' } },
    { type: 'function', function: { name: 'bash' } },
    { type: 'function', function: { name: 'todo_write' } },
    { type: 'function', function: { name: 'skill' } },
  ]
  settingsStore.save({ minimalRoutingEnabled: true, minimalRoutingStyle: 'standard' })
  calls = []
  completionAttempts = 0
  const res = await chat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: '从零开发一个网页应用' }],
    tools,
  })
  assert.equal(res.status, 200, await res.clone().text())
  const call = calls.find((c) => c.url.includes('/chat/completions'))
  const body = JSON.parse(call.body)
  const sys0 = body.messages[0].content
  // flash 恒走 weak 标准 persona（不按任务分类），深度思考引导静态并入
  assert.ok(sys0.includes(STANDARD_FLASH_PERSONA))
  assert.ok(sys0.includes('Think deeply about the architecture'))
  // 首轮 weak 核心工具面（read/write/edit + bash + end_turn 签名）
  assert.deepEqual(
    body.tools.map((t) => t.function.name),
    ['read', 'edit', 'write', 'bash', 'end_turn'],
  )
  // 标准模式不追加逐轮动态引导（v4-flash-godmode rc.6 教训：动态注入不可靠、
  // 每轮 GUIDE 随轮次变化 → 思维链混用）；深度引导静态并入 persona。
  assert.equal(body.messages.length, 2) // system + user
  assert.equal(body.messages.at(-1).role, 'user')
  assert.equal(body.messages.at(-1).content, '从零开发一个网页应用')
  settingsStore.save({ minimalRoutingEnabled: false })
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
  assert.equal(agentIdForModel(model.id), model.base2)
  assert.equal(agentFallbackForModel(model.id), model.base3)
  const listed = buildModelsListResponse().data.find((row) => row.id === model.id)
  assert.ok(listed, `${model.id} should be present in /v1/models`)
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
    assert.match(body.codebuff_metadata.client_id, /^freebuff-proxy-/)
  }
  assert.notEqual(
    forwarded[0].codebuff_metadata.client_id,
    'old-client-id',
    'proxy must not inherit a retired client identity',
  )
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
{
  const qDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-queue-switch-'))
  saveAccountUser(qDir, { id: 'qa', email: 'qa@example.com', authToken: 'token-qa' })
  const qConfig = loadConfig()
  qConfig.server.host = '127.0.0.1'
  qConfig.server.port = 0
  qConfig.server.apiKeys = ['sk-test']
  qConfig.upstream.credentialsDir = qDir
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
  // 等待期间切换代理池 → 旧 runtime 被顶替
  qConfig.upstream.proxies = ['http://q1.example:7890']
  await qRuntimes.invalidateProxies()
  assert.equal(qRuntimes.isCurrentRuntime(oldRt), false)
  // 放行 A；B 拿到锁后应检测到 runtime 已过期 → 无冷却重新选号 → 走新出口成功
  releaseHoldStreams()
  await resA.text()
  const resB = await resBPromise
  assert.equal(resB.status, 200, await resB.clone().text())
  assert.match(await resB.text(), /data: \[DONE\]/)
  assert.equal(sessionPosts, 2, 'B 应在新 runtime 上 admit 新 session')
  // A 的旧 session 由优雅回收释放
  await waitFor('排队切换后旧 session 优雅释放', () => sessionDeletes >= 1)

  await qRuntimes.shutdown()
  qServer.close()
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
  const pool = new AccountRuntimes(rrConfig, { getSpreadAccounts: () => 1 })
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

// --- unit: 免费模型暴力分散（spread 默认开）——轮转分散到不同账号 ---
{
  const spDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-spread-'))
  saveAccountUser(spDir, { id: 'a', email: 'sp-a@example.com', authToken: 'token-a' })
  saveAccountUser(spDir, { id: 'b', email: 'sp-b@example.com', authToken: 'token-b' })
  saveAccountUser(spDir, { id: 'c', email: 'sp-c@example.com', authToken: 'token-c' })
  const spConfig = loadConfig()
  spConfig.upstream.credentialsDir = spDir
  spConfig.session.pollIntervalSec = 3600
  const pool = new AccountRuntimes(spConfig) // 默认 spread=true
  mockMode = 'ok'
  sessionPosts = 0
  // 串行请求轮转 A→B→C→A→B→C，不钉死热 session
  const emails = []
  for (let i = 0; i < 6; i++) {
    const rt = await pool.acquireForModel('deepseek/deepseek-v4-flash')
    emails.push(rt.email)
  }
  assert.deepEqual(
    emails,
    [
      'sp-a@example.com',
      'sp-b@example.com',
      'sp-c@example.com',
      'sp-a@example.com',
      'sp-b@example.com',
      'sp-c@example.com',
    ],
    `免费模型应轮转分散, got ${JSON.stringify(emails)}`,
  )
  // 3 个账号各 admit 一次（每个账号一个 session，第 4 个请求起复用）
  assert.equal(sessionPosts, 3, `expected 3 admissions (one per account), got ${sessionPosts}`)

  // 平摊调度在所有模型统一生效：但并发冷启动时，若账号已全部铺满（前面 flash
  // 已占用 a/b/c），新模型请求优先复用热 session 账号（账号内负载均衡）——
  // 不会无谓替换其他账号的 session。这里 3 个账号都已被 flash 占用，pro 请求
  // 全部复用 a（a 的 session 对 mock 上游所有模型可用）。
  sessionPosts = 0
  const seen = await Promise.all(
    Array.from({ length: 6 }, async () => {
      const rt = await pool.acquireForModel('deepseek/deepseek-v4-pro')
      return rt.key
    }),
  )
  assert.equal(new Set(seen).size, 1, `账号已铺满时新模型应复用热账号, got ${seen}`)
  assert.equal(sessionPosts, 1, `复用切换模型应最多 re-admit 一次, got ${sessionPosts}`)
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
  const dupPool = new AccountRuntimes(dupConfig, { getSpreadAccounts: () => 1 })
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
  // 运行设置：账号并发上限（负载均衡）——默认 1，校验非法值，保存后持久化
  {
    const getDefault = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      headers: { cookie },
    })
    assert.equal((await getDefault.json()).accountMaxConcurrency, 1)

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
  // 运行设置：极简路由开关——默认关闭，非法值拒绝，保存后立即生效并持久化
  {
    const getDefault = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      headers: { cookie },
    })
    assert.equal((await getDefault.json()).minimalRoutingEnabled, false)

    const invalid = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ minimalRoutingEnabled: 'yes' }),
    })
    assert.equal(invalid.status, 400)

    const save = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ minimalRoutingEnabled: true }),
    })
    assert.equal(save.status, 200)
    assert.equal((await save.json()).minimalRoutingEnabled, true)
    assert.equal(settingsStore.get().minimalRoutingEnabled, true)
    assert.equal(
      new SettingsStore(path.join(wDir, 'settings.json')).get()
        .minimalRoutingEnabled,
      true,
    )
    // 恢复默认
    await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ minimalRoutingEnabled: false }),
    })
    assert.equal(settingsStore.get().minimalRoutingEnabled, false)
  }
  // 运行设置：路由风格（思维链钉死）——默认 auto，非法值拒绝，保存后持久化
  {
    const getDefault = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      headers: { cookie },
    })
    assert.equal((await getDefault.json()).minimalRoutingMode, 'auto')

    for (const bad of ['foo', 'SPEC', 1, null]) {
      const res = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ minimalRoutingMode: bad }),
      })
      assert.equal(res.status, 400, `minimalRoutingMode=${bad} should be rejected`)
    }

    const save = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ minimalRoutingMode: 'spec' }),
    })
    assert.equal(save.status, 200)
    assert.equal((await save.json()).minimalRoutingMode, 'spec')
    assert.equal(settingsStore.get().minimalRoutingMode, 'spec')
    assert.equal(
      new SettingsStore(path.join(wDir, 'settings.json')).get().minimalRoutingMode,
      'spec',
    )
    // 恢复默认
    await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ minimalRoutingMode: 'auto' }),
    })
    assert.equal(settingsStore.get().minimalRoutingMode, 'auto')
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
  const convRuntimes = new AccountRuntimes(convConfig, { getSpreadAccounts: () => 1 })
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

// 无会话ID 的并发请求：spread 关 + 每账号并发上限 1 → 冷启动按空闲槽位分散，
// 单账号同时最多 1 条流（满员即换号，不再把并发全部钉死在一个账号）
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
    getSpreadAccounts: () => 999,
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
  // 每账号并发上限 1：并发请求分散到 3 个账号（每个 admit 一次），单账号同时最多 1 条流
  assert.deepEqual(
    [...new Set(rrAccounts)].sort(),
    ['ra@example.com', 'rb@example.com', 'rc@example.com'],
    `并发应按空闲槽位分散到全部账号, got ${JSON.stringify(rrAccounts)}`,
  )
  assert.equal(sessionPosts, 3, `每账号应各 admit 一次, got ${sessionPosts}`)
  assert.equal(rrActiveMax, 3, `单账号并发上限 1 → 全局并发峰值应=账号数 3, got ${rrActiveMax}`)

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
  const subRuntimes = new AccountRuntimes(subConfig, { getSpreadAccounts: () => 1 })
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
  const capRuntimes = new AccountRuntimes(capConfig, { getSpreadAccounts: () => 999 })
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
  const capRuntimes2 = new AccountRuntimes(capConfig2, { getSpreadAccounts: () => 999 })
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

  const stRuntimes = new AccountRuntimes(stConfig, { getSpreadAccounts: () => 999 })
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

  const spRuntimes = new AccountRuntimes(spConfig, { getSpreadAccounts: () => 1 })
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
    getSpreadAccounts: () => 999,
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
  // 单账号并发上限 1：请求分散到 sca/scb（各 admit 一次），单账号同时最多 1 条流
  assert.equal(new Set(scAccounts).size, 2, `expected two accounts, got ${JSON.stringify(scAccounts)}`)
  assert.equal(sessionPosts, 2, `expected 2 session admissions, got ${sessionPosts}`)
  assert.equal(streamActiveMax, 2, `expected max 2 concurrent streams (1 per account), got ${streamActiveMax}`)

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
    getSpreadAccounts: () => 999,
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
  // 每账号并发上限 2：cca 先占满 2 条 → 换到 ccb（各 admit 一次）；单账号同时最多 2 条流
  assert.equal(new Set(ccAccounts).size, 2, `expected two accounts, got ${JSON.stringify(ccAccounts)}`)
  assert.equal(sessionPosts, 2, `expected 2 session admissions, got ${sessionPosts}`)
  assert.equal(streamActiveMax, 4, `expected max 4 concurrent streams (2 per account), got ${streamActiveMax}`)
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
    getSpreadAccounts: () => 999, // 平摊账号数不设限（全部账号可用）
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
  // 8 个并发流，上限 3 → 应 4+4 分散到两个账号，单账号峰值 <= 3
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
  // 核心断言：不再全钉一个账号——两个账号都被用到；每账号承接 3..5 个
  // （4+4 或 5+3 取决于选号/取锁的微时序，都在"上限 3 → 满员换号"的语义内）
  assert.equal(Object.keys(byEmail).length, 2, `应分散到两个账号, got ${JSON.stringify(byEmail)}`)
  for (const email of ['cpa@example.com', 'cpb@example.com']) {
    assert.ok(
      byEmail[email] >= 3 && byEmail[email] <= 5,
      `${email} 承接数应在 3..5, got ${JSON.stringify(byEmail)}`,
    )
  }
  assert.equal(sessionPosts, 2, `两个账号应各 admit 一次, got ${sessionPosts}`)
  assert.ok(streamActiveMax <= 6, `全局并发峰值应 <= 2账号×上限3, got ${streamActiveMax}`)
  assert.ok(streamActiveMax >= 4, `并发应真正叠加（>单账号上限3）, got ${streamActiveMax}`)

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
  const expRuntimes = new AccountRuntimes(expConfig, { getSpreadAccounts: () => 1 })
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

  const waRuntimes = new AccountRuntimes(waConfig) // 默认 spread 开（免费模型分散）
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
  // B：立刻打第二个请求 → 免费模型分散到 wb 成功，而不是排队等 wa 释放
  const t0 = Date.now()
  const resB = await waChat()
  assert.equal(resB.status, 200, await resB.clone().text())
  assert.equal(
    resB.headers.get('x-freebuff-proxy-account'),
    'wb@example.com',
    'wa 被占死时新请求应换到 wb',
  )
  assert.ok(Date.now() - t0 < 15_000, `换号应快速完成, took ${Date.now() - t0}ms`)
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

globalThis.fetch = originalFetch
fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('smoke ok')
