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
import { runStreamingRpc, logRpcResult } from './stream.ts'

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
  if (_official) {
    try {
      const rpcCfg = await buildRpcCfg(upstream, ctx.config)
      if (!rpcCfg) {
        logger.warn('official channel: no rpc cfg, falling back to legacy')
      } else {
        const wantStream = args.stream !== false
        const rpcArgs = {
          cfg: rpcCfg,
          instanceId,
          modelKey: forwardBody.model,
          messages: forwardBody.messages,
          tools: forwardBody.tools,
          layer: 'worker',
          stream: true,
          timeoutMs: Math.max(
            Math.max(1_000, schedulingDeadline - Date.now()),
            RPC_TOTAL_TIMEOUT_MS,
          ),
        }
        const rpc = wantStream
          ? await runStreamingRpc(rpcArgs, carrierPlan, declaredToolNames, declaredToolSchemas)
          : await runWholeRpc(rpcArgs, carrierPlan, declaredToolNames, declaredToolSchemas)
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
