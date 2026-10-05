/**
 * 一轮失败的归类与去向.
 *
 * 判据表: 5 条终态判据(客户端已断开 / 调度预算耗尽 / 会话预算耗尽 / 出口级故障 /
 * 全池额度耗尽) + 2 条重试分支. 终态判据的共同点是"重试只会有同样结果", 因此
 * 立即收场, 不消耗剩余轮次.
 *
 * 每请求独立语义: 全部状态读写都发生在传入的 st 上(每请求一份, 见 ./state.ts);
 * 本模块不持有任何模块级可变绑定.
 */
import { UpstreamError, isSessionRecoverableGate } from '../../../upstream/client.ts'
import { logger } from '../../../util/log.ts'
import { sendJson } from '../../../util/http.ts'
import { shouldSwitchAccountOnError } from '../../transport/errors/errors.ts'

/**
 * 归类一轮里抛出的错误, 决定收场还是安排下一轮.
 *
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} res 下游响应
 * @param {any} err 抛出的错误
 * @returns {Promise<boolean>} true = 请求已收场(调用方 return); false = 已安排重试(调用方 continue)
 */
export async function handleTurnError(st: any, res: any, err: any) {
  const { upstreamModel } = st
  if (err instanceof UpstreamError) {
    // 终态错误:没有可用账号 / 参数缺失,直接返回.
    const isTerminal =
      err.code === 'no_available_account' ||
      err.code === 'model_required' ||
      err.code === 'upstream_auth_missing' ||
      // 客户端已断开:换号只会再买一条 Freebucks 计费会话给一个
      // 没人接收的响应,必须立刻收场(连接已死,写不出去也不报错).
      err.code === 'client_gone' ||
      // 调度预算已耗尽:预算是整个请求一份,后续每轮都会立即再超,
      // 重试只会白烧 maxAttempts 次循环,直接快速失败让客户端重试.
      err.code === 'scheduling_timeout' ||
      // 本次请求的新会话预算已用尽:同样在整个请求内不会恢复
      // (重新选号也拿不到预算),重试只会白转一轮,直接返回可操作的错误码.
      err.code === 'session_budget_exhausted' ||
      // 出口级故障(地理封锁):换号无用(所有账号共享同一出口),
      // 重试只会再买断一次一整小时的 Freebucks.立即收场.
      // 见 .agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md
      err.fatal === true ||
      /**
       - 全池额度耗尽:遍历完所有账号才得出的聚合结论 ----
       - 换号/同号重试不可能有不同结果.立即收场,不白轮 maxAttempts 轮.
       - (实测:每个客户端请求白轮 3 次 × 每次遍历全部账号,
       - 13 个请求就把 500 条日志缓冲冲爆,用户事后查不到更早记录.)
       */
      err.terminalExhausted === true
    if (isTerminal) {
      if (err.code !== 'client_gone') st.mapAndSendError(res, err)
      return true
    }
    if (st.attempt < st.maxAttempts) {
      return !retryAfterUpstreamError(st, err)
    }
    finalizeUpstreamError(st, res, err)
    return true
  }
  // 非 UpstreamError:网络错误 / 上游超时(socket 断开,代理不可达等).
  // 先同号重试一次(热 session 复用,不新建计费会话),再失败才换号;
  // 客户端是否已断开无法可靠区分(req.destroyed 在请求体读完后就为 true),
  // 多试一轮最多浪费一次上游调用.
  if (st.attempt < st.maxAttempts) {
    retryAfterNetworkError(st, err)
    return false
  }
  finalizeNetworkError(st, res, err)
  return true
}

/**
 * 可重试的上游错误的下一轮安排(返回 true = 已安排重试).
 *
 * 两支: session 可恢复 gate(先同号 re-admit 一次, 再失败才换号)与其他上游错误
 * (账号级故障冷却换号, 其余先同号重试 ---- 复用热 session, 不新建计费会话).
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} err 抛出的 UpstreamError
 * @returns {boolean} true = 已安排重试(调用方 continue)
 */
export function retryAfterUpstreamError(st: any, err: any) {
  const upstreamModel = st.upstreamModel
  {
    if (isSessionRecoverableGate(err.code)) {
        logger.warn('recoverable session error; will re-acquire', {
          code: err.code,
          attempt: st.attempt,
          key: st.lastKey,
        })
        // 同号 re-admit 一次;再失败即换号(见下方 sameAccountRetries).
        const willSwitch = st.sameAccountRetries >= 1
        st.sameAccountRetries += 1
        st.pendingGateCode = err.code
        st.pendingSwitchAccount = willSwitch
        st.pendingNoCooldown = false
        if (willSwitch && st.lastKey) {
          st.releaseSessionUnlessPaid(st.lastKey, 'switch account (recoverable error)')
        }
        return true
      }
      // 上游错误(startAgentRun 失败 / no_session / 5xx 等):
      // - 账号级故障(限流/封禁/配额)→ 冷却换号;
      // - 其他(5xx/网络/上游瞬时故障)→ 先在同一账号上重试一次:
      //   复用热 session,不新建计费会话;同号再失败才换号.
      const accountSpecific = shouldSwitchAccountOnError(
        err.status,
        err.code,
      )
      const willSwitch = accountSpecific || st.sameAccountRetries >= 1
      logger.warn(
        willSwitch
          ? 'upstream error; switching account'
          : 'upstream error; retrying same account (no new session)',
        {
          code: err.code,
          status: err.status,
          attempt: st.attempt,
          key: st.lastKey,
          model: upstreamModel,
        },
      )
      st.sameAccountRetries = willSwitch ? 0 : st.sameAccountRetries + 1
      st.pendingGateCode = err.code || `http_${err.status || 502}`
      st.pendingRetryAfterMs = err.retryAfterMs ?? null
      st.pendingSwitchAccount = willSwitch
      st.pendingNoCooldown = false
      if (willSwitch && st.lastKey) {
        st.releaseSessionUnlessPaid(st.lastKey, 'switch account (session error)')
      }
      return true
  }
}

/**
 * 网络类错误的下一轮安排: 先同号重试一次, 再失败才换号.
 *
 * 不区分客户端是否已断开: req.destroyed 在请求体读完后就为 true.
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} err 抛出的错误
 * @returns {void} 无返回
 */
export function retryAfterNetworkError(st: any, err: any) {
  const upstreamModel = st.upstreamModel
  {
    const willSwitch = st.sameAccountRetries >= 1
    logger.warn(
      willSwitch
        ? 'upstream network error; switching account'
        : 'upstream network error; retrying same account (no new session)',
      {
        error: err instanceof Error ? err.message : String(err),
        attempt: st.attempt,
        key: st.lastKey,
        model: upstreamModel,
      },
    )
    st.sameAccountRetries = willSwitch ? 0 : st.sameAccountRetries + 1
    st.pendingGateCode = 'upstream_network_error'
    st.pendingRetryAfterMs = null
    st.pendingSwitchAccount = willSwitch
    st.pendingNoCooldown = false
    if (willSwitch && st.lastKey) {
      st.releaseSessionUnlessPaid(st.lastKey, 'switch account (session error)')
    }
  }
}

/**
 * 无重试机会的上游错误收场: 释放会话(付费时段内拒绝) + 原样映射错误.
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} res 下游响应
 * @param {any} err 抛出的 UpstreamError
 * @returns {void} 无返回
 */
export function finalizeUpstreamError(st: any, res: any, err: any) {
  // 会话不会再被用, 立刻早退 DELETE 释放槽位, 不等空闲释放或自然过期.
  if (st.lastKey) {
    // 统一入口(付费时段内拒绝释放)
    st.releaseSessionUnlessPaid(st.lastKey, 'final upstream error')
  }
  st.mapAndSendError(res, err)
}

/**
 * 网络类错误的收场(重试已耗尽).
 * @param {any} st 请求级状态(见 ./state.ts)
 * @param {any} res 下游响应
 * @param {any} err 抛出的错误
 * @returns {void} 无返回
 */
export function finalizeNetworkError(st: any, res: any, err: any) {
  logger.error('chat completions failed', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  // 网络类错误,重试已耗尽:会话不会再被本次请求使用,立刻 DELETE
  // 释放槽位(失败也会保留句柄重试),别让它挂到过期.
  if (st.lastKey) {
    logger.info('final network error; releasing session to free the slot', {
      key: st.lastKey,
      model: st.upstreamModel,
      error: err instanceof Error ? err.message : String(err),
    })
    st.releaseSessionUnlessPaid(st.lastKey, 'final upstream error')
  }
  if (!res.headersSent) {
    sendJson(res, 500, {
      error: {
        message: err instanceof Error ? err.message : String(err),
        type: 'proxy_error',
      },
    })
  } else {
    res.end()
  }
}
