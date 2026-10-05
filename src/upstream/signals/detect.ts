/**
 - 外来客户端判据的判定实现  --  schema 校验与 detectForeignClient.
 *
 * 为什么单独成文件: 原 foreign-client-signals.ts 465 行超 300 红线. 它里有两类
 * 东西: 上游那份判据源码的[本地镜像](一大柜常量: 工具名分组, 官方参数名表,
 * 零参数工具描述, 双向映射表)与基于这些常量做的判定实现. 前者是照抄上游的
 * 数据, 后者是本仓的逻辑; 两者的审查方式完全不同(前者要逐字对账, 后者要跑用例).
 *
 * 边界: 常量仍留在 ../foreign-client-signals.ts  --  那里同时是外部消费者与
 * test/suites/entries/verify/tool-name-mapping.ts 的 import 点, 且它的逐字对账
 * 判据按该路径核对. 本文件只 import, 不复制任何常量.
 *
 * 本地只把它用于可观测性与[该注入什么签名工具]----判定权永远在上游.
 */
import {
  FOREIGN_HARNESS_PROMPT_MARKERS,
  FOREIGN_HARNESS_TOOL_NAMES,
  FREEBUFF_CUSTOM_TOOL_NAMES,
  FREEBUFF_SIGNATURE_TOOL_NAMES,
  OFFICIAL_TOOL_PARAMETER_KEYS,
  OFFICIAL_ZERO_PARAM_TOOL_DESCRIPTIONS,
} from '../foreign-client-signals.ts'

/**
 - 一个 JSON-Schema 的顶层属性名集合;不是对象 schema(缺失 / 字符串 / 数组)时返回 null.
 - 与上游 schemaPropertyKeys 同义:读 properties,并递归并入 anyOf / oneOf / allOf
 - 各分支的 properties(z.toJSONSchema 对联合类型产出的就是这个形状).
 - @param {unknown} schema JSON-Schema
 - @returns {Set<string> | null} 顶层属性名集合;非对象 schema 返回 null
 */
export function schemaPropertyKeys(schema: any) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return null
  }
  const keys = new Set()
  const record = /** @type {Record<string, unknown>} */ (schema)
  const properties = record.properties
  if (typeof properties === 'object' && properties !== null) {
    for (const key of Object.keys(properties)) keys.add(key)
  }
  for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
    const branches = record[combinator]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) {
      for (const key of schemaPropertyKeys(branch) || []) keys.add(key)
    }
  }
  return keys
}

/**
 - 送来的工具是不是[货真价实的]官方签名工具(上游 isGenuineSignatureTool 同义).
 *
 - 三种情形:
 - - 自定义名(decide):官方没有 schema 可比,按名字放行.
 - - 官方定义且有参数:schema 非空,且顶层参数名是官方参数名的子集.
 - - 官方定义但无参数(end_turn / task_completed):永远不算 ---- 复制的名字
 - 加 {} 与真货逐字节相同,没有结构可验证,官方不接受,我们也别指望它能过.
 *
 - @param {{ name?: unknown, parameters?: unknown }} tool 待判工具
 - @returns {boolean} 是真签名工具为真
 */
export function isGenuineSignatureTool(tool: any) {
  const name = tool && typeof tool.name === 'string' ? tool.name : ''
  if (!FREEBUFF_SIGNATURE_TOOL_NAMES.includes(name)) return false
  if (FREEBUFF_CUSTOM_TOOL_NAMES.includes(name)) return true
  const ours = OFFICIAL_TOOL_PARAMETER_KEYS[name]
  if (!ours || ours.length === 0) return false
  const theirs = schemaPropertyKeys(tool.parameters)
  if (!theirs || theirs.size === 0) return false
  for (const key of theirs) {
    if (!ours.includes(key)) return false
  }
  return true
}

/**
 - 顶着官方签名名字,却不是官方东西的[洗白形态]----只用于日志/可观测性,
 - 不参与任何判定(上游也是这么用的).零参数工具官方无法背书,于是退而看描述;
 - 也正因为它只喂日志,官方才不强制它,落后一个版本的官方客户端也不会因此被罚.
 *
 - @param {{ name?: unknown, parameters?: unknown }} tool 待判工具
 - @returns {boolean} 是空心签名为真
 */
export function isHollowSignatureTool(tool: any) {
  const name = tool && typeof tool.name === 'string' ? tool.name : ''
  if (!FREEBUFF_SIGNATURE_TOOL_NAMES.includes(name)) return false
  if (FREEBUFF_CUSTOM_TOOL_NAMES.includes(name)) return false
  const ours = OFFICIAL_TOOL_PARAMETER_KEYS[name]
  if (!ours) return false
  // 有参数的工具:不是真货就是空心.
  if (ours.length > 0) return !isGenuineSignatureTool(tool)
  // 零参数工具:没有结构可校验,退而比对描述 ---- 这正是代理注入的空心 end_turn
  // 会露馅的地方(上游夹具 PROXY_HOLLOW_END_TURN 用的就是这一句).
  const shipped = OFFICIAL_ZERO_PARAM_TOOL_DESCRIPTIONS[name]
  if (typeof shipped !== 'string') return false
  const got = tool.description
  return typeof got !== 'string' || got.trim() !== shipped.trim()
}

/**
 - 从 OpenAI 形状的 tools 数组读出 { name, parameters }.
 - @param {unknown} tools OpenAI 形状的 tools
 - @returns {Array<{ name: string, parameters?: unknown, description?: unknown }>} 归一后的工具列表
 */
export function readOfferedTools(tools: any) {
  if (!Array.isArray(tools)) return []
  const offered = []
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue
    const fn = /** @type {any} */ (tool).function
    if (typeof fn?.name !== 'string') continue
    offered.push({ name: fn.name, parameters: fn.parameters, description: fn.description })
  }
  return offered
}

/**
 - 任一 system 消息里的外来 harness 身份标记;取不到返回 null.
 - 只看 system 角色 ---- 用户把 Claude Code 的记录粘进对话里绝不该被判外来.
 - @param {unknown} messages 请求消息数组
 - @returns {string | null} 命中的标记;没有返回 null
 */
export function findForeignHarnessPromptMarker(messages: any) {
  if (!Array.isArray(messages)) return null
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const { role, content } = /** @type {any} */ (message)
    if (role !== 'system') continue
    const texts = []
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        const text =
          typeof part === 'object' && part !== null
            ? /** @type {any} */ (part).text
            : undefined
        if (typeof text === 'string') texts.push(text)
      }
    }
    for (const text of texts) {
      for (const marker of FOREIGN_HARNESS_PROMPT_MARKERS) {
        if (text.includes(marker)) return marker
      }
    }
  }
  return null
}

/**
 - 上游 detectForeignFreebuffClient 的同义实现:判断一个 free-mode 请求是不是来自
 - 别人的客户端.本地只用于可观测性(日志 + 响应头),判定权永远在上游;
 - 与上游保持同义,是为了让[正在被降级]在出问题时能被看见.
 *
 - 顺序本身就是安全故事(与上游一致):外来工具名 / system 身份标记压倒一切 ----
 - 带了官方真工具也照样判外来;之后[带了工具就必须有一个真签名].无工具时的两个
 - 信号上游只报不罚,这里同样只报.
 *
 - @param {{ tools?: unknown, messages?: unknown, temperature?: unknown,
 -   top_p?: unknown, max_tokens?: unknown }} body 请求体
 - @param {boolean} [isRootAgent] 是否 root agent
 - @returns {{ signal: string | null, toolCount: number, sampleToolNames: string[],
 -   hollowToolNames: string[], foreignToolNames: string[] }} 判定结果与证据
 */
export function detectForeignClient(body: any, isRootAgent = false) {
  const offered = readOfferedTools(body?.tools)
  const sampleToolNames = offered.slice(0, 8).map((t) => t.name.slice(0, 64))
  const hollowToolNames = offered
    .filter(isHollowSignatureTool)
    .slice(0, 8)
    .map((t) => t.name.slice(0, 64))
  const foreignToolNames = offered
    .filter((t) => FOREIGN_HARNESS_TOOL_NAMES.has(t.name))
    .slice(0, 8)
    .map((t) => t.name.slice(0, 64))
  const evidence = {
    toolCount: offered.length,
    sampleToolNames,
    hollowToolNames,
    foreignToolNames,
  }
  if (foreignToolNames.length > 0) {
    return { signal: 'foreign_tool_names', ...evidence }
  }
  if (findForeignHarnessPromptMarker(body?.messages) !== null) {
    return { signal: 'foreign_system_prompt', ...evidence }
  }
  if (offered.length > 0) {
    const hasSignature = offered.some(isGenuineSignatureTool)
    return { signal: hasSignature ? null : 'foreign_toolset', ...evidence }
  }
  if (isRootAgent) return { signal: 'root_agent_no_tools', ...evidence }
  if (
    body &&
    (body.temperature !== undefined ||
      body.top_p !== undefined ||
      body.max_tokens !== undefined)
  ) {
    return { signal: 'sampling_params', ...evidence }
  }
  return { signal: null, ...evidence }
}

/** 上游会据此降级的信号(其余只报不罚). */
export const ENFORCED_FOREIGN_SIGNALS = Object.freeze([
  'foreign_toolset',
  'foreign_tool_names',
  'foreign_system_prompt',
])

/**
 - 我们注入的官方签名工具 ---- 按上游判据逐字构造.
 *
 - 为什么不是补一个空心 end_turn:上游 2026-09-17 起要求签名工具[名字 + 真实参数
 - schema]双真,零参数工具永远不算签名;上游还把[往 tools 末尾补空心 end_turn]
 - 这种形态逐字收进测试夹具(PROXY_HOLLOW_END_TURN)并在注释里点名 freebuff-proxy.
 *
 - 两个都带,任一通过即可(上游是 some()):decide 走自定义名放行,
 - lookup_agent_info 走真实 schema 子集 ---- 任一条规则变化,都还有另一条兜住.
 *
 - description 故意写成[别调用]:上游对有参数的工具只比对 schema,不比对描述
 - (描述只在零参数工具上用于日志),所以这里可以自由取舍;而一个真诚邀请模型调用的
 - 描述,会让模型真的去调一个下游客户端根本不认识的名字.
 */
export const FREEBUFF_SIGNATURE_TOOL_DEFINITIONS = Object.freeze([
  // 首位 = 主签名:带真实参数 schema,走上游的[schema 子集]判定.
  // 排在首位是因为它承载结构证据,而 decide 只是名字层面的兜底.
  Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: 'lookup_agent_info',
      description: 'Protocol compatibility marker. Do not call this function.',
      parameters: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          agentId: Object.freeze({
            type: 'string',
            description: 'Agent ID (short local or full published format)',
          }),
        }),
        required: Object.freeze(['agentId']),
        description: 'Retrieve information about an agent by ID',
      }),
    }),
  }),
  // 兜底 = 官方自定义工具名(上游对自定义名不查 schema).
  Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: 'decide',
      description: 'Protocol compatibility marker. Do not call this function.',
      parameters: Object.freeze({ type: 'object', properties: Object.freeze({}) }),
    }),
  }),
])
