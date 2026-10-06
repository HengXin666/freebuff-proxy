/**
 * 构造发往上游的 chat 请求体.
 *
 * 纯函数式组装器: 输入客户端体与一批上下文值, 输出上游形态的 body.
 */

import { generateClientId, newIds } from '../../util/http.ts'
import { randomUUID } from 'node:crypto'
import { resolveUpstreamChannel } from '../../config.ts'
import { clientEnvironment, META_CLIENT_ENV, isCliClaim } from '../../upstream/fingerprint/official-fingerprint.ts'
import { ENFORCED_FOREIGN_SIGNALS, detectForeignClient } from '../../upstream/foreign-client-signals.ts'
import { withChatMetadataParity as chatMetadataParity } from '../../upstream/metadata/chat-metadata-parity.ts'
import {
  ensureFreebuffSystemMessages,
  ensureFreebuffToolSignature,
  normalizeReasoningFields,
  normalizeOutputBudget,
  stripFreebuffConversationState,
} from '../../free-mode.ts'
import { HERMES_DELEGATE_TOOL_NAME, rewriteHermesDelegateForUpstream } from '../../tool-alias.ts'
import { EMPTY_CARRIER_PLAN, alignToolNamesForUpstream, packClientTools } from './tool-carrier.ts'
import { resolveWireModel } from '../../upstream/catalog/freshness.ts'
import { logger } from '../../util/log.ts'

/** 一键屏蔽收费模型开关(前端[模型管理],实时生效). */
function blockPremiumModels(ctx: any) {
  return ctx.settingsStore?.get()?.blockPremiumModels === true
}

/**
 * 可观测性:把[上游会怎么看这个工具集]记一行.
 *
 * 判定权在上游, 本地算这份只为让[正在被降级]在出问题时能被看见
 * (上游不回明确错误, 症状只是回答变差或 404/502).
 *
 * isRootAgent 恒为 true: 本代理转发的一律是 root agent (见 model.agentIdForModel),
 * 该参数只影响无工具时的只报不罚信号分类, 不影响任何降级判定.
 *
 * @param {any} body 出站请求体(含 tools)
 * @param {any} upstreamModel 上游模型名(仅入日志)
 * @returns {void} 无返回值
 */
function logForeignClientVerdict(body: any, upstreamModel: any) {
  const verdict = detectForeignClient(body, true)
  if (!verdict.signal || !ENFORCED_FOREIGN_SIGNALS.includes(verdict.signal)) return
  logger.warn('upstream may treat request as a foreign client', {
    signal: verdict.signal,
    model: upstreamModel,
    toolCount: verdict.toolCount,
    sampleToolNames: verdict.sampleToolNames,
    foreignToolNames: verdict.foreignToolNames,
    hollowToolNames: verdict.hollowToolNames,
  })
}

/**
 * 装配上游 chat metadata 与 provider / stop 两个顶层字段(原地写 body).
 *
 * run_id 必须由服务端经 POST /api/v1/agent-runs (START) 下发.
 * client_id 是 SDK 形 13 位 base36(对齐官方 CLI), 每 run 一次, 绝不用自有
 * 前缀 ---- 上游 cf-worker-signals.ts 的 looksLikeProxyClientId 会指纹代理形态
 * client id (见 util/http.ts generateClientId).
 *
 * @param {any} body 出站请求体(原地修改)
 * @param {{ runId: any, clientId: any, instanceId: any }} ids 三个服务端指派值
 * @returns {any} 同一个 body
 */
function applyOutboundMetadata(body: any, ids: any) {
  const existingMeta =
    body.codebuff_metadata && typeof body.codebuff_metadata === 'object'
      ? { ...body.codebuff_metadata }
      : {}
  body.codebuff_metadata = {
    ...existingMeta,
    run_id: ids.runId,
    client_id: ids.clientId,
    cost_mode: 'free',
    freebuff_instance_id: ids.instanceId,
    // 客户端环境描述符:官方把它放进 codebuff_metadata(与 x-freebuff-env 头
    // 同一份字符串).缺失 = 请求形态不像官方 CLI, 上游会据此判定第三方客户端.
    [META_CLIENT_ENV]: clientEnvironment(),
    // 官方在 CLI claim(cli: 前缀)时额外声明这两项. surface: 'cli' 就是服务端
    // 用来区分 native CLI 与 Desktop 标签的字段.
    ...(isCliClaim(ids.instanceId)
      ? { freebuff_multi_session: '1', surface: 'cli' }
      : {}),
    ...(existingMeta.trace_session_id ? {} : { trace_session_id: randomUUID() }),
    // 官方 chat metadata 的另三个字段(抓包确认存在):
    // freebuff_input_profile / repo_snapshot / llm_step_number.
    // 格式逐字对齐官方(见 chat-metadata-parity.ts).
    ...chatMetadataParity({ messages: body.messages, stepNumber: 1 }),
  }
  // provider.data_collection=deny: 官方 CLI 每次 chat 都带(拒绝数据采集),
  // 缺失反而与官方客户端不一致.客户端自带 provider 时保留其字段, 补上 deny.
  body.provider = {
    ...(body.provider && typeof body.provider === 'object' ? body.provider : {}),
    data_collection: 'deny',
  }
  // CLI 全局停止序列:JSON 编码带引号的哨兵 "cb_easp"
  // (agent-runtime globalStopSequence = JSON.stringify(endsAgentStepParam)).
  if (!body.stop) body.stop = [`"cb_easp"`]
  return body
}

export function buildForwardBody(
  ctx: any,
  clientBody: any,
  upstreamModel: any,
  instanceId: any,
  runId: any,
  agentId: any,
  clientId: any,
  hermesDelegateAlias: any,
  /**
   - 服务端在会话回执里给出的 model 值.必须用它,不能用自己的模型名.
   *
   - 真机证据:官方 GET 建会话的回执是 "model":"m-00032eaeec"(目录 key),
   - 或 "model":"fbm1.AAEAAUPe2Us..."(句柄)---- 都是服务端指派的,
   - 与客户端请求的模型名无关.实测用 deepseek/deepseek-v4-flash 去 chat
   - 会得到 session_model_mismatch(会话绑定的模型与请求的不符).
   - 见 .agents/notes/implemented/bug-fix/2026-10-01-session-model-binding.md
   */
  sessionModel: any,
  catalog: any,
  /** 'worker' | 'manager':官方形态的层(默认 worker). */
  layerHint = 'worker',
  /** repo_snapshot 的 JSON 字符串(worker 层用真实项目统计). */
  repositorySnapshot = null,
  /**
   - 第三方工具承载开关(前端[工具承载], 实时生效).
   - 关掉时下游私有工具按旧行为原样发出(上游多半回 503), 用于对照排障.
   */
  toolCarrierEnabled = true,
) {
  const { clientId: fallbackClientId } = newIds()
  const effectiveClientId = clientId || fallbackClientId
  // 优先级:服务端指派的 model(m-xxx)> 请求的模型名;
  // 再经目录翻成句柄(fbm1.xxx)---- 官方 chat 的 model 就是句柄.
  // 真机证据:{"model":"fbm1.AAEAAUPe2Us...","codebuff_metadata":{...}}
  const assigned =
    typeof sessionModel === 'string' && sessionModel ? sessionModel : upstreamModel
  /**
   * 句柄只能在本目录这一代里用.
   *
   * 服务端每次抓取全量轮换 handle(见 catalog/freshness.ts 的文件头): 会话回执里
   * 指派的要是上一代签发的句柄, 本目录查无此行, 再把它当 chat 的 model 发出去
   * 只会得到上游的拒绝. 此时退回稳定身份(请求侧的目录 key / 可读名), 让对面的
   * 重抓能把同一行定位回来.
   */
  const outgoing = resolveWireModel(catalog, assigned, upstreamModel, { prefer: 'handle' })
  logger.info('chat forward model resolved', {
    requested: upstreamModel,
    sessionModel: sessionModel ?? null,
    assigned,
    outgoing: outgoing.model,
    resolveReason: outgoing.reason,
    ...(outgoing.staleHandle ? { staleHandle: outgoing.staleHandle } : {}),
  })
  /**
   - 第三方工具承载 (下行打包).
   - 下游工具中[官方集里没有等价物]的那些包成官方 MCP 形态名字, 原名进映射表;
   - 回程由 unpackCarrierToolCalls 按同一张表拆回. 见 ./tool-carrier.ts.
   - Hermes 的 delegate_task 走另一条窄通道(tool-alias 双向别名), 这里让开它,
   - 两条通道不得对同一个名字各改一次.
   *
   - 只在客户端真的声明了工具时才接管 tools 键: 无工具时若写入一个空数组,
   - 上游与本地判据都会把它当成[带了工具] ---- 实测 mock 上游按 Array.isArray(tools)
   - 判 tool-schema 拒, 无工具的请求会凭空变成 404; 且官方无工具时本就不发该键.
   */
  const clientTools = clientBody?.tools
  const hasClientTools = Array.isArray(clientTools) && clientTools.length > 0
  const packed =
    toolCarrierEnabled && hasClientTools
      ? packClientTools(clientTools, (n) => n === HERMES_DELEGATE_TOOL_NAME)
      : null
  const carrierPlan = packed?.plan ?? EMPTY_CARRIER_PLAN
  let body = stripFreebuffConversationState({
    ...clientBody,
    ...(packed ? { tools: packed.tools } : {}),
    model: outgoing.model,
  })
  // 历史消息里的下游工具名同步换成 wire 名, 否则模型看到的历史调用名
  // 不在它拿到的 tools 清单里.
  body.messages = alignToolNamesForUpstream(body.messages, carrierPlan)
  // Hermes 的 delegate_task 命中上游 foreign_tool_names.只在客户端实际声明
  // 该工具时做窄范围双向别名;已有 tool_calls/tool message/tool_choice 同步改名,
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
  // 见 .agents/notes/implemented/feature/2026-10-03-upstream-channel-switch.md
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
  // 补齐官方真签名工具(名字 + 真实参数 schema): 缺它上游会把请求判成
  // 第三方客户端并降级, 其 slug 不可路由时以 404 失败.
  // 判据与对照见
  // .agents/notes/implemented/bug-fix/2026-09-19-genuine-tool-signature.md
  //  必须 ?.get()?.:只写 ?.get(). 时,ctx.settingsStore 存在而 get() 返回
  // undefined(store 尚未就绪/读盘降级)会抛 TypeError,直接打断带工具的
  // 转发链路 ---- 与同文件 blockPremiumModels(ctx) 的写法保持一致.
  // 这个写法的取舍与实测归因见
  // .agents/notes/implemented/bug-fix/2026-10-01-settings-optional-chain.md
  const freeToolSignatureEnabled =
    ctx.settingsStore?.get?.()?.freeToolSignatureEnabled !== false
  if (channel !== 'official') {
    body.tools = ensureFreebuffToolSignature(
      body.tools,
      freeToolSignatureEnabled,
    )
  }
  /**
   * 可观测性:把[上游会怎么看这个工具集]记一行(判定权在上游, 见该函数注释).
   *
   * official 通道下不判: 那一跳的 tools 由副仓库按官方模板重建(本函数的产物只是
   * 过渡形态), 拿它去套判据必然报 foreign_toolset ---- 每个带工具的请求都刷一条
   * 警告, 而实测同一个请求可以同时是 200(2026-10-05, 带 run_code 的工具请求
   * rpc result ok=true 与这条警告并存). 警告只在它能反映真实形态时才有价值.
   */
  if (channel !== 'official' && Array.isArray(body.tools) && body.tools.length > 0) {
    logForeignClientVerdict(body, upstreamModel)
  }

  applyOutboundMetadata(body, {
    runId,
    clientId: effectiveClientId,
    instanceId,
  })
  // 回程拆包要用的映射表一并返回:调用方把它传到 forwardCompletions,
  // 上游回 tool_calls 时按同一张表把载体名还原成下游原名.
  return { body, carrierPlan }
}
