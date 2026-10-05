/**
 - 上游失败的载体  --  UpstreamError 与响应体读取工具.
 *
 - 这一层不认识任何具体上游端点, 只定义"失败长什么样"
 - (status / code / cause / fatal / terminalExhausted 五个字段的含义与分工),
 - 以及读 body 的超时兜底.
 */

/** UpstreamError 的附加字段. */
export interface ErrorExtra {
  status?: number
  code?: string
  body?: any
  retryAfterMs?: number
  fatal?: boolean
  cause?: string
  terminalExhausted?: boolean
}

/** safeText 能接受的最小响应形态. */
export interface SafeTextRes {
  body?: any
  text: () => Promise<string>
}

/** 上游调用失败的统一错误载体. */
export class UpstreamError extends Error {
  status?: number
  code?: string
  body?: any
  retryAfterMs?: number
  cause?: string
  fatal: boolean
  terminalExhausted: boolean

  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, body?: any, retryAfterMs?: number,
   *   fatal?: boolean, cause?: string, terminalExhausted?: boolean }} [extra]
   */
  constructor(message: string, extra: ErrorExtra = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = extra.status
    this.code = extra.code
    this.body = extra.body
    this.retryAfterMs = extra.retryAfterMs
    /**
     * 底层原始错误码(ECONNREFUSED / ENOTFOUND / ETIMEDOUT ...).
     *
     * 与 code 分工:code 是稳定的业务码(多处按集合匹配, 不透裸 socket 码);
     * cause 保留原始错误码供排障与前端细提示. 两者同时给出, message 里也带一份.
     */
    this.cause = extra.cause
    // 出口级故障(地理封锁):调度层据此立即停止换号 ---- 它是出口属性,
    // 换号只会把每个账号的额度依次买断却拿不到答案.
    // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
    this.fatal = extra.fatal === true
    /**
     * 全池额度耗尽的终态标记(与 fatal 区分).
     *
     * fatal = 出口属性(地理封锁), 换号无用.
     * terminalExhausted = 池内每个账号都被额度闸门拒过(遍历完才得出的聚合结论),
     * 换号/同号重试都不可能有不同结果 ---- 外层据此一次收场, 不再轮 maxAttempts 轮.
     * 见 .agents/notes/implemented/bug-fix/2026-10-04-terminal-exhausted-and-log-ring-cap.md
     */
    this.terminalExhausted = extra.terminalExhausted === true
  }
}

/**
 * 读取上游响应 body 文本,带超时兜底:上游发完响应头后 body 迟迟不来
 * (幽灵连接)时取消 body 读取,避免控制面请求永远挂起.
 *
 * @param {Response} res 上游响应
 * @param {number} [timeoutMs] body 读取超时毫秒
 * @returns {Promise<string>} body 文本;超时/无 body 时返回空串
 */
export async function safeText(res?: SafeTextRes | null, timeoutMs = 10_000): Promise<string> {
  if (!res || !res.body) return ''
  try {
    return await Promise.race([
      res.text(),
      new Promise<string>((_, reject) => {
        const timer = setTimeout(() => {
          res.body?.cancel().catch(() => {})
          reject(new Error('upstream body read timeout'))
        }, timeoutMs)
        if (timer.unref) timer.unref()
      }),
    ])
  } catch {
    return ''
  }
}

/**
 * retry-after 头的解析(秒数或 HTTP 日期两种形态).
 *
 * @param {string | null} value retry-after 头的原始值
 * @returns {number | undefined} 毫秒;无法解析时 undefined
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined
}
