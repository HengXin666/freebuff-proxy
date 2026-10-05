/**
 * Responses 请求 -> chat 请求体.
 *
 * 协议真值取自 dsh 自身实现(@earendil-works/pi-ai 的 openai-responses),
 * 不靠记忆: 请求发 /v1/responses, 顶层字段
 * model / input / stream / store 与 tools, 工具是扁平形态
 * {type:'function', name, description, parameters} (没有 chat 那层 function 包装).
 *
 * Responses 的 input 是 item 数组, 与 chat 的 messages 语义对应但形状不同:
 *   {role:'user'|'system'|'developer', content: string}
 *   {type:'function_call', call_id, name, arguments}
 *   {type:'function_call_output', call_id, output}
 * 工具结果靠 call_id 关联, 而 chat 靠 tool_call_id, 所以必须显式搬过去,
 * 否则模型看见的是一次没有结果的调用.
 */
import type { ToolCarrierPlan } from '../../transport/tool-carrier.ts'

/** 一次翻译的产物. */
export interface ChatFromResponses {
  /** chat 形态请求体(仍是对象, 由调用方序列化). */
  body: any
  /** 原始 Responses 请求体(回程翻译时要用 stream 等原始信息). */
  original: any
  /** 下游 stream 标志(请求里显式给的就是它, 缺省按流式). */
  stream: boolean
}

/**
 * Responses 的工具定义 -> chat 的工具定义.
 *
 * 已带 function 包装的原样保留(宽容对待上游/其它网关的写法), 否则把平铺字段
 * 收进 function. 无名字的工具丢弃: 没有名字下游无法派发, 留着只会让上游
 * schema 校验失败.
 *
 * @param {any} tools Responses 形态的工具数组
 * @returns {any[]} chat 形态的工具数组
 */
function toChatTools(tools: any): any[] {
  const out: any[] = []
  if (!Array.isArray(tools)) return out
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    if (tool.function && typeof tool.function === 'object') {
      if (typeof tool.function.name === 'string' && tool.function.name) out.push(tool)
      continue
    }
    if (tool.type === 'function' && typeof tool.name === 'string' && tool.name) {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      })
    }
  }
  return out
}

/**
 * 一段 Responses content(字符串或内容块数组)-> 纯文本.
 *
 * @param {any} content Responses 的 content
 * @returns {string} 文本
 */
function contentText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    const text = part?.text ?? part?.input_text ?? part?.output_text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('')
}

/**
 * Responses 的 input 数组 -> chat 的 messages 数组.
 *
 * 三种 item 各有对应关系, 其余类型如实跳过(不猜: 猜错会把一个不存在的
 * 历史塞给模型).
 *
 * @param {any} input Responses 请求的 input(数组或纯字符串)
 * @returns {any[]} chat messages
 */
function toChatMessages(input: any): any[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  const messages: any[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || '',
            type: 'function',
            function: {
              name: item.name || '',
              arguments:
                typeof item.arguments === 'string'
                  ? item.arguments
                  : JSON.stringify(item.arguments ?? {}),
            },
          },
        ],
      })
      continue
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || '',
        content:
          typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      })
      continue
    }
    const role = item.role
    if (role === 'user' || role === 'assistant' || role === 'system' || role === 'developer') {
      // developer 是 Responses 对 system 的另一种叫法; chat 侧没有该角色.
      messages.push({
        role: role === 'developer' ? 'system' : role,
        content: contentText(item.content),
      })
    }
  }
  return messages
}

/**
 * 把 Responses 请求翻成 chat 请求体.
 *
 * 不在这里做工具承载: 出站打包由 buildForwardBody 统一负责, 它认的是 chat 形态.
 *
 * @param {any} body Responses 请求体
 * @returns {ChatFromResponses} chat 请求体与原始请求
 */
export function chatRequestFromResponses(body: any): ChatFromResponses {
  const messages = toChatMessages(body?.input)
  const tools = toChatTools(body?.tools)
  const stream = body?.stream !== false
  const chat: any = {
    model: body?.model,
    messages,
    ...(tools.length ? { tools } : {}),
    stream,
  }
  // 逐项搬运可选字段: name 值相同才搬, 不做别名猜测.
  for (const [from, to] of [
    ['temperature', 'temperature'],
    ['top_p', 'top_p'],
    ['max_output_tokens', 'max_tokens'],
    ['tool_choice', 'tool_choice'],
    ['parallel_tool_calls', 'parallel_tool_calls'],
  ]) {
    if (body?.[from] !== undefined) chat[to] = body[from]
  }
  if (typeof body?.instructions === 'string' && body.instructions) {
    chat.messages = [{ role: 'system', content: body.instructions }, ...messages]
  }
  return { body: chat, original: body, stream }
}

/**
 * 载体映射在 Responses 面上没有额外含义(打包发生在 chat 形态之后),
 * 保留此签名只为让调用方传参一致.
 *
 * @returns {ToolCarrierPlan | null} 恒为 null
 */
export function noCarrierPlan(): ToolCarrierPlan | null {
  return null
}
