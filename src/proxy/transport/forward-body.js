/**
 * 构造发往上游的 chat 请求体 -- 从 src/proxy.js 搬出.
 *
 * 它是一个纯函数式的组装器: 输入客户端体与一批上下文值, 输出上游形态的 body.
 * 搬出来的原因是它 171 行, 而 createProxyHandler 那 2000 行闭包读起来时
 * "客户端体怎么变成上游体"这段总是要单独跳出去看.
 *
 * 口径: 纯搬移, 行为零改动.
 */

import { generateClientId, newIds } from '../../util/http.js'
import { randomUUID } from 'node:crypto'
import { resolveUpstreamChannel } from '../../config.js'
import { clientEnvironment, META_CLIENT_ENV, isCliClaim } from '../../upstream/official-fingerprint.js'
import { ENFORCED_FOREIGN_SIGNALS, detectForeignClient } from '../../upstream/foreign-client-signals.js'
import { withChatMetadataParity as chatMetadataParity } from '../../upstream/chat-metadata-parity.js'
import {
  ensureFreebuffSystemMessages,
  ensureFreebuffToolSignature,
  normalizeReasoningFields,
  normalizeOutputBudget,
  stripFreebuffConversationState,
} from '../../free-mode.js'
import { rewriteHermesDelegateForUpstream } from '../../tool-alias.js'
import { logger } from '../../util/log.js'

/** 一键屏蔽收费模型开关(前端[模型管理],实时生效). */
function blockPremiumModels(ctx) {
  return ctx.settingsStore?.get()?.blockPremiumModels === true
}

export function buildForwardBody(
  ctx,
  clientBody,
  upstreamModel,
  instanceId,
  runId,
  agentId,
  clientId,
  hermesDelegateAlias,
  /**
   - 服务端在会话回执里给出的 model 值.必须用它,不能用自己的模型名.
   *
   - 真机证据:官方 GET 建会话的回执是 "model":"m-00032eaeec"(目录 key),
   - 或 "model":"fbm1.AAEAAUPe2Us..."(句柄)---- 都是服务端指派的,
   - 与客户端请求的模型名无关.实测用 deepseek/deepseek-v4-flash 去 chat
   - 会得到 session_model_mismatch(会话绑定的模型与请求的不符).
   - 见 .agents/notes/implemented/bug-fix/2026-10-01-session-model-binding.md
   */
  sessionModel,
  catalog,
  /** 'worker' | 'manager':官方形态的层(默认 worker). */
  layerHint = 'worker',
  /** repo_snapshot 的 JSON 字符串(worker 层用真实项目统计). */
  repositorySnapshot = null,
) {
  const { clientId: fallbackClientId } = newIds()
  const effectiveClientId = clientId || fallbackClientId
  // 优先级:服务端指派的 model(m-xxx)> 请求的模型名;
  // 再经目录翻成句柄(fbm1.xxx)---- 官方 chat 的 model 就是句柄.
  // 真机证据:{"model":"fbm1.AAEAAUPe2Us...","codebuff_metadata":{...}}
  const assigned =
    typeof sessionModel === 'string' && sessionModel ? sessionModel : upstreamModel
  const outgoingModel =
    catalog && typeof catalog.handleFor === 'function'
      ? catalog.handleFor(assigned)
      : assigned
  logger.info('chat forward model resolved', {
    requested: upstreamModel,
    sessionModel: sessionModel ?? null,
    assigned,
    outgoing: outgoingModel,
  })
  let body = stripFreebuffConversationState({
    ...clientBody,
    model: outgoingModel,
  })
  // Hermes 的 delegate_task 命中上游 foreign_tool_names.只在客户端实际声明
  // 该工具时做窄范围双向别名;历史 tool_calls/tool message/tool_choice 同步改名,
  // 回程再恢复原名,避免破坏 Hermes 的硬编码派发.见 issue #17 与:
  // .agents/notes/implemented/bug-fix/2026-09-19-hermes-delegate-task-alias.md
  body = rewriteHermesDelegateForUpstream(body, hermesDelegateAlias)
  // One reasoning field only -- avoids Freebuff default + client dual fields.
  body = normalizeReasoningFields(body)
  // 输出预算治理:客户端偏小的 max_tokens/max_completion_tokens 会把思考链
  // (reasoning token 计入该预算)提前掐断(finish_reason=length)----参考
  // freebuff2api-wokers#8[DS4 思考链稍长即截断].转发上游前抬到 floor.
  body = normalizeOutputBudget(body)
  //  分通道(可在控制台[设置]切换,见 ctx.settingsStore.upstreamChannel):
  //   official ---- 用官方抓包原文(官方 system 模板 + 官方 37 工具).
  //   legacy(默认)---- 旧的自拼形态(CLI 开场白 + 自编签名工具).
  //
  // 旧形态来源是早期第三方项目 + 多年补丁,已无法与官方逐字段核对;
  // 与抓包对比后发现三处硬差异(system 全文,工具集,agent 世代),
  // 是身份/世代错配的根源.见 docs/reverse/17-current-status-and-gaps.md.
  //
  // 优先级:ctx.settingsStore(前端可调)> ctx.config.upstream.channel(兜底).
  const channel = resolveUpstreamChannel(
    ctx.settingsStore?.get?.(),
    ctx.config,
    (m, f) => logger.warn(m, f),
  )
  //  official 通道不在这里构造:官方形态的实现只有一份,在 cli-bridge.
  // 本函数只产出 legacy 形态;official 会在发送阶段把整条请求委托给副仓库
  // (见 forwardCompletions 里的 rpcChat 分支),避免两份实现漂移.
  // 见 docs/reverse/17-current-status-and-gaps.md
  if (channel !== 'official') {
    // Free mode requires a system message opening with the Freebuff CLI marker
    // ("You are Buffy, the strategic coding assistant."). base3-free-* agent
    // 用 base3 规范开场(对齐 trefeon PR #207).
    body.messages = ensureFreebuffSystemMessages(body.messages, agentId)
  }
  // 补齐官方真签名工具(名字 + 真实参数 schema),否则上游把请求判成
  // 第三方客户端并降级到 inclusionai/ling-3.0-tiny:free ---- 其 slug 不可路由时
  // 以 404 失败,下游桥接层再崩成 502 空体,即 issue#15[所有模型空响应].
  // 判据与实测见
  // .agents/notes/implemented/bug-fix/2026-09-19-genuine-tool-signature.md
  //  必须 ?.get()?.:只写 ?.get(). 时,ctx.settingsStore 存在而 get() 返回
  // undefined(store 尚未就绪/读盘降级)会抛 TypeError,直接打断带工具的
  // 转发链路 ---- 与同文件 blockPremiumModels(ctx) 的写法保持一致.
  const freeToolSignatureEnabled =
    ctx.settingsStore?.get?.()?.freeToolSignatureEnabled !== false
  if (channel !== 'official') {
    body.tools = ensureFreebuffToolSignature(
      body.tools,
      freeToolSignatureEnabled,
    )
  }
  // 可观测性:把[上游会怎么看这个工具集]算出来记进日志.判定权永远在上游,
  // 本地算这份只为让[正在被降级]在出问题时能被看见(上游不回明确错误,
  // 症状只是回答变差或 404/502,不主动暴露原因).
  //
  // isRootAgent 恒为 true:本代理转发的一律是 root agent(base2-free* /
  // base3-free-*,见 model.agentIdForModel),而该参数只影响[无工具]时的
  // 只报不罚信号分类,不影响任何降级判定.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const verdict = detectForeignClient(body, true)
    if (verdict.signal && ENFORCED_FOREIGN_SIGNALS.includes(verdict.signal)) {
      logger.warn('upstream may treat request as a foreign client', {
        signal: verdict.signal,
        model: upstreamModel,
        toolCount: verdict.toolCount,
        sampleToolNames: verdict.sampleToolNames,
        foreignToolNames: verdict.foreignToolNames,
        hollowToolNames: verdict.hollowToolNames,
      })
    }
  }

  const existingMeta =
    body.codebuff_metadata && typeof body.codebuff_metadata === 'object'
      ? { ...body.codebuff_metadata }
      : {}
  // run_id MUST be server-issued via POST /api/v1/agent-runs (START).
  // client_id:SDK 形 13 位 base36(对齐官方 CLI),每 run 一次,绝不用
  // 自有前缀----上游 cf-worker-signals.ts 的 looksLikeProxyClientId 会指纹
  // 代理形态 client id(详见 util/http.js generateClientId).
  body.codebuff_metadata = {
    ...existingMeta,
    run_id: runId,
    client_id: effectiveClientId,
    cost_mode: 'free',
    freebuff_instance_id: instanceId,
    // 客户端环境描述符:官方把它放进 codebuff_metadata(与 x-freebuff-env
    // 头同一份字符串).缺失 = 请求形态不像官方 CLI ---- 上游会据此判定
    // 第三方客户端.常量与格式见 src/upstream/official-fingerprint.js.
    [META_CLIENT_ENV]: clientEnvironment(),
    // 官方在 CLI claim(cli: 前缀)时额外声明这两项:
    //   cli/src/utils/freebuff-session-identity.ts freebuffSessionMetadata()
    //     { freebuff_instance_id, freebuff_multi_session: '1', surface: 'cli' }
    // surface: 'cli' 就是服务端用来区分 native CLI 与 Desktop 标签的字段.
    ...(isCliClaim(instanceId)
      ? { freebuff_multi_session: '1', surface: 'cli' }
      : {}),
    ...(existingMeta.trace_session_id
      ? {}
      : { trace_session_id: randomUUID() }),
    // 官方 chat metadata 的另三个字段(真机抓包确认存在):
    //   freebuff_input_profile / repo_snapshot / llm_step_number
    // 我们此前一个都没有.格式逐字对齐官方(见 chat-metadata-parity.js).
    ...chatMetadataParity(
      {
        messages: body.messages,
        stepNumber: 1,
      },
    ),
  }
  // provider.data_collection=deny:官方 CLI 每次 chat 都带(拒绝数据采集),
  // 缺失反而与官方客户端不一致.客户端自带 provider 时保留其字段,补上 deny.
  body.provider = {
    ...(body.provider && typeof body.provider === 'object'
      ? body.provider
      : {}),
    data_collection: 'deny',
  }
  // CLI 全局停止序列:JSON 编码带引号的哨兵 "cb_easp"(agent-runtime
  // globalStopSequence = JSON.stringify(endsAgentStepParam)),客户端没给
  // stop 时补上,与官方 CLI 一致.
  if (!body.stop) {
    body.stop = [`"cb_easp"`]
  }
  return body
}
