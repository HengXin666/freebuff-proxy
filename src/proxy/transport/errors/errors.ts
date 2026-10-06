/**
 * 错误判定与错误响应映射 ---- 从 stream-pipe.js 按职责切出.
 *
 * 这里判的都是"上游给了什么 → 我们怎么归类",与传输管道本身无关.
 */
import { extractRateLimitError } from '../../../upstream/client.ts'
import { unmapToolCallsInBody } from '../../../upstream/foreign-client-signals.ts'

/**
 * 判定上游 404 是否属于工具集指纹拒绝: 404 + "No endpoints found" 即判为工具被拒.
 *
 * 现场:带任意 tools -> 404 {"error":{"message":"No endpoints found for <model>","code":404}};
 * 同一个请求去掉 tools -> 200.
 *
 * 该错误字面指向模型, 与工具无关, 因此必须按"工具被拒"识别并走剥离重试,
 * 不按 4xx 客户端错误收场.
 *
 * 取舍与对照矩阵见
 * .agents/notes/implemented/bug-fix/2026-09-18-tool-schema-rejection-strip.md
 *
 * @param {number} status
 * @param {string} text 上游响应体原文
 * @returns {boolean}
 */
export function isToolSchemaRejection(status: number, text: string): boolean {
  if (status !== 404) return false
  const s = String(text || '')
  return (
    s.includes('No endpoints found') ||
    s.includes('no_endpoints') ||
    s.includes('no endpoints')
  )
}

/**
 * 上游 200 响应体内嵌的 free_mode 错误码检测.
 *
 * 上游可能 200 回执, 却在响应体里夹 free_mode_* 错误串; 只判 upstreamRes.ok
 * 会把它当成成功.
 *
 * 只做识别与告警, 不改变转发行为: 流式路径下响应体已被消费.
 *
 * 判据来源, 码表, 以及先落判据不接管道的取舍见
 * .agents/notes/implemented/bug-fix/2026-10-02-body-embedded-upstream-error.md
 *
 * @param {string} text 响应体原文(已流式接收的完整文本)
 * @returns {string | null} 命中的错误码
 */
export function upstreamBodyEmbeddedError(text: string): string | null {
  if (typeof text !== 'string' || !text) return null
  const CODES = [
    'free_mode_invalid_agent_model',
    'free_mode_invalid_agent_hierarchy',
    'free_mode_cli_required',
    'free_mode_rate_limited',
    'free_mode_capacity_deferred',
    'account_suspended',
    'model_unavailable',
  ]
  for (const c of CODES) if (text.includes(c)) return c
  return null
}

/**
 * 对上游响应文本做工具名还原(支持 SSE 流式与整体 JSON 两种形态).
 *
 * SSE:逐行看 data: {...},仅对可解析的 JSON 行做替换,其余原样.
 * 非 SSE(application/json 整体):直接 JSON.parse → 还原 → stringify.
 *
 * 任何解析失败都原样返回该行/原文: 还原失败不破坏响应.
 *
 * @param {string} text
 * @param {Iterable<string>|any[]} [declaredNames] 本次下游声明的工具名集合
 * @param {Record<string, any>} [declaredSchemas] 本次下游声明的工具 schema(名字 -> parameters)
 * @returns {string}
 */
export function unmapToolCallsInSse(
  text: string | null | undefined,
  declaredNames?: Iterable<string> | any[],
  declaredSchemas?: any,
): string | null | undefined {
  if (!text || typeof text !== 'string') return text
  const looksSse = text.includes('data: ')
  if (!looksSse) {
    try {
      return JSON.stringify(unmapToolCallsInBody(JSON.parse(text), declaredNames, declaredSchemas))
    } catch {
      return text
    }
  }
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data: ')) return line
      const payload = line.slice(6).trim()
      if (!payload || payload === '[DONE]') return line
      try {
        // JSON.parse 的返回值本质是 any:这里只做结构探测,解析失败由外层 catch 原样返回.
        type SseChoice = {
          message?: { tool_calls?: unknown }
          delta?: { tool_calls?: unknown }
        }
        const obj = JSON.parse(payload) as { choices?: SseChoice[] } | null
        const hasCalls = Array.isArray(obj?.choices)
          ? obj.choices.some(
              (c) =>
                Array.isArray(c?.message?.tool_calls) ||
                Array.isArray(c?.delta?.tool_calls),
            )
          : false
        if (!hasCalls) return line
        return 'data: ' + JSON.stringify(unmapToolCallsInBody(obj, declaredNames, declaredSchemas))
      } catch {
        return line
      }
    })
    .join('\n')
}

/**
 * 上游 chat/completions 报错时是否应冷却当前账号并换号重试:
 * 429(限流/配额),5xx(服务端故障),403 账号级封禁(banned/country_blocked/ip_capped),
 * free_mode_rate_limited 等账号级限流 code,以及 start_agent_run_failed(startAgentRun
 * 被上游拒绝=该账号+agent 组合不可用/账号级问题,即使 403/4xx 也应按账号故障换号).
 * 其余 4xx 客户端错误不换号.
 * @param {number} status
 * @param {unknown} code
 * @returns {boolean}
 */
export function shouldSwitchAccountOnError(status: number | undefined, code: unknown): boolean {
  /**
   *  503 不冷却账号: 它是模型侧问题, 处置与 purchase_capacity 同类 --
   * 跳过不冷却, 保留 switchAccount 语义(试下一个账号, 不冷却当前账号).
   * 见 docs/reverse/07-503-root-cause.md
   * 503 文案不带原因, 不能当作模型映射的判据, 见
   * .agents/notes/implemented/bug-fix/2026-10-01-chat-503-not-model-mapping.md
   */
  // status 可能为 undefined(上游错误体里没带 HTTP 码): 此时按码判定不成立,
  // undefined >= 500 为 false.
  if (status === 503) return false
  if (status !== undefined && status >= 500) return true
  if (status === 429) return true
  const codeStr = String(code)
  // country_blocked 是出口属性不是账号属性:所有账号共享同一个出口,
  // 换号只会把每个账号的额度依次买断一遍(一次 admit = 一整小时 Freebucks),
  // 却永远拿不到答案.它必须直接失败并把错误告知用户: 出路是换代理,不是换号.
  // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
  if (codeStr === 'country_blocked') return false
  // purchase_capacity:该账号的付费槽位已被占(一个账号 slotLimit:1).
  // 它是资源竞争不是账号故障 ---- 冷却换号只会把别的账号也依次买断,
  // 而回执已经给出 currentInstanceId 与 nextExpiryAt,等它空出即可.
  // 实测语义见 .agents/notes/implemented/bug-fix/2026-10-01-admission-handle-and-403.md
  if (codeStr === 'purchase_capacity') return false
  // premium_slot_taken / purchase_in_use:同上,都是"槽位正在被用".
  if (codeStr === 'premium_slot_taken' || codeStr === 'purchase_in_use') {
    return false
  }
  if (status === 403 && ['banned', 'ip_capped'].includes(codeStr)) {
    return true
  }
  // startAgentRun 失败:上游拒绝启动 run(模型/agent 不可用,该账号被限制等).
  // 无论返回什么状态码都冷却当前账号换下一个;试完所有账号才把错误返回给客户端.
  if (codeStr === 'start_agent_run_failed') return true
  return extractRateLimitError({ error: code }, status) !== null
}

/**
 * Parse Retry-After header (seconds or HTTP-date) into ms, or null.
 * @param {unknown} value Retry-After 头原值(秒数或 HTTP-date)
 * @returns {number|null} 毫秒;为空或无法解析时返回 null
 */
export function parseRetryAfterMsHeader(value: unknown): number | null {
  if (!value) return null
  const secs = Number(value)
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000)
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? Math.max(0, ms - Date.now()) : null
}
