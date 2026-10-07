/**
 * official 通道的 RPC 委派 -- 从 src/proxy/transport/forward.ts 搬出.
 *
 * forward.ts 原本 452 行(超 300 上限), 其中这 96 行是"把请求交给副仓库"的
 * 独立一段: 判通道是否是 official -> 建 RPC 配置 -> 调 rpcReuse -> 还原工具名
 * -> 失败时返回 null 让调用方走 legacy. 它与前后的重试状态机只通过
 * requestBody 与 upstreamRes 两个值交互, 因此可以整体搬出.
 *
 * 2026-10-05 修复(线上事故 reqId 0f45afc1): 本段曾把 rpcReuse 当"一次性拿整份
 * 响应"用, 而 rpcReuse 内部 await res.text() 要等上游产完整篇回复 ----
 * 于是长回复(实测卡在 44.8s)撞穿主服务 45s 的[首字节之前]调度预算, RPC 被判定
 * 超时并降级 legacy 形态, 上游不认 -> 428 -> 重试 -> 换号 -> 全池买不起 -> 下游 429.
 *
 * 现在两处改动:
 *   1. 流式: 上游字节按行边收边交给下游(见 rpcReuse 的 onLine), 首字节延迟与
 *      纯透传等同. 提交下游响应头之前只等状态行(上游响应头一到就有),
 *      不等正文 ---- 这是"整段缓冲"与"流式"的分界.
 *   2. timeout 语义: 45s 那个预算只约束"上游首字节", 不再约束"整篇生成" ----
 *      整篇上限是独立的一个大值, 长回答不再被调度预算误杀.
 *
 * 流式那一段的实现在 ./official-stream.ts(按体量红线切出).
 */

import { resolveUpstreamChannel } from '../../../config.ts'
import { buildRpcCfg, rpcReuse } from '../../../upstream/rpc/official-rpc.ts'
import { buildUpstreamResponseFromRpc } from '../reply/rewrite.ts'
import { ensureFreebuffSystemMessages, ensureFreebuffToolSignature } from '../../../free-mode.ts'
import { agentIdForModel } from '../../../model.ts'
import { customModels } from '../../routes/catalog.ts'
import { logger } from '../../../util/log.ts'
import { resolveWireModel } from '../../../upstream/catalog/freshness.ts'
import { runStreamingRpc, logRpcResult } from './stream.ts'
import {
  injectableOfficialTools,
  selectOfficialTools,
} from '../../../upstream/signals/tools/official-tool-select.ts'
import { resolveForcedEffort } from '../../reasoning-effort.ts'

/**
 * 上游首字节之后的整篇生成上限(毫秒).
 *
 * 与 schedulingDeadline 分开的理由: 后者是[首字节之前]的预算(防 Cloudflare
 * 100s 悬崖), 前者约束"一次上游调用整体能跑多久". 把两者混用同一值, 就等于
 * "长回复必然超时"(实测卡在 44.8s).
 */
const RPC_TOTAL_TIMEOUT_MS = 600_000

/**
 * official 通道委派 -- 整条请求交给副仓库(cli-bridge)执行, 拿到响应就返回.
 *
 * 官方形态的实现只有一份(在 cli-bridge, bun 执行): 官方 37 工具 / 官方 system
 * 模板 / desktop 世代 agent / 分层 provider. 主服务把
 * instanceId + messages + tools 传过去, 由副仓库 startRun + chat, 再把原始响应
 * 透传给下游 -- 这就是 RPC 边界.
 *
 * 用 reuse 模式: 主服务已经做过 admission 并持有会话, 副仓库复用该会话
 * (一次 admit = 买断一小时).
 *
 * RPC 不可用 / 失败 / 无凭据时返回 upstreamRes = null, 调用方据此走 legacy 路径
 * 并补上官方 system 与签名工具.
 *
 * @param {object} ctx 依赖集合(config / settingsStore)
 * @param {object} args 本次转发所需的上游上下文
 * @returns {Promise<{ upstreamRes: object|null, upstreamErrText: string|null, rpcResponse: boolean }>} RPC 结果
 */
export async function tryOfficialChannel(ctx: any, args: any) {
  const {
    upstream,
    instanceId,
    forwardBody,
    schedulingDeadline,
    upstreamModel,
    requestBody,
    carrierPlan,
    declaredToolNames,
    declaredToolSchemas,
  } = args
  let upstreamRes = null
  let upstreamErrText = null
  /** RPC 是否拿到了响应(拿到则调用方跳过 raw 重试循环). */
  let rpcResponse = false
  const _official =
    resolveUpstreamChannel(
      ctx.settingsStore?.get?.(),
      ctx.config,
      (m, f) => logger.warn(m, f),
    ) === 'official'
  /**
   * bun 承载不了本次出口时必须整条降级到 Node 路径(official 通道只跑在 bun 上).
   *
   * bun 实测不支持 socks5/socks(抛 UnsupportedProxyProtocol): 照旧交给它会让这一跳
   * 失败并回落 legacy, 而 legacy 形态上游会拒(428). Node 侧 undici 支持 socks,
   * 因此显式降级, 让请求仍从正确的出口发出 ---- 绝不[用不了就直连].
   */
  const bunOk = upstream?.egress?.bunEligible !== false
  if (_official && bunOk) {
    try {
      const rpcCfg = await buildRpcCfg(upstream, ctx.config)
      if (!rpcCfg) {
        logger.warn('official channel: no rpc cfg, falling back to legacy')
      } else {
        const rpc = await runOfficialRpc(ctx, {
          rpcCfg,
          upstream,
          instanceId,
          forwardBody,
          upstreamModel,
          schedulingDeadline,
          carrierPlan,
          declaredToolNames,
          declaredToolSchemas,
          wantStream: args.stream !== false,
        })
        if (rpc?.upstreamRes) {
          upstreamRes = rpc.upstreamRes
          upstreamErrText = rpc.upstreamErrText
          rpcResponse = true
        }
      }
    } catch (err: any) {
      logger.warn('official channel rpc failed, falling back to legacy', {
        error: String(err?.message || err),
      })
    }
    //  降级:RPC 没拿到响应(不可用/失败/无凭据)时,
    // 请求体必须补成 legacy 形态再走原 raw 路径.
    if (!upstreamRes) {
      requestBody.messages = ensureFreebuffSystemMessages(
        requestBody.messages,
        forwardBody.agentId || agentIdForModel(upstreamModel, customModels(ctx)),
      )
      if (
        ctx.settingsStore?.get?.()?.freeToolSignatureEnabled !== false &&
        Array.isArray(requestBody.tools)
      ) {
        requestBody.tools = ensureFreebuffToolSignature(
          requestBody.tools,
          true,
        )
      }
    }
  }
  return { upstreamRes, upstreamErrText, rpcResponse }
}

/**
 * 把控制台的官方 system 配置解析成 bun 侧要的形态.
 *
 * 三态映射(与 settings-store 的字段一一对应):
 *   - 'official'(或未配置): undefined ---- bun 侧照抄抓包原文, 零回归;
 *   - 'custom': { mode: 'custom', text } ---- 用自定义正文替换官方模板;
 *   - 'none':   { mode: 'none' } ---- 整段不带官方 system.
 *
 * 为什么不是单纯传字符串: 'none' 与[传了空字符串]在 bun 侧无法区分,
 * 而前者的语义是[不要这个 system 消息], 后者的语义是[要一个空 system].
 *
 * @param {any} s 运行设置快照
 * @returns {{mode: string, text?: string}|undefined} bun 侧入参;未配置时 undefined
 * 官方模板里被冻住的动态段由 bun 侧重算, 判据见 .agents/notes/implemented/bug-fix/2026-10-06-system-template-dynamic-sections.md
 * 自定义正文可用的占位符见 .agents/notes/implemented/feature/2026-10-06-system-prompt-placeholders.md
 */
function resolveSystemPrompt(s: any): { mode: string, text?: string } | undefined {
  if (!s) return undefined
  if (s.officialSystemPromptMode === 'none') return { mode: 'none' }
  if (s.officialSystemPromptMode === 'custom') {
    return { mode: 'custom', text: String(s.officialSystemPromptText ?? '') }
  }
  return undefined
}

/**
 * 解析出这次要注入的官方工具名单.
 *
 * 两级判据, 控制台配置优先:
 *   1. 控制台配过名单 -> 按名单(空数组 = 一个都不注入);
 *   2. 未配置         -> 自动规则: 只注入回程能还原成下游本次真的声明过的名字的那些.
 *
 * 自动规则为什么是默认: 静态分类表对不上客户端形态. 实测同一台机器两种形态,
 * 只声明 run_code 的会话里 37 个官方工具全部派发不了(含静态表判为可派发的 10 个),
 * 而自动规则对任意客户端零配置生效.
 *
 * @param {any} ctx 依赖集合(取 settingsStore)
 * @param {any} declared 下游本次声明的工具名
 * @returns {string[]} 要注入的官方工具名
 */
function officialToolsToInject(ctx: any, declared: any): string[] {
  const sel = selectOfficialTools(ctx.settingsStore?.get?.()?.officialToolNames)
  const names = sel.mode === 'all' ? injectableOfficialTools(declared) : sel.names
  /**
   * 记录本次注入的工具集规模, 供控制台[工具判据]卡片展示.
   *
   * 为什么必须记: 上游按工具集完整性/是否含外来工具名判第三方客户端, 判错的
   * 表现是 503 或回答变差, 而[为什么被判]在服务端完全不可见. 这里把
   * [本次实际注入了几个官方工具]落成可查询状态, 控制台据此给出明确告警.
   */
  try {
    ctx.lastToolInjection = {
      at: Date.now(),
      mode: sel.mode,
      configured: Array.isArray(ctx.settingsStore?.get?.()?.officialToolNames)
        ? ctx.settingsStore.get().officialToolNames.length
        : null,
      injected: names.length,
      declared: Array.isArray(declared) ? declared.length : (declared?.size ?? null),
    }
  } catch {
    // 展示用数据, 失败不影响转发
  }
  return names
}

/**
 * 发一次 official 通道的 RPC.
 *
 * 句柄是单次抓取的票据, 跨进程边界不带它: 副仓库(reuse 路径)每次都自己重抓目录,
 * 拿到的 handle 与主服务手上那份天然不同代次; 主服务把上一代句柄当 modelKey 传过去,
 * 对面 pickRow 必然落空 -> "model not found in catalog" -> 降级 legacy -> 上游 428.
 * 传稳定身份(目录 key)让对面在自己那份表里定位同一行.
 * 见 src/upstream/catalog/freshness.ts 的文件头.
 *
 * @param {any} ctx 依赖集合
 * @param {any} args 本次 RPC 的全部入参
 * @returns {Promise<{upstreamRes: any, upstreamErrText: any}|null>} RPC 结果(失败为 null)
 */
async function runOfficialRpc(ctx: any, args: any) {
  const rpcModel = resolveWireModel(
    args.upstream?.catalog, args.forwardBody.model, args.upstreamModel, { prefer: 'key' },
  )
  if (rpcModel.reason !== 'key') {
    logger.warn('rpc model key not resolved to catalog key', {
      model: args.forwardBody.model,
      requested: args.upstreamModel,
      reason: rpcModel.reason,
    })
  }
  // 思考强度覆盖(前端[思考强度], 实时生效): 命中时忽略下游传来的档位, 用配置的档位.
  // 解析真源是 Node 侧的 resolveForcedEffort; 本处只把结果交给副仓库, 由它写进
  // codebuff_metadata.freebuff_reasoning_effort. 未命中为 null, 出站形态不变.
  const forcedEffort = resolveForcedEffort(
    ctx.settingsStore?.get?.(),
    args.upstream?.catalog,
    [args.upstreamModel, args.forwardBody?.model, rpcModel.model],
  )
  if (forcedEffort) {
    logger.info('reasoning effort overridden', {
      channel: 'official',
      model: forcedEffort.model,
      effort: forcedEffort.effort,
    })
  }
  const rpcArgs = {
    cfg: args.rpcCfg,
    instanceId: args.instanceId,
    modelKey: rpcModel.model,
    messages: args.forwardBody.messages,
    tools: args.forwardBody.tools,
    layer: 'worker',
    stream: true,
    // 强制档位(null = 不覆盖, 副仓库据此不发该 metadata 键).
    reasoningEffort: forcedEffort?.effort ?? null,
    // 官方工具注入名单: undefined = 不裁剪(全注入).
    //
    // 这里只传[结果]不传[分类]: 官方工具的分类真源在 Node 侧
    // (signals/official-tool-select.ts), 副仓只按名单过滤, 不需要知道哪个是
    // common 哪个是 orphan ---- 两份分类表必然漂移.
    //
    // 在 bun 侧过滤而不是在这里删 tools: 删除会让 [下游没声明工具] 与
    // [控制台配置成不注入] 两种情况在 wire 上完全一样, 事后无法区分.
    officialToolNames: officialToolsToInject(ctx, args.declaredToolNames),
    // 官方 system 提示词的处置(见 settings-store 的接口注释).
    // undefined = 未配置 -> bun 侧照抄官方原文; 'none' -> 不带官方 system.
    systemPrompt: resolveSystemPrompt(ctx.settingsStore?.get?.()),
    timeoutMs: Math.max(
      Math.max(1_000, args.schedulingDeadline - Date.now()),
      RPC_TOTAL_TIMEOUT_MS,
    ),
  }
  return args.wantStream
    ? await runStreamingRpc(rpcArgs, args.carrierPlan, args.declaredToolNames, args.declaredToolSchemas)
    : await runWholeRpc(rpcArgs, args.carrierPlan, args.declaredToolNames, args.declaredToolSchemas)
}

/**
 * 非流式: 等 RPC 收完整份再构造响应(离线对比 / 非 stream 调用方).
 *
 * @param {any} rpcArgs rpcReuse 入参
 * @param {any} carrierPlan 载体映射
 * @param {any} declaredToolNames 本次声明的工具名
 * @param {any} declaredToolSchemas 本次声明的工具 schema
 * @returns {Promise<{upstreamRes: any, upstreamErrText: any}|null>} 结果
 */
async function runWholeRpc(rpcArgs: any, carrierPlan: any, declaredToolNames: any, declaredToolSchemas: any) {
  const rpc: any = await rpcReuse(rpcArgs)
  logRpcResult(rpc)
  if (!rpc.status) return null
  return {
    upstreamRes: buildUpstreamResponseFromRpc(rpc, carrierPlan, declaredToolNames, declaredToolSchemas),
    upstreamErrText: rpc.ok ? null : (rpc.text || ''),
  }
}
