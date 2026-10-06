/**
 * 流式回程工具改写 ---- 单行改写与类型定义.
 *
 * 从 sse-tool-rewrite.ts 按职责切出(原文件超 300 行上限): 本文件管
 * "一行 SSE 怎么改", 那个文件管"流怎么织". 语义零改动.
 *
 * 契约要点见下面每个函数自己的注释; 总设计见 sse-tool-rewrite.ts 的文件头.
 */
import { restoreHermesDelegateInResponse } from '../../../tool-alias.ts'
import { EMPTY_CARRIER_PLAN, unpackCarrierToolCalls } from '../tool-carrier.ts'
import { hasParamRule, translateParamsForDownstream } from '../../../upstream/signals/param-map.ts'
import { buildOfficialToClientMap, toNameSet } from '../../../upstream/signals/tool-name-map.ts'

export interface CallState {
  /** 已累积的官方形态参数文本. */
  buf: string
  /** 已还原的下游工具名(首个非空名获胜). */
  name: string | null
  /** 是否已把(翻译后的)参数下发出去. */
  emitted: boolean
}

/**
 * 一次请求的改写上下文.
 *
 * 所有可变状态(state)关在这里, 不在模块级 ---- 否则并发请求会互相污染.
 */
export interface ToolRewritePlan {
  /** 载体映射(空表时该段整体跳过). */
  carriers: any
  /** 官方名 -> 下游名(已按本次声明过滤). */
  back: Record<string, string>
  /** 本次下游声明的名字集合. */
  declared: Set<string>
  /** 本次下游声明的 schema 表. */
  schemas: any
  /** Hermes delegate 别名(null 时该段整体跳过). */
  hermesAlias: any
}

/**
 * 官方名与下游名同名, 形态却不同的工具 -- 名字还原不改写它们, 因此缓冲不能
 * 只看声明的名字集合.
 *
 * 这类工具在两个通道上都会被还原: back[name] 命中(改名通道), 或
 * back[name] 未命中但下游本次声明了同名工具(见 unmapToolCallsInBody 的判据).
 * 后者是流式路径唯一能捕获它们的地方.
 */
const SAME_NAME_SHAPE_DIFFERS = new Set(['code_search'])

/**
 * 建一次请求的改写上下文.
 *
 * 声明集与还原表都由 foreign-client-signals 的同一套函数产出, 与主服务其它路径
 * 共用一份语义(避免同一个工具在不同协议路径上还原成不同名字).
 *
 * @param {any} opts 本次请求的改写参数(carrierPlan / hermesDelegateAlias / declaredToolNames / declaredToolSchemas)
 * @returns {ToolRewritePlan} 改写上下文
 */
export function createToolRewritePlan(opts: any = {}): ToolRewritePlan {
  return {
    carriers: opts.carrierPlan ?? EMPTY_CARRIER_PLAN,
    back: buildOfficialToClientMap(opts.declaredToolNames),
    declared: toNameSet(opts.declaredToolNames),
    schemas: opts.declaredToolSchemas || {},
    hermesAlias: opts.hermesDelegateAlias ?? null,
  }
}

/**
 * 该下游工具名是否值得缓冲它的参数分片.
 *
 * 判据 = 有翻译规则 且 (调用方没给声明集 或 本次真的声明过它).
 * 不满足时完全透传 ---- 55 个工具里大多数走这条零成本路径.
 *
 * @param {ToolRewritePlan} plan 改写上下文
 * @param {any} clientName 还原后的下游工具名
 * @returns {boolean} 值得缓冲为真
 */
export function worthBuffering(plan: ToolRewritePlan, clientName: any): boolean {
  if (!hasParamRule(clientName)) return false
  if (SAME_NAME_SHAPE_DIFFERS.has(clientName)) return true
  return plan.declared.size === 0 || plan.declared.has(clientName)
}

/**
 * 取出一个分片里的 tool_calls(同时覆盖非流式 message 与流式 delta).
 *
 * @param {any} obj 解析后的分片
 * @returns {Array<{ key: string, ci: number, call: any }>} 调用与键及 choice 序号
 */
export function collectCalls(obj: any): Array<{ key: string; ci: number; call: any }> {
  const out: Array<{ key: string; ci: number; call: any }> = []
  const choices = Array.isArray(obj?.choices) ? obj.choices : []
  for (let ci = 0; ci < choices.length; ci++) {
    for (const slot of ['message', 'delta']) {
      const calls = choices[ci]?.[slot]?.tool_calls
      if (!Array.isArray(calls)) continue
      for (let ti = 0; ti < calls.length; ti++) {
        out.push({ key: `${ci}:${calls[ti]?.index ?? ti}`, ci, call: calls[ti] })
      }
    }
  }
  return out
}

/** 一次 rewriteLine 的判决结果. */
export interface LineVerdict {
  /** 要下发的行(原样或改写后). */
  out?: string
  /**
   * 参数在这一行构齐时要补发的分片(同 choice / 同 index, 只带 name + arguments).
   * 参数被拆开时下游已收到"空串"占位, 补这一行把完整参数交给它.
   */
  patch?: { ci: number; slot: string; index: any; name: any; args: string } | null
}

/**
 * 一条 SSE 行的改写.
 *
 * 名字永不被参数等待拖住: 参数未构齐时只把 arguments 摘空, 名字照常下发.
 *
 * @param {string} line 一行原文(含行尾)
 * @param {ToolRewritePlan} plan 改写上下文
 * @param {Map<string, CallState>} states 本请求的调用状态
 * @returns {LineVerdict} 判决
 */
export function rewriteLine(line: string, plan: ToolRewritePlan, states: Map<string, CallState>): LineVerdict {
  const newline = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
  const core = newline ? line.slice(0, -newline.length) : line
  const match = core.match(/^(\s*data:\s*)(.*)$/)
  if (!match) return { out: line }
  const payloadText = match[2]
  if (payloadText.trim() === '[DONE]') return { out: line }

  let obj: any
  try {
    obj = JSON.parse(payloadText)
  } catch {
    return { out: line }
  }

  // 1) 载体拆包(proxy__x -> 下游原名). 原地改并返回同一引用.
  if (plan.carriers?.active) unpackCarrierToolCalls(obj, plan.carriers)
  // 2) Hermes delegate 别名还原. 注意它返回新对象, 丢掉返回值等于这一步没做.
  if (plan.hermesAlias) obj = restoreHermesDelegateInResponse(obj, plan.hermesAlias) || obj

  const calls = collectCalls(obj)
  if (calls.length === 0) {
    return { out: match[1] + JSON.stringify(obj) + newline }
  }

  // 3) 官方名还原 + 参数翻译(有界缓冲).
  let patch: LineVerdict['patch'] = null
  for (const { key, ci, call } of calls) {
    const fn = call?.function
    if (!fn || typeof fn !== 'object') continue
    const state = states.get(key) || { buf: '', name: null, emitted: false }

    normalizeName(fn, state, plan)
    issueArgs(fn, ci, call, key, state, plan, obj, (p) => { patch = p })
    states.set(key, state)
  }

  const out = match[1] + JSON.stringify(obj) + newline
  return patch ? { out, patch } : { out }
}

/**
 * 名字归一: 首个非空名获胜, 并在那时立即还原成下游名.
 *
 * 三条分支各自对应一个实测症状(见文件头):
 *   - 首个非空名: 后续分片里的 null/空 name 绝不能覆盖它, 否则名字被抹空;
 *   - 分片重复声明名字: 以首片为准, 统一成已还原的名字;
 *   - 延续分片不该带 name: 带 null 会让下游累积器抹掉名字 -> unknown tool "".
 *
 * @param {any} fn 分片里的 function 对象
 * @param {CallState} state 该调用的累积状态
 * @param {ToolRewritePlan} plan 改写上下文
 * @returns {void} 无返回值
 */
function normalizeName(fn: any, state: CallState, plan: ToolRewritePlan): void {
  if (state.name == null && typeof fn.name === 'string' && fn.name) {
    const clientName = plan.back[fn.name]
    if (clientName) fn.name = clientName
    state.name = fn.name
    return
  }
  if (typeof fn.name === 'string' && fn.name && state.name != null && fn.name !== state.name) {
    fn.name = state.name
    return
  }
  if ((fn.name === null || fn.name === undefined) && state.name != null) {
    delete fn.name
  }
}

/**
 * 参数处理: 有规则才缓冲, 能解析就立即翻译, 否则摘空并记下补发位置.
 *
 * 摘空而不是扣整行, 是为了让名字(首字节)不被参数等待拖住.
 *
 * @param {any} fn 分片里的 function 对象
 * @param {number} ci choice 序号
 * @param {any} call 调用对象(取 index)
 * @param {string} key 调用键
 * @param {CallState} state 该调用的累积状态
 * @param {ToolRewritePlan} plan 改写上下文
 * @param {any} obj 整行解析后的对象(判 message/delta 槽位)
 * @param {(patch: any) => void} setPatch 记下补发位置的回调
 * @returns {void} 无返回值
 */
function issueArgs(
  fn: any,
  ci: number,
  call: any,
  key: string,
  state: CallState,
  plan: ToolRewritePlan,
  obj: any,
  setPatch: (patch: any) => void,
): void {
  const worth = worthBuffering(plan, state.name)
  if (!worth || state.name == null || typeof fn.arguments !== 'string' || !fn.arguments) return

  if (state.emitted) {
    // 已下发过完整参数: 后续碎片清空, 不让下游重复拼接.
    fn.arguments = ''
    return
  }
  state.buf += fn.arguments
  const translated = translateParamsForDownstream(state.name, state.buf, plan.schemas[state.name])
  if (translated != null) {
    fn.arguments = translated
    state.emitted = true
    return
  }
  // 参数尚未构成合法 JSON: 摘空本片参数, 记下补发位置(构齐后发同 index 的分片).
  fn.arguments = ''
  setPatch({
    ci,
    slot: Array.isArray(obj?.choices?.[ci]?.message?.tool_calls) ? 'message' : 'delta',
    index: call?.index ?? 0,
    name: state.name,
    args: '',
  })
}

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

/**
 * 构造补发的分片(与首片同 choice / 同 tool_call index, 只带 name 与 arguments).
 *
 * @param {NonNullable<LineVerdict['patch']>} patch 补发位置
 * @param {any} name 下游工具名
 * @param {string} args 翻译后的参数文本
 * @returns {any} 可序列化的分片
 */
export function buildPatchLine(patch: NonNullable<LineVerdict['patch']>, name: any, args: string) {
  return {
    choices: [{
      index: patch.ci,
      [patch.slot]: {
        tool_calls: [{ index: patch.index, function: { name, arguments: args } }],
      },
    }],
  }
}
