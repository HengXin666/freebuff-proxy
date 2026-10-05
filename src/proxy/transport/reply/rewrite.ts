/**
 * 回程工具名改写 ---- 从 src/proxy/transport/forward.ts 与 official.ts 搬出.
 *
 * 上游回来的 tool_calls 名字与下游自己声明的名字之间有两条独立映射:
 *   1. 官方名还原(bash 之类的下行改名, 见 ../../tool-alias.ts 与 tool-map):
 *      下行把 bash 换成 run_terminal_command 等官方等价名, 回程必须换回来,
 *      否则下游不认识那个名字, 没法派发.
 *   2. 第三方工具载体拆包(见 ../tool-carrier.ts): 无官方等价物的工具下行被包成
 *      MCP 形态名字, 回程按同一张映射表拆回下游原名.
 *
 * 两者作用的名字集合不相交(载体名以 MCP 前缀开头, 官方名不带该前缀), 所以
 * 在一次响应里同时出现也能各自正确改写.
 *
 * 任何解析失败都原样放行: 改写是增强, 不是必经环节, 不该把一次成功的响应
 * 变成错误.
 */
import { createHermesDelegateSseTransform, restoreHermesDelegateInResponse } from '../../../tool-alias.ts'
import { EMPTY_CARRIER_PLAN, createCarrierSseTransform, unpackCarrierToolCalls } from '../tool-carrier.ts'
import { unmapToolCallsInSse } from '../errors/errors.ts'
import { mergeAndTranslateSseToolCalls } from './sse-tool-merge.ts'

/**
 * 回程改写相关的响应头与观测头.
 *
 * 两处改写都会改 tool_calls 的 function.name, 原 Content-Length 不再可信,
 * 必须删掉 ---- 否则下游按旧长度截断响应.
 *
 * @param {any} res 下游响应
 * @param {any} respHeaders 已过滤的上游响应头(原地删 content-length)
 * @param {{ hermesDelegateAlias: any, toolsStripped: boolean, plan: any }} opts 本次改写上下文
 * @returns {void} 无返回值
 */
export function prepareRewriteHeaders(res: any, respHeaders: any, opts: any) {
  const { hermesDelegateAlias, toolsStripped, plan } = opts
  if (hermesDelegateAlias || plan?.active) delete respHeaders['content-length']
  if (hermesDelegateAlias) {
    res.setHeader(
      'x-freebuff-proxy-tool-alias',
      `delegate_task=${hermesDelegateAlias}`,
    )
  }
  if (toolsStripped) {
    // 可观测性:下游能看出这次回答是在"无工具"模式下取得的.
    res.setHeader('x-freebuff-proxy-tools-stripped', '1')
  }
  if (plan?.active) {
    // 可观测性:本次有多少下游工具经由载体形态发出(回程会拆回原名).
    res.setHeader(
      'x-freebuff-proxy-tool-carriers',
      String(Object.keys(plan.carriers).length),
    )
  }
}

/**
 * 按本次请求的两套映射改写上游响应里的工具名.
 *
 * 非流式:整份 JSON 解析后改写, 交给调用方一次写出.
 * 流式:返回接了两级 TransformStream 的响应体, 逐 data 行改写, 保留增量投递;
 * 只处理首个携带 function.name 的分片, 后续 arguments 分片原样透传.
 *
 * @param {any} upstreamRes 上游响应(其 body 为可读流)
 * @param {{ stream: boolean, hermesDelegateAlias: any, plan: any }} opts 改写上下文
 * @returns {Promise<{ handled: boolean, text?: string, body?: any }>} 非流式返回文本, 流式返回改写后的体
 */
export async function rewriteUpstreamResponse(upstreamRes: any, opts: any) {
  const { stream, hermesDelegateAlias, plan, declaredToolNames, declaredToolSchemas } = opts
  const needUnpack = Boolean(plan?.active)
  /**
   - 整体 JSON 分支的前置: 上游回的必须是有限 JSON, 不能是一个不结束的流.
   -
   - 非流式的下游请求, 上游照样可能回 SSE(官方链路 stream 恒为 true) ----
   - 实测: 对 SSE 体调 text() 会一直等到流结束, 而这条流由上游持续推送,
   - 于是这次请求永久挂住(表现为 smoke 里整个套件停住不返回).
   - 所以先看 content-type: 事件流一律走流式改写, 不做整体读.
   */
  const contentType = String(upstreamRes.headers?.get?.('content-type') || '')
  const isEventStream = contentType.includes('event-stream')
  if (!stream && !isEventStream && (hermesDelegateAlias || needUnpack)) {
    const text = await upstreamRes.text()
    try {
      const parsed = text ? JSON.parse(text) : null
      if (!parsed) return { handled: true, text }
      if (plan?.active) unpackCarrierToolCalls(parsed, plan)
      const output = hermesDelegateAlias
        ? restoreHermesDelegateInResponse(parsed, hermesDelegateAlias)
        : parsed
      return { handled: true, text: JSON.stringify(output) }
    } catch {
      // 非 JSON 成功响应保持原样;不要为了兼容别名制造新的失败.
      return { handled: true, text }
    }
  }
  let body = upstreamRes.body
  if (plan?.active) body = body.pipeThrough(createCarrierSseTransform(plan))
  if (hermesDelegateAlias) {
    body = body.pipeThrough(createHermesDelegateSseTransform(hermesDelegateAlias))
  }
  return { handled: false, body }
}

/**
 * 把 RPC 回执原文包成下游要的 Response, 并做两段上行工具名改写.
 *
 * 顺序是先载体拆包再官方名还原: 两者作用的名字集合不相交, 顺序不改变结果,
 * 先拆包是为了让后续还原处理的是下游原名.
 *
 * SSE 逐行处理: 只在 data: {...} 行上做 JSON 解析与名字替换, 不是 JSON 的行
 * ([DONE], 空行)原样保留.
 *
 * @param {any} rpc rpcReuse 的回执(含 status 与 text)
 * @param {any} carrierPlan 本次请求的工具载体映射(可缺省)
 * @param {Iterable<string>|any[]} [declaredNames] 本次下游声明的工具名集合
 * @param {Record<string, any>} [declaredSchemas] 本次下游声明的工具 schema(名字 -> parameters)
 * @returns {any} 下游响应对象(status 与上游一致)
 */
export function buildUpstreamResponseFromRpc(rpc: any, carrierPlan: any, declaredNames?: any, declaredSchemas?: any) {
  const rawText = rpc.text || ''
  const plan = carrierPlan ?? EMPTY_CARRIER_PLAN
  const carrierUnpacked = plan.active ? unpackCarrierInRpcText(rawText, plan) : rawText
  // 顺序要紧: 先按[本次声明]还原名字并翻译参数(需要完整文本才能跨分片合并),
  // 再交给逐行的通用还原兜底.
  const merged = mergeAndTranslateSseToolCalls(carrierUnpacked, declaredNames, declaredSchemas)
  return new Response(unmapToolCallsInSse(merged, declaredNames, declaredSchemas), {
    status: rpc.status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 对 RPC 回执原文做载体拆包(SSE 与整体 JSON 两种形态都支持).
 *
 * 逐行解析失败即原样放行: 上游分片边界不保证与 JSON 字段边界一致, 任何
 * 解析错误都不该破坏这次响应.
 *
 * @param {string} text RPC 回执原文
 * @param {any} plan 本次请求的载体映射
 * @returns {string} 拆包后的原文
 */
function unpackCarrierInRpcText(text: string, plan: any): string {
  if (typeof text !== 'string' || !text) return text
  if (!text.includes('data: ')) {
    try {
      return JSON.stringify(unpackCarrierToolCalls(JSON.parse(text), plan))
    } catch {
      return text
    }
  }
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data: ')) return line
      const payload = line.slice(6).trim()
      if (!payload || payload === '[DONE]') return line
      try {
        return 'data: ' + JSON.stringify(unpackCarrierToolCalls(JSON.parse(payload), plan))
      } catch {
        return line
      }
    })
    .join('\n')
}
