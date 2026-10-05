/**
 * 下游私有工具的上游载体 -- 打包 (下行) 与拆包 (上行).
 *
 * 为什么需要: 上游官方工具集是固定 37 个, 下游 harness 的工具名 (bash /
 * read / memory_save 之类) 与它交集很小. 官方本来就支持客户端自定义工具,
 * 承载形态是 MCP 名 (server 加双下划线加 tool), 出站展开进 tools 数组.
 *
 * 三件事:
 *   1. 下行打包: 下游工具中[官方有等价物]的交给官方改名通道 (见 tool-map);
 *      [没有等价物]的包成官方 MCP 载体名, 原名记进映射表.
 *   2. 下行历史对齐: 历史消息里出现过下游工具名的地方同步换成 wire 名,
 *      否则模型看见的历史与 tools 清单对不上.
 *   3. 上行拆包: 按映射表把载体名还原成下游原名, 下游才能按自己的名字派发.
 *
 * 载体名不上多余字段: 官方 wire 的 tools 每项只有 type 与 function, 加
 * mcpOrigin 之类会与官方形态不一致, 所以还原只靠映射表 (请求作用域内).
 *
 * 真值来源见 ../upstream/signals/mcp-names.ts 文件头; 决策记录见
 * .agents/notes/implemented/architecture/2026-10-05-third-party-tool-carrier.md
 */

import { createHash } from 'node:crypto'

import { CLIENT_TO_OFFICIAL_TOOL } from '../../upstream/foreign-client-signals.ts'
import { MCP_CARRIER_SERVER, mcpExposedToolName, toolInputSchema } from '../../upstream/signals/mcp-names.ts'

/** wire 名长度上限 (上游严格校验 VALID_TOOL_NAME 是 1..64). */
const WIRE_NAME_MAX = 64

/**
 * 一次请求的载体映射.
 *
 * carriers: wire 名 -> 下游原名 (上行拆包用)
 */
export interface ToolCarrierPlan {
  /** wire 名 -> 下游原始工具名. */
  carriers: Record<string, string>
  /** 下游原始工具名 -> wire 名 (下行历史对齐用). */
  forward: Record<string, string>
  /** 本次是否有任何工具经历了包装 (false 时回程可整体跳过). */
  active: boolean
}

/** 空映射 (没有可包装工具时的常量, 避免到处判空). */
export const EMPTY_CARRIER_PLAN: ToolCarrierPlan = Object.freeze({
  carriers: Object.freeze({}),
  forward: Object.freeze({}),
  active: false,
})

/**
 * 合成可逆的 wire 工具栏位名.
 *
 * 短名直接拼 (与上游 mcpExposedToolName 同形); 超长时截断加名字哈希,
 * 此时可逆性由映射表保证而不是由名字保证.
 *
 * @param {string} name 下游原始工具名
 * @returns {string} wire 名 (长度不超过 64)
 */
function carrierNameFor(name: string): string {
  const direct = mcpExposedToolName(MCP_CARRIER_SERVER, name)
  if (direct.length <= WIRE_NAME_MAX) return direct
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  const head = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, WIRE_NAME_MAX - 16)
  return `${MCP_CARRIER_SERVER}__${head}_${digest}`
}

/**
 * 该下游工具名是否已有官方等价物 (有则走官方改名通道, 不需要载体).
 *
 * @param {unknown} name 下游工具名
 * @returns {boolean} 有等价物为真
 */
function hasOfficialEquivalent(name: unknown): boolean {
  if (typeof name !== 'string') return false
  return Boolean((CLIENT_TO_OFFICIAL_TOOL as Record<string, string>)[name])
}

/**
 * 把下游工具数组里没有官方等价物的那些包成官方 MCP 载体形态.
 *
 * 幂等: 已是载体前缀的名字原样保留 (下游不会声明这种名字).
 *
 * skip 用于把已由别的窄通道处理的工具名让出去 (如 Hermes 的 delegate_task
 * 走 tool-alias 双向别名), 两条通道不得对同一个名字各改一次.
 *
 * @param {any} clientTools 下游声明的工具 (OpenAI 形态)
 * @param {(name: string) => boolean} [skip] 返回 true 表示该名字不由本通道处理
 * @returns {{ tools: any[], plan: ToolCarrierPlan }} 出站工具数组与映射
 */
export function packClientTools(
  clientTools: any,
  skip?: (name: string) => boolean,
): { tools: any[]; plan: ToolCarrierPlan } {
  if (!Array.isArray(clientTools) || clientTools.length === 0) {
    return { tools: Array.isArray(clientTools) ? clientTools : [], plan: EMPTY_CARRIER_PLAN }
  }
  const out: any[] = []
  const carriers: Record<string, string> = {}
  const forward: Record<string, string> = {}
  const prefix = `${MCP_CARRIER_SERVER}__`
  for (const tool of clientTools) {
    const fn = tool?.function
    const name = fn?.name
    if (
      typeof name !== 'string' ||
      !name ||
      hasOfficialEquivalent(name) ||
      name.startsWith(prefix) ||
      (typeof skip === 'function' && skip(name))
    ) {
      out.push(tool)
      continue
    }
    const wire = carrierNameFor(name)
    carriers[wire] = name
    forward[name] = wire
    out.push({
      type: 'function',
      function: {
        name: wire,
        description:
          typeof fn.description === 'string' && fn.description
            ? fn.description
            : `Carried by the proxy on behalf of the client: ${name}`,
        parameters: toolInputSchema(fn),
      },
    })
  }
  const active = Object.keys(carriers).length > 0
  return {
    tools: out,
    plan: active ? { carriers, forward, active } : EMPTY_CARRIER_PLAN,
  }
}

/**
 * 把消息历史里出现下游工具名的地方换成 wire 名.
 *
 * 覆盖三处 (与 OpenAI 会话形态一一对应): assistant 的 tool_calls 与
 * function_call, 以及 role 为 tool 的消息的 name. 漏掉任何一处, 模型看到的
 * 历史调用名就不在 tools 清单里.
 *
 * @param {any} messages 消息数组
 * @param {ToolCarrierPlan} plan 本次请求的载体映射
 * @returns {any} 新的消息数组 (无改动时返回原引用)
 */
export function alignToolNamesForUpstream(messages: any, plan: ToolCarrierPlan): any {
  if (!plan?.active || !Array.isArray(messages)) return messages
  const map = plan.forward
  let changed = false
  const out = messages.map((message: any) => {
    if (!message || typeof message !== 'object') return message
    const next: any = { ...message }
    let local = false

    if (Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls.map((call: any) => {
        const wire = map[call?.function?.name]
        if (!wire) return call
        local = true
        return { ...call, function: { ...call.function, name: wire } }
      })
      if (local) next.tool_calls = calls
    }
    const wireFn = map[message.function_call?.name]
    if (wireFn) {
      next.function_call = { ...message.function_call, name: wireFn }
      local = true
    }
    if (message.role === 'tool' && typeof message.name === 'string' && map[message.name]) {
      next.name = map[message.name]
      local = true
    }

    if (!local) return message
    changed = true
    return next
  })
  return changed ? out : messages
}

/**
 * 把上游返回的载体工具名还原成下游原始名.
 *
 * 处理非流式的 message 与流式的 delta 两种承载, 也覆盖旧式 function_call.
 * 参数分片不动.
 *
 * @param {any} body 上游响应体或一个 SSE 分片对象
 * @param {ToolCarrierPlan} plan 本次请求的载体映射
 * @returns {any} 原地修改后的对象 (同时返回, 便于链式使用)
 */
export function unpackCarrierToolCalls(body: any, plan: ToolCarrierPlan): any {
  if (!body || typeof body !== 'object' || !plan?.active) return body
  const back = plan.carriers
  const choices = Array.isArray(body.choices) ? body.choices : []
  for (const choice of choices) {
    for (const holder of [choice?.message, choice?.delta]) {
      const calls = holder?.tool_calls
      if (Array.isArray(calls)) {
        for (const call of calls) {
          const name = call?.function?.name
          if (typeof name === 'string' && back[name]) call.function.name = back[name]
        }
      }
      const fnCall = holder?.function_call
      if (fnCall && typeof fnCall.name === 'string' && back[fnCall.name]) {
        fnCall.name = back[fnCall.name]
      }
    }
  }
  return body
}

/**
 * 拆包单个 SSE 行 (非 data 行与 [DONE] 原样返回).
 *
 * 保留原始行尾:下游按字节重组的客户端对换行形态敏感.
 *
 * @param {string} line 一行原文
 * @param {ToolCarrierPlan} plan 本次请求的载体映射
 * @returns {string} 改写后的一行
 */
export function unpackCarrierSseLine(line: any, plan: ToolCarrierPlan): string {
  if (!plan?.active || typeof line !== 'string') return line
  const newline = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
  const core = newline ? line.slice(0, -newline.length) : line
  const match = core.match(/^(\s*data:\s*)(.*)$/)
  if (!match) return line
  const payloadText = match[2]
  if (payloadText.trim() === '[DONE]') return line
  try {
    const parsed = JSON.parse(payloadText)
    return match[1] + JSON.stringify(unpackCarrierToolCalls(parsed, plan)) + newline
  } catch {
    return line
  }
}

/**
 * 流式响应的载体拆包变换 -- 与官方逐 chunk 增量投递的形态保持一致.
 *
 * 只有首个携带 function.name 的分片需要改写, 但这里逐行过一遍: 上游各分片
 * 的边界不保证与 json 字段边界一致, 逐行解析失败即原样放行, 不会破坏流.
 *
 * @param {ToolCarrierPlan} plan 本次请求的载体映射
 * @returns {TransformStream<Uint8Array, Uint8Array>} 变换流
 */
export function createCarrierSseTransform(plan: ToolCarrierPlan): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      let newlineAt
      while ((newlineAt = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newlineAt + 1)
        pending = pending.slice(newlineAt + 1)
        controller.enqueue(encoder.encode(unpackCarrierSseLine(line, plan)))
      }
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending) controller.enqueue(encoder.encode(unpackCarrierSseLine(pending, plan)))
    },
  })
}
