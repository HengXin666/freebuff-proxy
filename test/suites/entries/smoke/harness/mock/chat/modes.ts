/**

 * mock chat: 各故障与流式模式
 *
 * 按 state.mockMode 复刻上游的各类拒绝(停摆 / 闸门 / 限流 / 封禁 / 容量 / 等候室 / 网络错)与流式回执.
 *
 * 按模式族拆成五个子函数.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { compAuthOf, jsonRes } from '../../helpers.ts'

/** 停摆类: 200 后不吐数据 / 只吐一块 / 吐完卡死, 用于换号重试与下游背压. */
function stallReply(headers) {
// stall_zero: 200 OK with a streaming body that never sends any data nor closes
// (只对 token-spa 的第一次尝试生效,验证换号重试)
const stallAuth =
  headers.Authorization ||
  headers.authorization ||
  headers['x-codebuff-api-key'] ||
  ''
if (
  state.mockMode === 'stall_zero' &&
  state.completionAttempts === 1 &&
  String(stallAuth).includes('token-sa')
) {
  return new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}
// stall_partial: enqueue one chunk then stall forever
if (
  state.mockMode === 'stall_partial' &&
  state.completionAttempts === 1 &&
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
// bigstall: 一次性下发大块数据后卡死----用于下游背压(客户端不读)场景,
// 大块写会让下游 socket 缓冲区填满 → write() 返回 false → 等待 drain
if (state.mockMode === 'bigstall') {
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
  return null
}

/** 拒绝类: 闸门 / 工具指纹 / 封禁 / 500 / 容量排队. */
function refuseReply(body, headers) {
// First completion fails with recoverable gate; second succeeds.
if (state.mockMode === 'gate_once' && state.completionAttempts === 1) {
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
  state.mockMode === 'rate_limit_completion' &&
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
// 上游 tool-schema 指纹拒: 原样复刻线上回执, 带 tools 一律 404 "No endpoints found",
// 去掉 tools 后放行.
if (state.mockMode === 'tool_schema_reject' && Array.isArray(body.tools)) {
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
// 账号封禁:403 {"error":"account_suspended"}(error 是字符串)
if (state.mockMode === 'suspended_a' && String(compAuthOf(headers)).includes('token-a')) {
  return jsonRes(
    {
      error: 'account_suspended',
      message:
        'Your account has been suspended for accessing Freebuff with a third-party client or proxy.',
    },
    403,
  )
}
// 所有账号的 chat 都 500(账号级故障 → 连续换号),用于验证新会话预算
if (state.mockMode === 'err_500_all') {
  return jsonRes({ error: 'internal_error', message: 'boom' }, 500)
}
if (state.mockMode === 'err_500_a' && String(compAuth).includes('token-a')) {
  return jsonRes({ error: 'internal_error', message: 'boom' }, 500)
}
  return null
}

/** 容量排队类: capacity_once 首次 / capacity_all 持续. 两者都不冷却账号. */
function capacityReply() {
// free_mode_capacity_deferred:瞬时容量排队,换号重试不冷却
if (state.mockMode === 'capacity_once' && state.completionAttempts === 1) {
  return jsonRes(
    {
      error: 'free_mode_capacity_deferred',
      message:
        'Free mode is briefly at capacity; your request will be retried automatically.',
    },
    429,
  )
}
if (state.mockMode === 'capacity_all') {
  return jsonRes(
    {
      error: 'free_mode_capacity_deferred',
      message:
        'Free mode is briefly at capacity; your request will be retried automatically.',
    },
    429,
  )
}
  return null
}

/** 等候室类: 428 等候室与同账号连续 gate 失败 / 网络层错误. */
function waitingReply(body, headers) {
  // compAuth 在本函数内重建, gate_twice_a / network_err_a 两条分支都要用它.
  const compAuth =
    headers.Authorization ||
    headers.authorization ||
    headers['x-codebuff-api-key'] ||
    ''
/**
 * waiting_room_required(428): 首次 completion 返回它, 其后放行.
 *
 * 回执形态: admit 200 扣 15 余额 25→10, 紧接着 chat 428.
 * 余额 10 < 单价 15, 让"买不起下一个小时"这道闸门在续用时必然命中.
 */
if (state.mockMode === 'waiting_room_once' && state.completionAttempts === 1) {
  return jsonRes(
    {
      error: 'waiting_room_required',
      message:
        'Your free session has ended. Send your message again to start a new one.',
    },
    428,
  )
}
// 同账号连续 gate 失败(session_superseded ×2)→ 升级换号
if (
  state.mockMode === 'gate_twice_a' &&
  String(compAuth).includes('token-a') &&
  state.completionAttempts <= 2
) {
  return jsonRes({ error: 'session_superseded', message: 'taken over' }, 409)
}
// 网络层错误(fetch 抛异常)→ 换号重试
if (state.mockMode === 'network_err_a' && String(compAuth).includes('token-a')) {
  throw new Error('ECONNRESET: socket hang up')
}
  return null
}

/** 正常路径: hold_once 挂起流与普通流式 / 非流式回执. */
function normalReply(body, headers) {
// hold_once:第一次流式响应保持打开(先吐一个 chunk),
// 直到 releaseHoldStreams() 放行----用于模拟"正在传输的长流".
if (state.mockMode === 'hold_once' && state.completionAttempts === 1 && body.stream) {
  return new Response(
    new ReadableStream({
      start(controller) {
        state.holdStreamControllers.push(controller)
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n',
          ),
        )
      },
      cancel() {
        const i = state.holdStreamControllers.indexOf(controller)
        if (i >= 0) state.holdStreamControllers.splice(i, 1)
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

/** 按 state.mockMode 返回对应回执; 未命中任何模式时走正常 200.
 * @param {any} body
 * @param {any} headers
 * @returns {any}
 */
export function modesReply(body, headers) {
  state.completionAttempts++
  const stall = stallReply(headers)
  if (stall) return stall
  const refuse = refuseReply(body, headers)
  if (refuse) return refuse
  const capacity = capacityReply()
  if (capacity) return capacity
  const waiting = waitingReply(body, headers)
  if (waiting) return waiting
  return normalReply(body, headers)
}
