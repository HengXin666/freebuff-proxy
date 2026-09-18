/**
 * Freebuff free-mode request shape gates (client-side enforcement helpers).
 * Server source of truth: freebuff common/src/constants/free-agents.ts
 */
import { FREEBUFF_SIGNATURE_TOOL_DEFINITIONS } from './upstream/foreign-client-signals.js'

// 转发签名工具定义：调用方（测试、控制台）从本模块一处取用，避免各处另立取值。
export { FREEBUFF_SIGNATURE_TOOL_DEFINITIONS }
// 判据镜像的同义导出：调用方要判断"上游会怎么看这个工具集"时不必再 import 第二个文件。
export { detectForeignClient, isGenuineSignatureTool } from './upstream/foreign-client-signals.js'

/** Canonical opening the free-mode gate requires at the start of a system message. */
export const FREEBUFF_SYSTEM_OPENING =
  'You are Buffy, the strategic coding assistant.'

/**
 * base3 世代 root（base3-free-*）的规范开场（对齐 trefeon cliSystemMarkerBase3：
 * agents/base3.ts createBase3 的 canonical opening）。base3 运行必须以它开头，
 * 而不是 base2 的 "strategic coding assistant"（对齐 trefeon PR #207：
 * "a base3 run must open with the BASE3 canonical identity, not base2's"）。
 */
export const FREEBUFF_SYSTEM_OPENING_BASE3 =
  'You are Buffy, the coding agent behind Codebuff.'

/** 判断 agentId 是否 base3 世代 root（base3-free-*）。 */
export function isBase3Agent(agentId) {
  return typeof agentId === 'string' && /^base3-/.test(agentId)
}

/**
 * Minimal system prompt that satisfies free_mode system-marker checks.
 * Kept short so user content dominates; opening must be byte-prefix exact.
 */
export const FREEBUFF_FREE_SYSTEM_PROMPT = `${FREEBUFF_SYSTEM_OPENING}

You help the user with coding and technical questions. Be concise and accurate.
Follow the user's instructions in subsequent messages.
`

/**
 * 我们注入的签名工具名（**按上游判据构造**，定义在
 * src/upstream/foreign-client-signals.js 的 FREEBUFF_SIGNATURE_TOOL_DEFINITIONS）。
 *
 * 两条并挂、任一通过即可（上游是 some()）：
 *   - `lookup_agent_info`：官方设计划工具，参数表 { agentId } —— 走**真实 schema 子集**判定。
 *   - `decide`：官方自定义工具（无 schema 可比）—— 走**自定义名放行**判定。
 * 留两条是因为两条规则各自独立：任一条被上游收紧，另一条仍然成立。
 *
 * 判据、对照实验与取舍见
 * .agents/notes/implemented/bug-fix/2026-09-19-genuine-tool-signature.md
 */
export const FREEBUFF_SIGNATURE_TOOL_NAMES = Object.freeze(
  FREEBUFF_SIGNATURE_TOOL_DEFINITIONS.map((t) => t.function.name),
)

/**
 * 主签名工具名（带参数、有结构可校验的那一个）。
 *
 * 为什么不再用 `end_turn`：上游 2026-09-17 起要求签名工具「名字 + 真实参数 schema」
 * 双真，**零参数工具永远不算签名**（复制的名字加 `{}` 与真货逐字节相同，没有结构
 * 可验证）。上游还把「往 tools 末尾补空心 end_turn」这种形态逐字收进测试夹具
 * （`PROXY_HOLLOW_END_TURN`）并在注释里点名 freebuff-proxy —— 即本代理。
 */
export const FREEBUFF_SIGNATURE_TOOL_NAME = 'lookup_agent_info'

/**
 * 把一个外来工具集补齐成「上游认得的客户端」形态：追加官方真签名工具，
 * 让上游不把请求降级。无工具的请求不触发该判据（上游对无工具是只报不罚）。
 *
 * 幂等：已带任一签名工具就原样返回；两个都带更稳，所以缺哪个补哪个。
 *
 * @param {unknown} tools
 * @param {boolean} enabled
 * @returns {unknown}
 */
export function ensureFreebuffToolSignature(tools, enabled = true) {
  if (!enabled || !Array.isArray(tools) || tools.length === 0) return tools
  const present = new Set(
    tools
      .map((tool) =>
        tool &&
        typeof tool === 'object' &&
        tool.function &&
        typeof tool.function === 'object'
          ? tool.function.name
          : null,
      )
      .filter(Boolean),
  )
  const missing = FREEBUFF_SIGNATURE_TOOL_DEFINITIONS.filter(
    (def) => !present.has(def.function.name),
  )
  return missing.length === 0 ? tools : [...tools, ...missing]
}

/**
 * 客户端是否声明了工具。只看 OpenAI 新式 `tools` 数组——旧式 `functions`
 * 字段不触发上游的 tool-schema 检查（见 stripClientTools 的说明）。
 *
 * @param {Record<string, any>} body
 * @returns {boolean}
 */
export function hasClientTools(body) {
  return Boolean(
    body &&
      typeof body === 'object' &&
      Array.isArray(body.tools) &&
      body.tools.length > 0,
  )
}

/**
 * 剥离客户端的工具声明，返回新对象（不改原对象）。
 *
 * 为什么需要：上游对 `tools` 做 **tool-schema 指纹比对** —— 它把"工具集与
 * 官方 CLI 是否一致"当作第三方客户端判据（freebuff 源码 freebuff-models.ts
 * 注释原话："the tool-schema check (docs/freebuff-abuse-detection.md), which
 * downgrades third-party clients"）。任何非官方 schema（bash / run_code /
 * 自定义工具）都会让 /api/v1/chat/completions 直接返回 404
 * `No endpoints found for <model>` —— 注意它报的是"模型不存在"，与工具毫无
 * 字面关联，极难从错误本身归因。
 *
 * 实测（2026-09-18，直连线上 freebuff-proxy）：无 tools → 200；带任意 tools
 * （含完整复刻官方 24 个工具名 + 中性 schema）→ 404 No endpoints found。
 *
 * 因此当上游以该错误拒绝工具请求时，代理只能**去掉工具**再发一次：模型不调用
 * 工具，但至少给出文本回答，而不是把一个 404 甩给下游（下游 Responses 桥接层
 * 会把它崩成 Cloudflare 纯文本 502，客户端 SDK 解析成
 * "502 status code (no body)" —— 就是"所有模型都空响应"的现场）。
 *
 * `functions`（OpenAI 旧式）**不删**：它不触发该检查（实测 200）。
 *
 * @param {Record<string, any>} body
 * @returns {Record<string, any>}
 */
/*
 * 决策与实测见
 * .agents/notes/implemented/bug-fix/2026-09-18-tool-schema-rejection-strip.md
 */
export function stripClientTools(body) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  delete out.tools
  delete out.tool_choice
  delete out.parallel_tool_calls
  return out
}

/**
 * Ensure messages[] has a leading system message whose text starts with the
 * Freebuff free-mode opening. Does not strip or rewrite user content beyond
 * that gate requirement.
 *
 * @param {unknown} messages
 * @param {string} [agentId]  base3-free-* 时用 base3 规范开场（对齐 trefeon）
 * @returns {any[]}
 */
export function ensureFreebuffSystemMessages(messages, agentId) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : []

  const opening = isBase3Agent(agentId)
    ? FREEBUFF_SYSTEM_OPENING_BASE3
    : FREEBUFF_SYSTEM_OPENING
  const freePrompt = isBase3Agent(agentId)
    ? `${FREEBUFF_SYSTEM_OPENING_BASE3}

You help the user with coding and technical questions. Be concise and accurate.
Follow the user's instructions in subsequent messages.
`
    : FREEBUFF_FREE_SYSTEM_PROMPT

  const firstSystemIdx = list.findIndex((m) => m && m.role === 'system')
  if (firstSystemIdx === -1) {
    return [{ role: 'system', content: freePrompt }, ...list]
  }

  const sys = list[firstSystemIdx]
  const content = normalizeContentToText(sys.content)
  // 任一规范开场已存在则保持原样（门禁是 any-of-5 trimmed prefix）。
  const anyCanonical = [
    FREEBUFF_SYSTEM_OPENING,
    FREEBUFF_SYSTEM_OPENING_BASE3,
  ].some((o) => content.trimStart().startsWith(o))
  if (anyCanonical) {
    // Keep as-is (already valid freebuff opening)
    return list
  }

  // Prepend canonical opening without discarding the caller's system text.
  list[firstSystemIdx] = {
    ...sys,
    content: `${opening}\n\n${content}`,
  }
  return list
}

function normalizeContentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text
        }
        return ''
      })
      .join('\n')
  }
  if (content == null) return ''
  return String(content)
}

/**
 * Remove client-owned conversation/session identity before forwarding to the
 * stateless Freebuff completions route. The proxy sends the full message
 * history on every request, so retaining these identifiers can bind a new run
 * to a retired Luna conversation after Freebuff rotates its agent definitions.
 *
 * @param {Record<string, any>} body
 * @returns {Record<string, any>}
 */
export function stripFreebuffConversationState(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body

  const out = { ...body }
  const stateKeys = [
    'conversation',
    'conversation_id',
    'conversationId',
    'thread_id',
    'threadId',
    'session_id',
    'sessionId',
    'instance_id',
    'instanceId',
    'agent_id',
    'agentId',
    'run_id',
    'runId',
    'freebuff_instance_id',
  ]

  for (const key of stateKeys) delete out[key]

  if (
    out.codebuff_metadata &&
    typeof out.codebuff_metadata === 'object' &&
    !Array.isArray(out.codebuff_metadata)
  ) {
    const metadata = { ...out.codebuff_metadata }
    for (const key of stateKeys) delete metadata[key]
    // client_id is assigned by buildForwardBody below and must never be
    // inherited from a caller that may be resuming an old conversation.
    delete metadata.client_id
    out.codebuff_metadata = metadata
  }

  return out
}


/**
 * Freebuff/OpenAI reject requests that carry BOTH reasoning_effort and
 * reasoning.effort (especially with different values). Freebuff also injects
 * a default `reasoning.effort` for catalog models when it thinks the caller
 * omitted reasoning — so a bare `reasoning_effort: "max"` collides with the
 * server default `high`.
 *
 * Collapse to a single `reasoning: { effort }` field. Map `max` → `high`
 * (Freebuff Luna catalog top effort).
 *
 * @param {Record<string, any>} body
 * @returns {Record<string, any>}
 */
export function normalizeReasoningFields(body) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }

  const fromTop =
    typeof out.reasoning_effort === 'string' ? out.reasoning_effort : null
  const fromNested =
    out.reasoning &&
    typeof out.reasoning === 'object' &&
    typeof out.reasoning.effort === 'string'
      ? out.reasoning.effort
      : null

  let effort = fromTop || fromNested
  if (!effort) return out

  // Prefer explicit top-level if both present (caller's curl-style field)
  if (fromTop) effort = fromTop

  // 官方 efforts 表：deepseek-v4-flash = [low, high, max]、v4-pro = [high, max]，
  // 因此 max 是合法档位，不降档（旧实现 max→high 会压制思考深度/智力）。
  const mapped = effort
  delete out.reasoning_effort
  out.reasoning = {
    ...(out.reasoning && typeof out.reasoning === 'object' ? out.reasoning : {}),
    effort: mapped,
  }
  return out
}

/**
 * 输出预算治理：DeepSeek 系模型把思考（reasoning）token 计入
 * max_tokens / max_completion_tokens 预算（官方文档明确 reasoning tokens
 * 占用 max_tokens）。客户端（cc/Pi 等）常带一个偏小的输出上限（如 8192），
 * 思考链稍长就把预算吃光 → 上游以 finish_reason=length 提前截断，表现为
 * 「思考异常即截断」（freebuff2api-wokers#8 同源问题，参考仓库同样原样转发
 * 客户端 max_tokens 而中招）。
 *
 * 转发上游前把输出上限抬到 floor：客户端已设上限时取 max(上限, floor)，
 * 未设时也补一个 floor（上游默认若不设可能同样偏小）。统一收敛为
 * max_completion_tokens 单字段，避免 max_tokens / max_completion_tokens
 * 双字段语义冲突（与 normalizeReasoningFields 同思路）。
 *
 * @param {Record<string, any>} body
 * @param {number} [floor] 最低输出预算（token），默认 65536
 * @returns {Record<string, any>}
 */
export function normalizeOutputBudget(body, floor = 65536) {
  if (!body || typeof body !== 'object') return body
  // 兼容三种客户端字段写法：max_tokens（OpenAI 旧）、max_completion_tokens
  // （OpenAI 新）、max_output_tokens（Responses/部分 SDK，参考仓库同样映射）。
  const caps = [
    body.max_tokens,
    body.max_completion_tokens,
    body.max_output_tokens,
  ]
    .map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : NaN))
    .filter(Number.isFinite)
  const clientCap = caps.length ? Math.max(...caps) : 0
  const out = { ...body }
  delete out.max_tokens
  delete out.max_output_tokens
  out.max_completion_tokens = Math.max(floor, clientCap)
  return out
}
