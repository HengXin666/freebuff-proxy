/**
 * official 通道的 RPC 委派 -- 从 src/proxy/transport/forward.js 搬出.
 *
 * forward.js 原本 452 行(超 300 上限), 其中这 96 行是"把请求交给副仓库"的
 * 独立一段: 判通道是否是 official -> 建 RPC 配置 -> 调 rpcReuse -> 还原工具名
 * -> 失败时返回 null 让调用方走 legacy. 它与前后的重试状态机只通过
 * requestBody 与 upstreamRes 两个值交互, 因此可以整体搬出.
 *
 * 口径: 纯搬移, 行为零改动.
 */

import { resolveUpstreamChannel } from '../../config.js'
import { buildRpcCfg, rpcReuse } from '../../upstream/official-rpc.js'
import { unmapToolCallsInSse } from './errors/errors.ts'
import { ensureFreebuffSystemMessages, ensureFreebuffToolSignature } from '../../free-mode.js'
import { agentIdForModel } from '../../model.js'
import { customModels } from '../routes/catalog.js'
import { logger } from '../../util/log.js'

/**
 * official 通道委派 -- 整条请求交给副仓库(cli-bridge)执行, 拿到响应就返回.
 *
 * 官方形态的实现只有一份(在 cli-bridge, bun 执行): 官方 37 工具 / 官方 system
 * 模板 / desktop 世代 agent / 分层 provider. 主服务不复制那份逻辑, 而是把
 * instanceId + messages + tools 传过去, 由副仓库 startRun + chat, 再把原始响应
 * 透传给下游 -- 这就是 RPC 边界.
 *
 * 用 reuse 而不是 full: 主服务已经做过 admission 并持有会话, 副仓库不需要再买
 * 一次(一次 admit = 买断一小时).
 *
 * RPC 不可用 / 失败 / 无凭据时返回 upstreamRes = null, 调用方据此走 legacy 路径
 * 并补上官方 system 与签名工具(否则会发出一个既没有官方 system 也没有签名工具的
 * 畸形请求).
 *
 * @param {object} ctx 依赖集合(config / settingsStore)
 * @param {object} args 本次转发所需的上游上下文
 * @returns {Promise<{ upstreamRes: object|null, upstreamErrText: string|null, rpcResponse: boolean }>} RPC 结果
 */
export async function tryOfficialChannel(ctx, args) {
  const { upstream, instanceId, forwardBody, schedulingDeadline, upstreamModel, requestBody } = args
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
        const rpc = await rpcReuse({
          cfg: rpcCfg,
          instanceId,
          modelKey: forwardBody.model,
          messages: forwardBody.messages,
          tools: forwardBody.tools,
          layer: 'worker',
          stream: true,
          timeoutMs: Math.max(
            1_000,
            Math.min(180_000, schedulingDeadline - Date.now()),
          ),
        })
        logger.info('official channel: rpc result', {
          status: rpc.status,
          ok: rpc.ok,
          model: rpc.model?.name,
          error: rpc.error,
          /**
           - 非 200 时必须把上游原文记下来(2026-10-04 教训).
           *
           - 此前只记 status,于是 503 时日志里只有一行
           - official channel: rpc result status=503 ---- 而上游原文
           - ({"error":{"message":"The model is temporarily unavailable.",...}}
           - 之类)我们明明拿到了(放在 rpc.text 里),却只塞进 Response
           - 不记日志.排障时只能看见"503"这个数字,看不到上游给的原因.
           *
           - 截断到 300 字符:够看清 message/code,又不至于把整段流式体写进日志.
           */
          body:
            rpc.ok || !rpc.text
              ? undefined
              : String(rpc.text).slice(0, 300),
        })
        if (rpc.status) {
          rpcResponse = true
          /**
           - 上行工具名还原(与 bun 侧的下行映射配对).
           *
           - 下行把 bash→run_terminal_command 等换成官方等价名(否则上游
           - 回 503,见 cli-bridge/upstream.mjs 的 MAP_TOOLS 说明).
           - 客户端拿到响应时,tool_calls[].function.name 是官方名----
           - 下游不认识,也没法派发.所以在透传前逐行还原成它声明的名字.
           *
           - SSE 逐行处理:只在 data: {...} 行上做 JSON 解析 + 名字替换,
           - 不是 JSON 的行([DONE],空行)原样保留.
           */
          const rawText = rpc.text || ''
          upstreamRes = new Response(
            unmapToolCallsInSse(rawText),
            {
              status: rpc.status,
              headers: { 'content-type': 'application/json' },
            },
          )
          upstreamErrText = rpc.ok ? null : (rpc.text || '')
        }
      }
    } catch (err) {
      logger.warn('official channel rpc failed, falling back to legacy', {
        error: String(err?.message || err),
      })
    }
    //  降级:RPC 没拿到响应(不可用/失败/无凭据)时,
    // 请求体必须补成 legacy 形态再走原 raw 路径 ----
    // 否则会发出一个"既没有官方 system,也没有签名工具"的畸形请求.
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
