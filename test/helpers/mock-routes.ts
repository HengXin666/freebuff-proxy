/**
 * 上游 mock 的各端点处理 -- 从 test/proxy-test-helpers.mjs 的 createMockUpstreamServer
 * 按端点拆出.
 *
 * 为什么拆: 原回调是一个 87 行的匿名函数, 里面 5 个 if 分支各管一个端点,
 * 读它的人要同时装下准入 / 会话 / 运行 / chat 四套形态. 拆成"一个端点一个函数"
 * 之后, 每个分支的注释与它守护的不变量贴在一起.
 *
 * 口径: 纯搬移, 不改行为, 不改任何一行响应体.
 */

/**
 * 造一个 json 响应器(闭包在 res 上, 各端点共用).
 * @param {import('node:http').ServerResponse} res 响应
 * @returns {(obj: any, status?: number) => void} 写 JSON 的函数
 */
export function makeJson(res) {
  return (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
}

/**
 * POST /api/v1/freebuff/session/admission -- 官方 POST 准入端点.
 *
 * 官方端点是 .../session/admission(不是 .../session);
 * 这个真实 HTTP mock 必须跟着走, 否则测的就不是一个真实的链路.
 * 见 .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
 * @param {any} ctx 上下文(state / json / req / method)
 * @returns {boolean} 已处理则为真
 */
export function handleAdmission(ctx) {
  if (ctx.path !== '/api/v1/freebuff/session/admission' || ctx.method !== 'POST') return false
  ctx.state.bumpSessionPosts()
  const model = ctx.req.headers['x-freebuff-model'] || 'deepseek/deepseek-v4-flash'
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
  ctx.json({
    status: 'active',
    instanceId: 'inst-' + ctx.state.sessionPosts(),
    model,
    admittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    remainingMs: 3600_000,
    accessTier: 'full',
    rateLimit,
    rateLimitsByModel: { [model]: rateLimit },
  })
  return true
}

/**
 * /api/v1/freebuff/session 的 GET 与 DELETE.
 * @param {any} ctx 上下文
 * @returns {boolean} 已处理则为真
 */
export function handleSession(ctx) {
  if (ctx.path !== '/api/v1/freebuff/session') return false
  if (ctx.method === 'GET') {
    ctx.json({ status: 'none', accessTier: 'full' })
    return true
  }
  if (ctx.method === 'DELETE') {
    ctx.state.bumpSessionDeletes()
    ctx.json({ status: 'none' })
    return true
  }
  return false
}

/**
 * POST /api/v1/agent-runs(START 给 runId, FINISH 只回 ok).
 * @param {any} ctx 上下文
 * @returns {boolean} 已处理则为真
 */
export function handleAgentRuns(ctx) {
  if (ctx.path !== '/api/v1/agent-runs' || ctx.method !== 'POST') return false
  const body = JSON.parse(ctx.bodyText || '{}')
  if (body.action === 'START') {
    ctx.json({ runId: '00000000-0000-4000-8000-000000000001' })
    return true
  }
  ctx.json({ ok: true })
  return true
}

/**
 * POST /api/v1/chat/completions(流式 / 非流式 / hold_once).
 *
 * hold_once 模式: 先发响应头 + 首 chunk 并保持连接打开(模拟长流),
 * 由测试通过 state.holdResponses 显式释放(写 [DONE] 并结束).
 * @param {any} ctx 上下文
 * @returns {boolean} 已处理则为真
 */
export function handleChatCompletions(ctx) {
  if (ctx.path !== '/api/v1/chat/completions') return false
  const body = JSON.parse(ctx.bodyText || '{}')
  ctx.state.bumpCompletionAttempts()
  if (ctx.state.getMockMode() === 'hold_once' && ctx.state.completionAttempts() === 1 && body.stream) {
    ctx.res.writeHead(200, { 'content-type': 'text/event-stream' })
    ctx.res.write('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n')
    ctx.state.holdResponses.push(ctx.res)
    return true
  }
  if (body.stream) {
    ctx.res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = 'data: {"id":"c1","object":"chat.completion.chunk",'
      + '"choices":[{"delta":{"content":"hi"}}]}\n\n'
    ctx.res.end(chunk + 'data: [DONE]\n\n')
    return true
  }
  ctx.json({
    id: 'c1',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content: 'hi' } }],
  })
  return true
}
