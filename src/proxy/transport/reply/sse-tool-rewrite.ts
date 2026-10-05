/**
 * 流式回程工具改写 ---- 边收边改, 不缓冲整份响应.
 *
 * 取代旧的 mergeAndTranslateSseToolCalls: 后者要先 await res.text() 把上游整条
 * 流收完才能开始合并, 于是"上游不产完整篇回复 -> bun 子进程不返回 -> 主服务一个
 * 字节都吐不出来", 45s 调度预算耗尽后降级 legacy, 请求失败(2026-10-05 线上事故
 * reqId 0f45afc1: rpc timeout 44784ms -> 428 -> 换号 -> 全池买不起 -> 下游 429).
 *
 * 设计依据(线上实测 + 公开协议语义):
 *   - function.name 只出现在首个携带该 tool_call 的分片里 -> 名字还原逐分片可做,
 *     首字节延迟为零 (OpenAI streaming 约定: arguments 是字符串分片, 多个并行调用
 *     按 index 区分);
 *   - 累积语义必须是 [index 优先键控 + 首个非空 name 获胜] ---- 后续分片里的
 *     null/空 name 绝不能覆盖首片捕获的名字, 否则工具名被抹空
 *     (deepseek-harness discussion #1713 实测: 下游报 unknown tool "");
 *   - 在这条链路上上游几乎总把整份 arguments 放在首片(实测 {"command":"uname -a"}
 *     整份在 index=0 的首片, 后续分片 arguments 为空串).
 *
 * 因此用[有界缓冲]而不是[整段缓冲]:
 *   1. 名字: 首片立即改写并下发 ---- 永不被参数等待拖住;
 *   2. 参数: 只在该工具[确有翻译规则]时才累积; 一旦累积文本能被 JSON.parse 就立刻
 *      翻译并就地替换(一次给完的上游因此零额外延迟);
 *   3. 参数真被拆开时, 该分片的 arguments 先摘空(名字照常下发), 构齐后补发一行
 *      同 index 的分片承载翻译结果 ---- 下游按 index 累积 arguments,
 *      "" + 完整参数 与 完整参数 等价, 所以下游看到的仍是正确的一次调用;
 *   4. 无翻译规则的工具名(55 个里的大多数)完全不过缓冲, 直接透传.
 *
 * 三个变换在同一遍里做完(作用的名字集合互不相交, 顺序不改变结果):
 *   载体拆包(proxy__x -> x) -> 官方名还原 + 参数翻译 -> Hermes 别名还原.
 *
 * 任何解析失败都原样放行: 改写是增强, 不是必经环节, 不该把一次成功的响应变成错误.
 */
import { restoreHermesDelegateInResponse } from '../../../tool-alias.ts'
import { buildOfficialToClientMap, toNameSet } from '../../../upstream/signals/tool-name-map.ts'

import { rewriteLine, buildPatchLine, type CallState, type LineVerdict, type ToolRewritePlan } from './sse-tool-line.ts'
import { translateParamsForDownstream } from '../../../upstream/signals/param-map.ts'

export { createToolRewritePlan } from './sse-tool-line.ts'
export type { ToolRewritePlan } from './sse-tool-line.ts'

/**
 * 建一个流式工具改写变换: 逐行改写, 保留增量投递.
 *
 * 与纯透传的差别只有"逐行 JSON.parse + 改名字"这一点 CPU ---- 没有整段缓冲,
 * 上游吐一片就下发一片. 参数没构齐时只摘空那一片的 arguments(名字照常下发),
 * 构齐后补发一行同 index 的分片承载翻译结果.
 *
 * @param {ToolRewritePlan} plan 本次请求的改写上下文
 * @returns {TransformStream<Uint8Array, Uint8Array>} 变换流
 */
export function createToolRewriteSseTransform(plan: ToolRewritePlan): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const states = new Map<string, CallState>()
  /** 参数被摘空而仍在累积的调用(键 -> 补发位置). 只在流结束仍未构齐时才用. */
  const pendingPatch = new Map<string, NonNullable<LineVerdict['patch']>>()
  let pending = ''

  /**
   * 处理一整行.
   *
   * 参数构齐时会就地把那一片的 arguments 换成翻译结果并下发(见 rewriteLine),
   * 所以这里不需要额外补发 ---- 补发是多余的, 会让下游把同一份参数拼两次
   * (实测: arguments 变成 {..}{..} 而不是 {..})
   * 只有"流结束时仍未构齐"才需要兜底补一次(flush 里做)
   *
   * @param {string} line 一行原文
   * @param {TransformStreamDefaultController<Uint8Array>} controller 变换控制器
   * @returns {void} 无返回值
   */
  const handleLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const verdict = rewriteLine(line, plan, states)
    if (verdict.out != null) controller.enqueue(encoder.encode(verdict.out))
    if (verdict.patch) {
      // 这一行的参数还没构齐: 记下补发位置, 等流结束兜底.
      pendingPatch.set(`${verdict.patch.ci}:${verdict.patch.index}`, verdict.patch)
    }
    // 已构齐的条目必须立刻清出 ---- 否则流结束的 flush 会把同一份参数再补一次,
    // 下游按 index 累积就成了 {..}{..}(实测过这个形态).
    for (const [k, s] of states) if (s.emitted) pendingPatch.delete(k)
  }

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      let newlineAt
      while ((newlineAt = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newlineAt + 1)
        pending = pending.slice(newlineAt + 1)
        handleLine(line, controller)
      }
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending) handleLine(pending, controller)
      // 流结束时仍未构齐的调用: 把已累积的文本原样补出, 不让下游收到空参数.
      for (const [key, patch] of pendingPatch) {
        const state = states.get(key)
        if (!state || !state.buf) continue
        controller.enqueue(encoder.encode(
          'data: ' + JSON.stringify(buildPatchLine(patch, state.name, state.buf)) + '\n\n',
        ))
      }
      pendingPatch.clear()
    },
  })
}

/**
 * 构造补发的分片(与首片同 choice / 同 tool_call index, 只带 name 与 arguments).
 *
 * @param {NonNullable<LineVerdict['patch']>} patch 补发位置
 * @param {any} name 下游工具名
 * @param {string} args 翻译后的参数文本
 * @returns {any} 可序列化的分片
 */
