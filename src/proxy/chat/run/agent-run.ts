/**
 * startAgentRun 与 agent 回退 ---- 从 src/proxy.ts 的 handleChatCompletionsInner 提出.
 *
 * ## 为什么单独成文件
 *
 * "用哪个 agent"有两层证据(目录 key 用 base3-free-catalog, otherwise 按 legacy
 * 规则推导), 且主 agent 被拒时要回退同代孪生. 这套判据与"发什么 body"无关,
 * 单独成文件后可以逐条对照真机抓包与二进制证据读.
 *
 * ## 每请求独立语义
 *
 * agentOverride 写回 st(每请求一份): 它必须随请求生灭, 且换号时被 ./acquire.ts
 * 清空 ---- 上一账号被拒的 agent 覆盖泄漏到新账号会让新账号跳过主 agent.
 * 本模块不持有任何模块级可变绑定.
 *
 * 口径: 纯搬移, 行为零改动.
 */
import { agentFallbackForModel, agentIdForModel, CATALOG_UNIFIED_AGENT_ID } from '../../../model.ts'
import { UpstreamError } from '../../../upstream/client.ts'
import { logger } from '../../../util/log.ts'
import { newIds } from '../../../util/http.ts'
import { resolveUpstreamChannel } from '../../../config.ts'
import { customModels } from '../../routes/catalog.ts'

/**
 * 发 startAgentRun, 主 agent 被拒时回退同代孪生.
 *
 * 写回 st.runId / st.clientId / st.agentOverride.
 * @param {any} st 请求级状态(见 ./state.ts)
 * @returns {Promise<any>} 本轮实际使用的 agentId
 */
export async function startAgentRunWithFallback(st: any) {
  const { ctx, rt, config, settingsStore, upstreamModel } = st
  const snapModel = st.sessionModel
  //  目录协议下的 agent 选择(真机抓包 + 二进制双重证据):
  //
  // 官方 chat 走目录协议时,agent-run 用的是统一的
  // base3-free-catalog,而不是 base2-free-<model>.
  // 二进制原文:
  //   UK = "base3-free-catalog"
  //   Ps$(H){ return WD().row(H)?.key === H ? UK : cCH(H) }
  // 即:当会话模型是目录 key(m-xxx)时 → 用 catalog agent;
  // 否则才按 legacy 规则推导 base2/base3.
  //
  // 抓包实测:官方 START agentId=base3-free-catalog(目录模式下唯一值).
  // 我们此前发 base2-free-deepseek-flash ---- 与官方不一致.
  // 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-agent.md
  const isCatalogMode =
    typeof snapModel === 'string' &&
    (snapModel.startsWith('m-') || snapModel.startsWith('fbm1.'))
  //  official 通道:跳过本段 startAgentRun.
  // agent 世代是官方形态的一部分,实现只在副仓库;这里自己发一次
  // 会用 legacy 世代,与副仓库后续 chat 的世代打架.
  // 副仓库的 reuse 会自己做 startRun(desktop 世代)+ chat.
  // 见 docs/reverse/17-current-status-and-gaps.md
  // legacy 已废弃(见 config.resolveUpstreamChannel):一律 official
  resolveUpstreamChannel(
    settingsStore?.get?.(),
    config,
    (m, f) => logger.warn(m, f),
  )
  const agentId: any =
    st.agentOverride ||
    (isCatalogMode
      ? CATALOG_UNIFIED_AGENT_ID
      : agentIdForModel(upstreamModel, customModels(ctx)))
  // official 通道仍然发 startAgentRun:
  //   - 保证 runId 始终有值(FINISH 上报,以及 RPC 失败回落 legacy
  //     时都要用);
  //   - 不影响 chat 世代 ---- official 下 chat 由副仓库执行,
  //     它自己会用 desktop 世代再 startRun 一次.
  // 见 docs/reverse/17-current-status-and-gaps.md
  try {
    st.runId = await rt.upstream.startAgentRun({ agentId })
    st.clientId = newIds().clientId
  } catch (agentErr) {
    if (isFallbackEligible(agentErr)) {
      // 目录模式下主 agent 是 base3-free-catalog;兜底必须同代,
      // 否则回退成 base2-free 会跨世代(系统消息开场白按 base3 写,
      // agent 却是 base2 → 上游按世代校验必然拒绝).
      // 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-agent.md
      const fbAgentId = isCatalogMode
        ? CATALOG_UNIFIED_AGENT_ID
        : agentFallbackForModel(upstreamModel, customModels(ctx))
      if (fbAgentId !== agentId) {
        logger.warn('primary agent rejected; falling back', {
          agentId,
          fbAgentId,
          model: upstreamModel,
          key: rt.key,
        })
        st.agentOverride = fbAgentId
        st.runId = await rt.upstream.startAgentRun({ agentId: fbAgentId })
        st.clientId = newIds().clientId
      } else {
        throw agentErr
      }
    } else {
      throw agentErr
    }
  }
  logger.info('started agent run', {
    runId: st.runId,
    agentId,
    model: upstreamModel,
    key: rt.key,
    email: rt.email,
  })
  return agentId
}

/**
 * 该错误是否够格触发"回退同代孪生 agent".
 *
 * 只有 403 + 两个特定码(start_agent_run_failed / free_mode_invalid_agent_model)
 * 才说明"这个 agent 被拒但换一个同代 agent 可能行"; 其余一律原样抛出, 不做猜测.
 * @param {any} agentErr startAgentRun 抛出的错误
 * @returns {boolean} true = 可回退
 */
function isFallbackEligible(agentErr: any) {
  return (
    agentErr instanceof UpstreamError &&
    (agentErr.code === 'start_agent_run_failed' ||
      agentErr.code === 'free_mode_invalid_agent_model') &&
    agentErr.status === 403
  )
}
