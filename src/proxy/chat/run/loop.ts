/**
 * chat 请求的选号-重试主循环 ---- 从 src/proxy.ts 的 handleChatCompletionsInner 提出.
 *
 * ## 为什么单独成文件
 *
 * 它是本仓最长的一段控制流(原 722 行函数的主体). 拆成四段读:
 *   ./acquire.ts 选号 + 拿账号锁(可能 continue 下一轮)
 *   ./turn.ts    发一次上游并回收结果
 *   本文件       失败归类 -> 决定换号/同号重试/收场
 *
 * ## 每请求独立语义(并发安全)
 *
 * 全部可变状态都在 st(每请求一份, 见 ./state.ts): attempt / lastKey /
 * pendingGateCode / pendingSwitchAccount / skipKeys / sameAccountRetries /
 * rt / releaseChat / releaseReserved / agentOverride. 本模块不持有任何模块级
 * 可变绑定 ---- 这是这次拆分不许破的底线(见 state.ts 的文件头).
 *
 * 口径: 纯搬移, 行为零改动.
 */
import { UpstreamError } from '../../../upstream/client.ts'
import { logger } from '../../../util/log.ts'
import { writeUpstreamError } from '../../transport/errors/respond.ts'
import { acquireTurn } from '../acquire/acquire.ts'
import { handleTurnError } from './errors.ts'
import { runUpstreamTurn } from './turn.ts'

/**
 * 跑完一次 chat 请求的全部重试.
 *
 * 返回即"这次请求已经有结论"(成功已写响应 / 失败已写错误), 调用方只需释放槽位.
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} res 下游响应
 * @returns {Promise<void>} 处理完成
 */
export async function runChatLoop(st: any, res: any) {
  // Session-first scheduling: reuse a live same-model slot, serialized per
  // account (one account handles at most accountMaxConcurrency chats at a
  // time). The upstream is stateless because clients send the full history.
  // 账号并发上限即"满了换号"的阈值:在途已满的账号排最后,新请求优先去
  // 有空闲槽位的账号;所有账号都满员时才排队(有界等待,超时 account_busy).
  // 故障转移:除了 4xx 客户端错误,任何上游失败(session/run/chat/网络超时)都
  // 冷却当前账号并继续轮询下一个,只有试完所有账号才把错误返回给用户.
  try {
    while (st.attempt < st.maxAttempts) {
      st.attempt++
      try {
        if (!(await acquireTurn(st))) continue
        const result = await runUpstreamTurn(st, res)
        if (await settleTurnResult(st, res, result)) return
        continue
      } catch (err: any) {
        if (await handleTurnError(st, res, err)) return
      }
    }
  } finally {
    // 请求结束(成功/失败/预算耗尽):释放账号串行化锁,恢复该账号轮询;
    // 并摘掉客户端断开监听器(keep-alive 连接复用,不摘会累积监听器).
    st.dropChatHold()
    st.chatGone.cleanup()
  }
}

/**
 * 幽灵连接(流 idle 超时被掐断)的短暂冷却.
 *
 * 响应头已提交, 无法整体重试, 但该账号刚被掐断过一条卡死的链路 ---- 上游/网络对
 * 该会话不稳定. 给账号一个短暂冷却(stallCooldownSec, 默认 30s), 让后续新请求优先
 * 去别的账号, 避免反复撞上同一条卡死链路(实测: 一个账号 3/3 满了还在持续接收请求).
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} result forwardCompletions 的结果
 * @returns {void} 无返回
 */
function coolStalledAccount(st: any, result: any) {
  const { runtimes } = st
  const config = st.config
  if (result.gateCode !== 'stream_idle_timeout' || config.limits.stallCooldownSec <= 0) return
  runtimes.markCooldown(
    st.lastKey,
    new UpstreamError('stream_idle_timeout', {
      code: 'stream_idle_timeout',
      status: 504,
      retryAfterMs: config.limits.stallCooldownSec * 1000,
    }),
    st.upstreamModel,
  )
  logger.warn('stream stall; cooling account briefly', {
    key: st.lastKey,
    email: st.rt?.email,
    model: st.upstreamModel,
    cooldownSec: config.limits.stallCooldownSec,
  })
}

/**
 * 回收一轮的上游结果: 幽灵连接冷却 / 可重试 / 终局失败三种去向.
 *
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} res 下游响应
 * @param {any} result forwardCompletions 的结果
 * @returns {Promise<boolean>} true = 请求已收场(调用方 return); false = 已安排重试(调用方 continue)
 */
async function settleTurnResult(st: any, res: any, result: any) {
  if (result.ok) return true

  coolStalledAccount(st, result)

  if (result.recoverable && st.attempt < st.maxAttempts) {
    // 先判定是否换号,再累加同号重试计数(顺序不能反:反了会让
    // 第一次同号重试就被判成"该换号").
    const willSwitch =
      result.switchAccount === true || st.sameAccountRetries >= 1
    st.sameAccountRetries = willSwitch ? 0 : st.sameAccountRetries + 1
    // free_mode_legacy_luna_agent:上游退役旧 Luna agent.agentIdForModel
    // 已对 luna 系强制 base3(见 model.ts),重试换 session 即用新 agent,
    // 不再需要额外的 agentOverride----任何 base2 尝试都不会发生.
    logger.warn('session error; will re-acquire', {
      code: result.gateCode,
      attempt: st.attempt,
      budget: st.maxAttempts,
      model: st.upstreamModel,
      key: st.lastKey,
      switchAccount: willSwitch,
      noCooldown: result.noCooldown === true,
      retryAfterMs: result.retryAfterMs ?? null,
    })
    st.pendingGateCode = result.gateCode
    st.pendingRetryAfterMs = result.retryAfterMs ?? null
    st.pendingSwitchAccount = willSwitch
    st.pendingNoCooldown = result.noCooldown === true
    // 换号前不再无条件早退 DELETE:那一小时是实付买断的,
    // 而上游早退不退 Freebucks.旧注释说"它已经在冷却,没人会再用它"----
    // 但冷却只有 60 秒,而这一小时还剩几十分钟可用(下一跳还能续用).
    // 只有付费时段已过才真正没有保留价值,那时才释放.
    // 换号前释放:走统一入口(付费时段内会被拒绝 ---- 那一小时是实付的)
    if (willSwitch && st.lastKey) {
      st.releaseSessionUnlessPaid(st.lastKey, 'switch account after gate error')
    }
    return false
  }

  await finalizeFailedTurn(st, res, result)
  return true
}

/**
 * 最后一次尝试也失败时的收场: 冷却账号 + 释放会话 + 把上游错误原样下发.
 *
 * 顺序与条件都有事故背书: 付费时段内绝不能释放(早退 DELETE 不退 Freebucks),
 * 4xx 客户端错误不冷却, 且只有 switchAccount 且非 noCooldown 才冷却.
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} res 下游响应
 * @param {any} result forwardCompletions 的结果
 * @returns {Promise<void>} 无返回
 */
async function finalizeFailedTurn(st: any, res: any, result: any) {
  // 最后一次尝试也失败:把当前账号标记冷却(gate 瞬时问题 noCooldown 除外),
  // 避免下一个请求立刻又撞上同一个故障账号.
  //
  // 同时必须把该账号的会话早退 DELETE 掉:请求已经不会再用这条
  // 会话了,留着只会白占上游会话槽位(一个账号同时只有一条 session 且
  // 绑定模型),换模型时会被它挡住.一次 admit 买断一小时,付费时段内
  // 换模型才需要早退腾槽位(那一小时已付款,闲置不额外花钱).
  // 释放失败也不丢句柄(SessionManager
  // 会保留 instanceId 并重试,sessions.json 里还有一份).
  /**
   - 付费时段内绝不释放(2026-10-04 真实事故修正).
   *
   - 旧行为:最后一次尝试失败就 releaseSession(),日志写
   - releasing session to free the slot.但那一小时是实付买断的,
   - 上游早退 DELETE 不退 Freebucks(实测只回 freebucksRefundPending
   - 且观察 2 分钟未到账)---- 于是"请求失败 + 钱白花 + 会话没了",
   - 用户看到的就是[请求完积分变零,还失败了].
   *
   - 更要命的是 428 waiting_room_required:上游原话是
   - "Send your message again to start a new one" ---- 它要的是重发,
   - 不是重买;而我们把会话扔了,重发就真的只能重买.
   *
   - 现在:只要会话仍在已付费时段内(inPaidWindow()),就保留句柄.
   - 闲置不额外花钱,而留着它下一跳还能续用(见 readmitToContinue).
   - 只有付费时段已过才释放腾槽位.
   *
   - 释放失败也不丢句柄(SessionManager 会保留 instanceId 并重试,
   - sessions.json 里还有一份).
   */
  if (st.lastKey) {
    const lastStatus = result.status
    const clientError =
      typeof lastStatus === 'number' &&
      lastStatus >= 400 &&
      lastStatus < 500 &&
      lastStatus !== 429 &&
      result.noCooldown !== true
    if (!clientError || result.gateCode === 'stream_idle_timeout') {
      // 统一入口:付费时段内会被拒绝(避免把已买断的一小时扔掉)
      st.releaseSessionUnlessPaid(st.lastKey, 'final attempt failed')
    }
  }
  if (result.switchAccount && !result.noCooldown) {
    st.runtimes.markCooldown(
      st.lastKey,
      new UpstreamError(result.gateCode || 'upstream_error', {
        code: result.gateCode || 'upstream_error',
        status: result.status,
        retryAfterMs: result.retryAfterMs ?? undefined,
      }),
      st.upstreamModel,
    )
  }

  if (!result.wrote) {
    await writeUpstreamError(
      res,
      result.status,
      result.body,
      result.headers,
    )
  }
  return true
}
