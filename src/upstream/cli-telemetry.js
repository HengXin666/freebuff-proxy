/**
 * 官方 CLI 的遥测上报（POST https://www.codebuff.com/api/logs）。
 *
 * 为什么需要：官方 CLI 运行时**主动上报生命周期事件**，我们从不上报 ——
 * 从服务端看就是一个「只发 chat、没有任何客户端生命迹象」的连接。
 * 而且 `cli.fingerprint_generated` 带 `success: true`，那是自证「我是真 CLI」。
 *
 * 报文格式取自真机抓包（mitmproxy 拦本地 CLI 进程，未碰第三方流量）：
 *   POST https://www.codebuff.com/api/logs
 *   {"records":[
 *     {"level":"info","event":"cli.fingerprint_generated",
 *      "message":"cli.fingerprint_generated",
 *      "client_session_id":"anon_<uuid>",
 *      "data":{"fingerprintType":"enhanced_cli","success":true}}
 *   ]}
 *
 * ⚠️ posthog（us.i.posthog.com）**不实现** —— 那是第三方 SaaS，
 * 与「是不是真 CLI」的判定无关，且会把数据交给第三方。
 *
 * 事件名真源（官方二进制提取，26 个）见
 * .agents/notes/proposed/architecture/2026-09-30-cli-telemetry-reports.md
 */
import { randomUUID } from 'crypto'
import { logger } from '../util/log.js'

/** 遥测上报端点（官方真值）。 */
export const TELEMETRY_ENDPOINT = 'https://www.codebuff.com/api/logs'

/**
 * 一次进程生命周期共用的客户端会话 id。官方形态：`anon_<uuid>`。
 * 所有事件共用它 —— 服务端据此把事件串成一个客户端的行为轨迹。
 */
let clientSessionId = null

export function telemetrySessionId() {
  if (!clientSessionId) {
    clientSessionId = 'anon_' + randomUUID()
  }
  return clientSessionId
}

/** 测试用：重置会话 id。 */
export function resetTelemetrySession() {
  clientSessionId = null
}

/**
 * 官方 CLI 的遥测事件名（二进制提取全集）。只实现我们确实会发生的那些 ——
 * 编造依赖真实交互的事件（terminal_command_completed 等）就是自相矛盾的噪声。
 */
export const CLI_EVENTS = {
  APP_LAUNCHED: 'cli.app_launched',
  FINGERPRINT_GENERATED: 'cli.fingerprint_generated',
  LOGIN_STARTED: 'cli.login_started',
  LOGIN: 'cli.login',
  LOGIN_ABORTED: 'cli.login_aborted',
  LOGIN_FAILED: 'cli.login_failed',
  LOGIN_TIMEOUT: 'cli.login_timeout',
  CHANGE_DIRECTORY: 'cli.change_directory',
  FATAL_CRASH: 'cli.fatal_crash',
}

/**
 * 攒一批待上报记录（官方是批量发，不是一条一发）。
 * @type {Array<{ level: string, event: string, message: string, client_session_id: string, data: object }>}
 */
const pending = []

/** 单批上限：超过就立刻冲刷，避免无限堆积。 */
const MAX_PENDING = 50

/**
 * 记一条遥测事件（入队，不立即发送）。
 * @param {string} event 事件名（见 CLI_EVENTS）
 * @param {object} [data] 事件数据
 * @param {'info'|'warn'|'error'} [level]
 */
export function trackCliEvent(event, data = {}, level = 'info') {
  pending.push({
    level,
    event,
    message: event,
    client_session_id: telemetrySessionId(),
    data,
  })
  if (pending.length >= MAX_PENDING) {
    // 不 await：上报绝不能阻塞请求路径
    void flushTelemetry(null)
  }
}

/**
 * 冲刷待发记录。best-effort：任何失败都静默，绝不影响代理可用性。
 * @param {null | ((url: string, init: object) => Promise<Response>)} fetchImpl
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<number>} 成功上报的条数
 */
export async function flushTelemetry(fetchImpl, opts = {}) {
  if (!pending.length) return 0
  const batch = pending.splice(0, pending.length)
  const fn = fetchImpl || globalThis.fetch
  if (typeof fn !== 'function') return 0
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 5_000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  if (timer.unref) timer.unref()
  try {
    const res = await fn(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 与 CLI 一致：非 chat 调用用裸 UA（Bun 形态由调用方或默认提供）
      body: JSON.stringify({ records: batch }),
      signal: ac.signal,
    })
    if (!res.ok) {
      logger.debug('telemetry rejected', { status: res.status })
      return 0
    }
    return batch.length
  } catch {
    // 网络失败/超时：静默丢弃。遥测不是功能，绝不能让它影响可用性。
    return 0
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 上报「启动」这一组事件（官方 CLI 进程起来就会发的两条）。
 * 必须在 fingerprint 生成之后调用 —— data.success 如实反映结果。
 * @param {{ fingerprintSuccess?: boolean, fetchImpl?: any }} [opts]
 */
export function reportCliLaunch(opts = {}) {
  trackCliEvent(CLI_EVENTS.APP_LAUNCHED, {})
  trackCliEvent(CLI_EVENTS.FINGERPRINT_GENERATED, {
    fingerprintType: 'enhanced_cli',
    success: opts.fingerprintSuccess !== false,
  })
  return flushTelemetry(opts.fetchImpl || null)
}
