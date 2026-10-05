/**
 * 一轮的选号 ---- 从 src/proxy.ts 的 handleChatCompletionsInner 提出.
 *
 * ## 为什么单独成文件
 *
 * 这一段回答"这一轮用哪个账号". 它与"怎么拿它的串行化锁"(./chat-lock.ts),
 * "发什么"(./turn.ts), "失败后怎么办"(./loop.ts)无共享可变状态, 只读写 st
 * (每请求一份). 账号切换时的两条清扫规则必须在上游调用之前完成, 否则上一账号
 * 的 agent 覆盖会泄漏到新账号:
 *   1. 交还上一账号的槽位预留(它已不在本次请求的候选中);
 *   2. 换到不同账号时重置 sameAccountRetries 并清空 agentOverride.
 *
 * ## 每请求独立语义
 *
 * 本模块不持有任何模块级可变绑定; 所有状态读写都发生在传入的 st 上
 * (见 ./state.ts 的文件头).
 *
 * 口径: 纯搬移, 行为零改动.
 */
import { logger, patchLogContext } from '../../../util/log.ts'
import { waitForChatLock } from '../acquire/chat-lock.ts'

/**
 * 选号并接管本轮 runtime, 然后等它的 chat 锁.
 *
 * @param {any} st 请求级状态(见 ./state.ts)
 * @returns {Promise<boolean>} true = 已拿到锁可继续本轮; false = 已安排下一轮(调用方 continue)
 * @throws {UpstreamError} 选号失败 / 调度预算耗尽 / 客户端断开(由 loop 归类)
 */
export async function acquireTurn(st: any) {
  const { runtimes, upstreamModel, skipKeys, sessionBudget } = st
  // Single reacquire path: first attempt acquires; retries use gate from previous failure.
  const rt: any =
    st.attempt === 1
      ? await runtimes.acquireForModel(upstreamModel, {
          sessionBudget,
          skipKeys,
        })
      : await runtimes.reacquireAfterGate(upstreamModel, {
          preferredKey: st.lastKey,
          gateCode: st.pendingGateCode,
          retryAfterMs: st.pendingRetryAfterMs,
          switchAccount: st.pendingSwitchAccount,
          noCooldown: st.pendingNoCooldown,
          sessionBudget,
          skipKeys,
        })
  st.pendingGateCode = null
  st.pendingRetryAfterMs = null
  st.pendingSwitchAccount = false
  st.pendingNoCooldown = false
  // 本轮选号占用的槽位预留:换号时必须先交还上一个账号的预留
  // (它已经不在本次请求的候选里了),再接管新账号的预留.
  if (st.releaseReserved) {
    st.releaseReserved()
    st.releaseReserved = null
  }
  st.releaseReserved =
    typeof rt.releaseReservedSlot === 'function'
      ? rt.releaseReservedSlot
      : null
  if (st.lastKey && rt.key !== st.lastKey) {
    // 已经换到不同账号 → 重置同账号重试计数,并释放上一账号的串行化锁
    st.sameAccountRetries = 0
    st.dropChatHold()
    // agentOverride 是针对上一账号的 agent 覆盖(free_mode_invalid_agent_model
    // 等按该账号+agent 组合判定).换到新账号后必须清空,让新账号从它自己的
    // 主 agent 重新尝试----否则上一账号被拒的 agent 覆盖会泄漏到新账号上,
    // 使新账号跳过主 agent,直接用孪生/兜底(偏离其应有主 agent).
    if (st.agentOverride !== null) {
      logger.warn('reset agent override on account switch', {
        fromKey: st.lastKey,
        toKey: rt.key,
        model: upstreamModel,
        wasAgentOverride: st.agentOverride,
      })
      st.agentOverride = null
    }
  }
  st.lastKey = rt.key
  // 账号选定 → 补进日志上下文:其后这条请求的所有日志都能对上"哪个账号".
  // 多账号池并发时没有它,日志就是一堆无主记录交织,排障只能靠猜.
  patchLogContext({ account: rt.email || rt.key, model: upstreamModel })
  logger.info('account selected', {
    key: rt.key,
    email: rt.email,
    model: upstreamModel,
    wasAgentOverride: !!st.agentOverride,
  })
  return waitForChatLock(st, rt)
}
