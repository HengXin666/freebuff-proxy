import { UpstreamError } from '../../../upstream/client.ts'
import { logger } from '../../../util/log.ts'

/**
 * 一轮的账号锁获取(有界等待).
 *
 * 账号锁是[首字节之前]最长的一段静默等待(热 75s / 冷 120s), 因此有三道处置:
 * 等待有界; 满员排队超时把该账号拉进 skipKeys; 等待期间 runtime 被顶替则不用旧 session.
 *
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} rt 本轮选中的 runtime
 * @returns {Promise<boolean>} true = 已拿到锁; false = 已安排下一轮(调用方 continue)
 * @throws {UpstreamError} 调度预算耗尽 / 客户端断开(由 loop 归类)
 */
export async function waitForChatLock(st: any, rt: any) {
  const { runtimes, skipKeys } = st
  // 账号并发上限:同一账号同时在途流数不超过上限(热会话优先复用,
  // 选号阶段已把满员账号排后;只有所有账号都满员时才排队复用,
  // 超时兜底换号).任何一次获取都必须有界:兜底阶段虽然预算已
  // 耗尽(不会再换号),但若持锁者因网络波动卡死(幽灵连接),无限
  // 等待会让本请求永久挂起,所有后续请求排队超时----必须像前面的
  // acquire 一样设上界,超时把 account_busy 返回给客户端(可重试),
  // 绝不无限等待.
  if (!st.rt) {
    // 已在上一轮完整等待过账号锁(account_busy) -> 本轮只给短窗:
    // 排队只等一次完整 idle 周期, 之后换下一个账号, 不在满员账号上反复长等.
    // 上限夹到剩余调度预算: 账号锁是本阶段最长的一段(热 75s / 冷 120s).
    const budgetLeft = st.schedulingDeadline - Date.now()
    if (budgetLeft <= 0) {
      throw new UpstreamError(
        'scheduling budget exhausted before a chat slot was free',
        { status: 429, code: 'scheduling_timeout' },
      )
    }
    const waitMs = Math.max(
      1,
      Math.min(
        st.chatWaited ? Math.min(st.chatWaitMs(rt), 5_000) : st.chatWaitMs(rt),
        budgetLeft,
      ),
    )
    try {
      st.releaseChat = await st.chatGone.race(
        runtimes.acquireChat(rt.key, waitMs),
      )
    } catch (lockErr: any) {
      if (lockErr?.code === 'client_gone') throw lockErr
      if (lockErr?.code === 'account_busy' && st.attempt < st.maxAttempts) {
        logger.warn('account busy; trying next account', {
          key: rt.key,
          email: rt.email,
          model: st.upstreamModel,
          attempt: st.attempt,
          waitedMs: waitMs,
        })
        st.chatWaited = true
        // 满员排队超时: 把该账号从本次请求的候选中排除, 下一轮换到别的账号.
        skipKeys.add(rt.key)
        st.pendingGateCode = 'account_busy'
        st.pendingSwitchAccount = true
        st.pendingNoCooldown = true
        return false
      }
      await finalBoundedWait(st, rt)
    }
    if (await rejectSupersededRuntime(st, rt)) return false
    st.rt = rt
    // 在途标记:锁内唯一请求;轮询 GET 会跳过该账号,避免干扰活跃会话.
    st.rt.sessions.beginRequest()
    // 已经拿到真实槽位 ---- 预留完成使命,立刻交还(此后由
    // chatLock.inFlight 承担"这个账号有多满"的事实来源).
    if (st.releaseReserved) {
      st.releaseReserved()
      st.releaseReserved = null
    }
  }
  return true
}

/**
 * 兜底阶段的有界等待(已无重试机会时也必须设上界).
 *
 * 兜底阶段预算已耗尽(不会再换号), 但若持锁者因网络波动卡死(幽灵连接), 无限
 * 等待会让本请求永久挂起, 所有后续请求排队超时 ---- 必须像前面的 acquire 一样
 * 设上界, 超时把 account_busy 返回给客户端(可重试).
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} rt 本轮选中的 runtime
 * @returns {Promise<void>} 无返回
 */
async function finalBoundedWait(st: any, rt: any) {
  const finalWaitMs = Math.max(
    1,
    Math.min(st.chatWaitMs(rt), st.schedulingDeadline - Date.now()),
  )
  logger.warn('account busy; final bounded wait for chat slot', {
    key: rt.key,
    email: rt.email,
    model: st.upstreamModel,
    attempt: st.attempt,
    waitMs: finalWaitMs,
  })
  st.releaseChat = await st.chatGone.race(
    st.runtimes.acquireChat(rt.key, finalWaitMs),
  )
}

/**
 * 切换竞态守卫:等待 chat 锁期间 runtime 被顶替(代理/账号切换)时放弃本轮.
 *
 * 此时不能继续用旧 runtime ---- 它的 session 可能马上被 DELETE, 硬用会让请求
 * 撞上已失效会话而卡死. 释放锁, 无冷却重新选号(新 runtime 走新出口, 新 session).
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} rt 本轮选中的 runtime
 * @returns {Promise<boolean>} true = 已被顶替(调用方 return false); false = 仍可继续
 */
async function rejectSupersededRuntime(st: any, rt: any) {
  if (st.runtimes.isCurrentRuntime(rt)) return false
  logger.warn(
    'runtime superseded while waiting for chat slot; re-selecting',
    {
      key: rt.key,
      email: rt.email,
      model: st.upstreamModel,
      attempt: st.attempt,
    },
  )
  st.releaseChat()
  st.releaseChat = null
  st.pendingGateCode = 'runtime_superseded'
  st.pendingSwitchAccount = true
  st.pendingNoCooldown = true
  return true
}
