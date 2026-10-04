/**
 * 错误判定与错误响应映射 —— 从 stream-pipe.js 按职责切出.
 *
 * 这里判的都是"上游给了什么 → 我们怎么归类",与传输管道本身无关.
 */
import { extractRateLimitError } from '../upstream/client.js'
import { unmapToolCallsInBody } from '../upstream/foreign-client-signals.js'

/**
 * 上游是否因为工具集指纹拒绝了这次 chat.
 *
 * 现场(2026-09-18 直连线上 freebuff-proxy 一手实测):带任意 tools
 * (含逐字复刻官方 24 个工具名 + 中性 schema)→
 * 404 {"error":{"message":"No endpoints found for <model>","code":404}};
 * 同一个请求去掉 tools → 200.
 *
 * 这条错误字面指向模型,与工具毫无关联——正因如此它长期被当成
 * "模型不存在/不可用"处理(404 属于 4xx 客户端错误,不换号,不重试),
 * 最终把一个 404 透传给下游;下游 Responses 桥接层把它崩成 Cloudflare
 * 纯文本 502,客户端 SDK 解析成 "502 status code (no body)",表现为
 * 所有模型全部空响应.
 *
 * 所以必须按"工具被拒"识别并走剥离重试,不能按客户端 4xx 收场.
 * 取舍与实测矩阵见
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
 * 上游并不总是用 HTTP 状态码表达失败:它可能 200 回执,却在响应体里夹
 * free_mode_* 错误串.只判 upstreamRes.ok 会把它当成成功,错误被静默吞掉.
 * 第三方实现(lza6/Freebuff-2API upstream_body_error)对 200 也扫这类串,
 * 本仓库此前只在 !upstreamRes.ok 分支解析错误体 —— 这是真缺口.
 *
 * 只做识别与告警,不改变任何转发行为:流式路径下响应体已被消费,
 * 接入需要改 pipe 流程,属于行为改动,需单独验证.
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
 * 任何解析失败都原样返回该行/原文 —— 这条路径绝不能因为还原而破坏响应
 * (还原是"锦上添花",不是"必须成功").
 *
 * @param {string} text
 * @returns {string}
 */
export function unmapToolCallsInSse(
  text: string | null | undefined,
): string | null | undefined {
  if (!text || typeof text !== 'string') return text
  const looksSse = text.includes('data: ')
  if (!looksSse) {
    try {
      return JSON.stringify(unmapToolCallsInBody(JSON.parse(text)))
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
        return 'data: ' + JSON.stringify(unmapToolCallsInBody(obj))
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
export function shouldSwitchAccountOnError(status: number, code: unknown): boolean {
  /**
   *  503 不冷却账号(2026-10-04 真实事故修正).
   *
   * docs/reverse/07 的定因:503 The model is temporarily unavailable
   * 不是账号故障,是模型侧问题(该文档实测:三个价格档,多个模型,
   * 多种身份组合全部 503 → 变量不在请求里,也不在账号上).
   *
   * 旧行为把它当 5xx → switchAccount → markCooldown:
   * 于是唯一有余额的账号被踢出池子,剩下全是 0 余额号 →
   * 后续每个请求都 429 freebucks_exhausted.
   * 实测远程日志(15:02:21-15:02:37):loli@woa.qzz.io(25 点)
   * 被 503 冷却后,其余请求只剩两个 0 余额号可跳,用户看到
   * [明明有 25 点却一直 429].
   *
   * 处置与 purchase_capacity 同类:跳过,不冷却(模型侧问题等它自己恢复 /
   * 换个模型),绝不把可用的账号判死.
   *
   *  仍保留 switchAccount 语义(试下一个账号不冷却当前账号)——
   * 多账号池里换个号确实可能成功,但不该留下冷却记录.
   */
  if (status === 503) return false
  if (status >= 500) return true
  if (status === 429) return true
  const codeStr = String(code)
  // country_blocked 是出口属性不是账号属性:所有账号共享同一个出口,
  // 换号只会把每个账号的额度依次买断一遍(一次 admit = 一整小时 Freebucks),
  // 却永远拿不到答案.它必须直接失败并把原因告知用户 —— 出路是换代理,不是换号.
  // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
  if (codeStr === 'country_blocked') return false
  // purchase_capacity:该账号的付费槽位已被占(一个账号 slotLimit:1).
  // 它是资源竞争不是账号故障 —— 冷却换号只会把别的账号也依次买断,
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
  // 无论返回什么状态码都冷却当前账号换下一个,而不是直接把错误甩给用户——
  // 试完所有账号(预算=账号数+1)才把错误返回给客户端.
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
