/**
 * 上游 chat 转发的重试与换号状态机 -- 从 src/proxy.ts 搬出.
 *
 * 它是本仓最长的一段控制流(417 行): 发请求 -> 判账号级故障 -> 决定换号或重试
 * -> 归一化错误码 -> 写响应. 搬出来的原因是 createProxyHandler 那 1700 行闭包
 * 里, 这段独占四分之一, 而它和选号 / 会话 / 白名单的逻辑并无共享可变状态.
 *
 * 口径: 纯搬移, 行为零改动. 依赖通过 ctx 显式传入.
 */

import {
  extractAccountBanError,
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
  safeText,
  UpstreamError,
} from '../../upstream/client.ts'
import { sendJson } from '../../util/http.ts'
import { logger } from '../../util/log.ts'
import { shouldSwitchAccountOnError } from './errors/errors.ts'
import { mapAndSendError, writeUpstreamError } from './errors/respond.ts'
import { pipeWebStreamToNode, reqToAbortSignal } from './stream/stream-pipe.ts'
import { unmapToolCallsInSse } from './errors/errors.ts'
import { restoreHermesDelegateInResponse, createHermesDelegateSseTransform } from '../../tool-alias.ts'
import { agentIdForModel } from '../../model.ts'
import { filterRequestHeaders, filterResponseHeaders } from '../../util/http.ts'
import { buildRpcCfg, rpcReuse } from '../../upstream/official-rpc.ts'
import { officialChatHeaders } from '../../upstream/official-fingerprint.ts'
import { resolveUpstreamChannel } from '../../config.ts'
import { hasClientTools, stripClientTools } from '../../free-mode.ts'
import { chatHeaderTimeoutMs, effectiveStreamIdleMs } from '../config/limits.ts'
import { handleStreamPipeFailure } from './errors/respond.ts'
import { isToolSchemaRejection, parseRetryAfterMsHeader } from './errors/errors.ts'
import { sleep } from './stream/stream-pipe.ts'
import { customModels, catalogModelKeys } from '../routes/catalog.ts'
import { tryOfficialChannel } from './official.ts'
import { normalizeUpstreamError } from './errors/normalize.ts'


export async function forwardCompletions(
  ctx: any,
  {
  req,
  res,
  forwardBody,
  stream,
  hermesDelegateAlias,
  upstream,
  sessionRemainingMs,
  /**
   - 会话实例 id(admission 回执的 instanceId).
   - 用于 chat 请求的 x-freebuff-instance-id ---- 缺失会导致 428,见下方 headers.
   */
  instanceId,
  /**
   - [首字节之前]的调度截止时间戳(含全局槽位/账号锁/上游首字节).
   - 上游首字节也必须受它约束:不然账号锁等到位了,首字节又能再等 60s,
   - 总和照样冲过 Cloudflare 的 100s 悬崖.
   */
  schedulingDeadline,
  /** 上游模型 id(仅用于日志;forwardBody.model 即它,但显式传更清楚). */
  upstreamModel,
}: any) {
  const headers = {
    ...filterRequestHeaders(req.headers),
    'content-type': 'application/json',
    // 官方 CLI chat 的 Accept 是 */* ---- Bun fetch 的默认值.
    //
    // 真机抓包(官方 CLI 0.2.6,流式 chat ×2)实测两条都是 */*.
    // 此前按 trefeon 的 chat.go:105 写成 application/json, text/event-stream
    // ---- 那是另一个第三方实现的选择,不是官方形态.真机证据优先.
    // 见 .agents/notes/implemented/bug-fix/2026-10-01-chat-ua-two-part.md
    accept: '*/*',
    // chat 头逐字对齐官方 codebuff provider 分支:只有 Authorization +
    // user-agent(+可选 x-freebuff-acting-user-id).官方 chat 不带
    // x-codebuff-api-key ---- 那个头只出现在 session / agent-runs 等端点;多发就是
    // 多余的指纹面.常量真源见 src/upstream/official-fingerprint.ts 与
    // .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
    //  不传 version:官方 chat UA 的版本段是 0.0.0-test(发布构建里
    // __PACKAGE_VERSION__ 未注入而回退),不是包版本号.传 getCliVersion()
    // 会发成 .../0.0.178/codebuff ---- 与官方不一致.用函数默认值.
    ...officialChatHeaders(upstream.token, {
      // 官方 chat 带 x-freebuff-acting-user-id(真机抓包 13 个头里有它,
      // 其余 12 个是传输层).我们此前没传 → 少一个指纹面.
      userId: upstream.accountId || undefined,
    }),
    //  **不要带** x-freebuff-instance-id。
    //
    // 2026-10-03 抓包复核（docs/reverse/15-protocol-review.md）证明：
    // 官方 chat 头部恒为 8 项，8 个样本逐个校验 diff 为空集，
    // **没有** x-freebuff-instance-id / -client / -model /
    // -catalog-protocol / -install-id —— 那些是 admission 用的。
    // 实例标识只走 codebuff_metadata.freebuff_instance_id（已在）。
    //
    // 此前误判为"必须带"：当时补上后 428 消失，但那是巧合——
    // 同批还改了别的。官方不带该头却正常，故不是因果。
    // 见 docs/reverse/15-protocol-review.md P0-1。
  }

  // 风控:chat 调用前打散节奏(随机 [0, requestJitterMs)).上游按请求
  // 节奏指纹自动化脚本,等间隔的机器式调用是明显特征(参考项目 SAFE_MODE
  // 默认 200ms).0 = 关闭.
  const jitterMs = Number(ctx.config.limits.requestJitterMs) || 0
  if (jitterMs > 0) await sleep(Math.random() * jitterMs)

  const abortCtrl = reqToAbortSignal(req)
  // 工具声明被上游拒绝时,去掉 tools 再发一次(见 isToolSchemaRejection).
  // 只对"客户端确实带了 tools"的请求生效----没有工具可去时重试毫无意义.
  // 判据与取舍见
  // .agents/notes/implemented/bug-fix/2026-09-18-tool-schema-rejection-strip.md
  // 注意:toolStripCapable 在 RPC 之后计算(见下),因为只有在确定
  // 走了官方形态时才可以禁用这条退路;若 RPC 不可用而降级到 legacy,
  // 退路必须重新生效(否则 legacy 的 404 无法恢复).
  let requestBody = forwardBody
  let toolsStripped = false
  let upstreamRes
  /** 非 2xx 时上游响应体的文本(在循环里读一次,避免重复消费流). */
  let upstreamErrText = null

  //  official 通道:整条请求委托给副仓库(cli-bridge)执行.
  //
  // 官方形态的实现只有一份(在 cli-bridge,bun 执行):官方 37 工具 /
  // 官方 system 模板 / desktop 世代 agent / 分层 provider.
  // 主服务不复制那份逻辑,而是把 instanceId + messages + tools 传过去,
  // 由副仓库 startRun + chat,再把原始响应透传给下游 ---- 这就是 RPC 边界.
  //
  // 用 reuse 而不是 full:主服务已经做过 admission 并持有会话,
  // 副仓库不需要再买一次(一次 admit = 买断一小时).
  // 见 docs/reverse/17-current-status-and-gaps.md
  // official 通道:整条请求委托给副仓库(cli-bridge)执行, 见 official.ts 的文件头.
  let rpcResponse = false
  {
    const rpc = await tryOfficialChannel(ctx, {
      upstream, instanceId, forwardBody, schedulingDeadline, upstreamModel, requestBody,
    })
    upstreamRes = rpc.upstreamRes
    upstreamErrText = rpc.upstreamErrText
    rpcResponse = rpc.rpcResponse
  }

  // official 通道发的是官方工具集,本就不应触发 tool-schema 拒绝,
  // 也就不需要"剥离工具重试"这条退路(剥离会丢掉官方工具集反而更糟).
  // 但 RPC 没命中而降级到 legacy 时,退路必须重新生效.
  const toolStripCapable =
    hasClientTools(forwardBody) &&
    ctx.settingsStore?.get?.()?.stripToolsOnSchemaRejection === true &&
    !upstreamRes

  try {
    // 最多两轮:第一轮带原工具集,被 tool-schema 拒后第二轮去掉工具.
    //  official 通道已由 RPC 拿到响应 → 整段跳过(不再自己发一次 raw).
    for (let round = 0; round < 2; round++) {
      // 只有 RPC 拿到响应才跳过;循环内重试时上游 404 不应被这里打断
      if (rpcResponse) break
      upstreamRes = await upstream.raw('/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: abortCtrl.signal,
        // 官方 chat 只带 catalog-fetch,不带 catalog-protocol
        // (8 个样本头部集合逐个校验 diff 为空集)
        catalogFetchOnly: true,
        // 响应头等待上限收紧到 body idle 同量级(默认 120s,带 30s 下限):
        // chat 是流式接口,正常秒级出响应头;网络波动(TCP 黑洞)时若等
        // upstreamTimeoutSec(默认 600s)才 abort,账号 chat 锁会被占死
        // 10 分钟,期间所有新请求超时----与幽灵连接同源,必须尽快释放.
        timeoutMs: Math.max(
          1_000,
          Math.min(chatHeaderTimeoutMs(ctx), schedulingDeadline - Date.now()),
        ),
      })
      if (upstreamRes.ok) {
        upstreamErrText = null
        break
      }
      const errText = await safeText(upstreamRes)
      if (
        round === 0 &&
        toolStripCapable &&
        isToolSchemaRejection(upstreamRes.status, errText)
      ) {
        toolsStripped = true
        requestBody = stripClientTools(forwardBody)
        logger.warn('tool-schema rejection; retrying without tools', {
          status: upstreamRes.status,
          model: forwardBody.model,
          tools: Array.isArray(forwardBody.tools)
            ? forwardBody.tools.length
            : 0,
        })
        continue
      }
      upstreamErrText = errText
      break
    }
  } finally {
    // 响应头已到/上游已失败:后续由 pipe 的 socket 监听接管,移除本监听器
    abortCtrl.cleanup()
  }

  const status = upstreamRes.status
  // 可观测性:上游 chat 非 2xx 时把响应体记下来.
  // 503 这类错误不带业务体时最难排查 ---- 没有它只能猜(见控制台[日志]页).
  if (!upstreamRes.ok) {
    logger.warn('upstream chat non-ok', {
      status,
      model: upstreamModel,
      body: String(upstreamErrText || '').slice(0, 800),
    })
  }
  const respHeaders = filterResponseHeaders(upstreamRes.headers)
  if (hermesDelegateAlias) {
    // 回程会改写 tool_calls 的 function.name,原 Content-Length 已不再可信.
    delete respHeaders['content-length']
    res.setHeader(
      'x-freebuff-proxy-tool-alias',
      `delegate_task=${hermesDelegateAlias}`,
    )
  }
  if (toolsStripped) {
    // 可观测性:下游能看出这次回答是在"无工具"模式下取得的.
    res.setHeader('x-freebuff-proxy-tools-stripped', '1')
  }

  if (!upstreamRes.ok) {
    return await normalizeUpstreamError(ctx, {
      upstreamRes, upstreamErrText, respHeaders, status,
    })
  }

  if (!upstreamRes.body) {
    res.writeHead(status, respHeaders)
    res.end()
    return { ok: true, wrote: true }
  }

  // 非流式 JSON 可以整体恢复工具名;流式 SSE 则逐 data 行改写首个携带
  // function.name 的 chunk,后续 arguments 分片原样透传.
  if (hermesDelegateAlias && !stream) {
    const text = await upstreamRes.text()
    let output = text
    try {
      const parsed = text ? JSON.parse(text) : null
      if (parsed) {
        output = JSON.stringify(
          restoreHermesDelegateInResponse(parsed, hermesDelegateAlias),
        )
      }
    } catch {
      // 非 JSON 成功响应保持原样；不要为了兼容别名制造新的失败。
    }
    res.writeHead(status, respHeaders)
    res.end(output)
    return { ok: true, wrote: true }
  }

  const responseBody =
    hermesDelegateAlias && stream
      ? upstreamRes.body.pipeThrough(
          createHermesDelegateSseTransform(hermesDelegateAlias),
        )
      : upstreamRes.body
  res.writeHead(status, respHeaders)
  try {
    await pipeWebStreamToNode(responseBody, res, req, {
      idleTimeoutMs: effectiveStreamIdleMs(ctx, sessionRemainingMs),
    })
    return { ok: true, wrote: true }
  } catch (err) {
    return handleStreamPipeFailure(err, req, res)
  }
}
