/**
 * 一次上游调用(run)的准备与执行.
 *
 * 回答"拿到账号锁之后, 判定失败之前, 这一轮往上发什么": 会话快照校验, agent 选择与
 * 回退, 请求体构造, 转发, FINISH 上报. 读 st 上的本轮状态
 * (rt / runId / clientId / agentOverride); 重试分支在 ./errors.ts.
 *
 * 每请求独立语义: 全部可变状态都在 st(每请求一份, 见 ../state/state.ts);
 * agentOverride / runId / clientId 都写回 st, 换号时由 ../acquire/acquire.ts 清空.
 * 本模块不持有任何模块级可变绑定.
 */
import { UpstreamError } from '../../../upstream/client.ts'
import { chooseHermesDelegateAlias } from '../../../tool-alias.ts'
import { buildForwardBody } from '../../transport/forward-body.ts'
import { forwardCompletions } from '../../transport/forward.ts'
import { startAgentRunWithFallback } from './agent-run.ts'

/**
 * 准备并执行一次上游调用.
 *
 * 读 st.rt(当前持锁账号)与 st.agentOverride, 写回 st.runId / st.clientId /
 * st.agentOverride / st.sessionModel.
 * @param {any} st 请求级状态(见 ../state/state.ts)
 * @param {any} res 下游响应
 * @returns {Promise<any>} forwardCompletions 的结果(ok / wrote / gateCode ...)
 */
export async function runUpstreamTurn(st: any, res: any) {
  const { ctx, rt } = st
  // 可观测性:响应头标明本次实际使用的账号.
  res.setHeader('x-freebuff-proxy-account', rt.email)
  res.setHeader('x-freebuff-proxy-account-id', rt.key)

  const snap = rt.sessions.getSnapshot()
  if (!snap.live || !snap.instanceId) {
    throw new UpstreamError(
      'No live freebuff session after admit.',
      { status: 503, code: 'no_session' },
    )
  }
  st.sessionModel = snap.model

  const agentId = await startAgentRunWithFallback(st)
  const hermesDelegateAlias = chooseHermesDelegateAlias(st.body.tools)
  const forwardBody = buildTurnBody(st, agentId, snap, hermesDelegateAlias)
  const result = await forwardCompletions(ctx, {
    req: st.req,
    res,
    forwardBody,
    stream: st.stream,
    hermesDelegateAlias,
    upstream: rt.upstream,
    // 会话剩余时间:用于把流 idle 超时收敛到会话过期附近,过期即掐断.
    sessionRemainingMs: snap.remainingMs,
    // chat 必须带会话实例 id(见 forwardCompletions)
    instanceId: snap.instanceId,
    schedulingDeadline: st.schedulingDeadline,
    upstreamModel: st.upstreamModel,
  })

  // Best-effort close the run registry row
  if (st.runId) {
    void rt.upstream.finishAgentRun({
      runId: st.runId,
      status: result.ok ? 'completed' : 'failed',
      errorMessage: result.ok ? undefined : errorMessageOf(result),
    })
  }
  return result
}

/**
 * 取 FINISH 上报要用的失败码.
 *
 * 结果对象的形状是三选一(成功 / 管道失败 / 分类失败), 只有后面两种带 gateCode;
 * 用 Reflect 读取以保留联合类型检查.
 * @param {any} result forwardCompletions 的结果
 * @returns {string} 失败码(取不到时退回 completions_failed)
 */
function errorMessageOf(result: any) {
  return String(Reflect.get(result, 'gateCode') || 'completions_failed')
}

/**
 * 构造发往上游的 chat 请求体.
 *
 * 三个服务端指派值都必须逐字用会话回执里的真值, 不符合会被上游按不匹配拒绝:
 *   snap.model   服务端指派的 model(用错得到 session_model_mismatch)
 *   runId        本 run 的身份(FINISH 上报与 RPC 回落都要用)
 *   clientId     绑定 run 生命周期, 同一 run 的多次 chat 复用它
 * @param {any} st 请求级状态
 * @param {any} agentId 本轮实际使用的 agent
 * @param {any} snap 会话快照
 * @param {string | null} hermesDelegateAlias 本轮的 delegate_task 别名
 * @returns {any} 转发体
 */
function buildTurnBody(st: any, agentId: any, snap: any, hermesDelegateAlias: any) {
  const { ctx, rt, body, upstreamModel } = st
  return buildForwardBody(ctx,
    body,
    upstreamModel,
    snap.instanceId,
    st.runId,
    agentId,
    st.clientId,
    hermesDelegateAlias,
    // 服务端指派的 model(会话回执里的 m-xxx / fbm1.xxx).
    // 用错会得到 session_model_mismatch.
    snap.model,
    // 目录持有者:把 m-xxx(目录 key)翻成 fbm1.xxx(句柄)----
    // 官方 chat 的 model 用的是句柄.
    rt.upstream.catalog,
  )
}
