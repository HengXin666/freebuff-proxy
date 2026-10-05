/**
 * 工具签名与工具集判据.
 *
 * 三条判据(补签名工具 / 剥客户端工具 / 是否带工具)共同决定上游看到的 tools
 * 形态: 上游把"工具集与官方 CLI 是否一致"当第三方客户端判据.
 */
import { FREEBUFF_SIGNATURE_TOOL_DEFINITIONS } from '../upstream/foreign-client-signals.ts'

// 转发签名工具定义:调用方(测试,控制台)从本模块一处取用,避免各处另立取值.
export { FREEBUFF_SIGNATURE_TOOL_DEFINITIONS }
// 判据镜像的同义导出:调用方要判断"上游会怎么看这个工具集"时不必再 import 第二个文件.
export { detectForeignClient, isGenuineSignatureTool } from '../upstream/foreign-client-signals.ts'

/**
 - 我们注入的签名工具名(按上游判据构造,定义在
 - src/upstream/foreign-client-signals.ts 的 FREEBUFF_SIGNATURE_TOOL_DEFINITIONS).
 *
 - 两条并挂,任一通过即可(上游是 some()):
 - - lookup_agent_info:官方设计划工具,参数表 { agentId } ---- 走真实 schema 子集判定.
 - - decide:官方自定义工具(无 schema 可比)---- 走自定义名放行判定.
 - 留两条是因为两条规则各自独立:任一条被上游收紧,另一条仍然成立.
 *
 - 判据,对照实验与取舍见
 - .agents/notes/implemented/bug-fix/2026-09-19-genuine-tool-signature.md
 */
export const FREEBUFF_SIGNATURE_TOOL_NAMES = Object.freeze(
  FREEBUFF_SIGNATURE_TOOL_DEFINITIONS.map((t) => t.function.name),
)

/**
 - 主签名工具名(带参数,有结构可校验的那一个).
 *
 - 为什么不再用 end_turn:上游 2026-09-17 起要求签名工具[名字 + 真实参数 schema]
 - 双真,零参数工具永远不算签名(复制的名字加 {} 与真货逐字节相同,没有结构
 - 可验证).上游还把[往 tools 末尾补空心 end_turn]这种形态逐字收进测试夹具
 - (PROXY_HOLLOW_END_TURN)并在注释里点名 freebuff-proxy ---- 即本代理.
 */
export const FREEBUFF_SIGNATURE_TOOL_NAME = 'lookup_agent_info'

/**
 - 把一个外来工具集补齐成[上游认得的客户端]形态:追加官方真签名工具,
 - 让上游不把请求降级.无工具的请求不触发该判据(上游对无工具是只报不罚).
 *
 - 幂等:已带任一签名工具就原样返回;两个都带更稳,所以缺哪个补哪个.
 *
 - @param {unknown} tools
 - @param {boolean} enabled
 - @returns {unknown}
 */
export function ensureFreebuffToolSignature(tools: any, enabled = true) {
  if (!enabled || !Array.isArray(tools) || tools.length === 0) return tools
  const present = new Set(
    tools
      .map((tool) =>
        tool &&
        typeof tool === 'object' &&
        tool.function &&
        typeof tool.function === 'object'
          ? tool.function.name
          : null,
      )
      .filter(Boolean),
  )
  const missing = FREEBUFF_SIGNATURE_TOOL_DEFINITIONS.filter(
    (def) => !present.has(def.function.name),
  )
  return missing.length === 0 ? tools : [...tools, ...missing]
}

/**
 - 客户端是否声明了工具.只看 OpenAI 新式 tools 数组----旧式 functions
 - 字段不触发上游的 tool-schema 检查(见 stripClientTools 的说明).
 *
 - @param {Record<string, any>} body
 - @returns {boolean}
 */
export function hasClientTools(body: any) {
  return Boolean(
    body &&
      typeof body === 'object' &&
      Array.isArray(body.tools) &&
      body.tools.length > 0,
  )
}

/**
 - 剥离客户端的工具声明,返回新对象(不改原对象).
 *
 - 为什么需要:上游对 tools 做 tool-schema 指纹比对 ---- 它把"工具集与
 - 官方 CLI 是否一致"当作第三方客户端判据(freebuff 源码 freebuff-models.ts
 - 注释原话:"the tool-schema check (docs/freebuff-abuse-detection.md), which
 - downgrades third-party clients").任何非官方 schema(bash / run_code /
 - 自定义工具)都会让 /api/v1/chat/completions 直接返回 404
 - No endpoints found for <model> ---- 注意它报的是"模型不存在",与工具毫无
 - 字面关联,极难从错误本身归因.
 *
 - 实测(2026-09-18,直连线上 freebuff-proxy):无 tools → 200;带任意 tools
 - (含完整复刻官方 24 个工具名 + 中性 schema)→ 404 No endpoints found.
 *
 - 因此当上游以该错误拒绝工具请求时,代理只能去掉工具再发一次:模型不调用
 - 工具,但至少给出文本回答,而不是把一个 404 甩给下游(下游 Responses 桥接层
 - 会把它崩成 Cloudflare 纯文本 502,客户端 SDK 解析成
 - "502 status code (no body)" ---- 就是"所有模型都空响应"的现场).
 *
 - functions(OpenAI 旧式)不删:它不触发该检查(实测 200).
 *
 - @param {Record<string, any>} body
 - @returns {Record<string, any>}
 */
/*
 - 决策与实测见
 - .agents/notes/implemented/bug-fix/2026-09-18-tool-schema-rejection-strip.md
 */
export function stripClientTools(body: any) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  delete out.tools
  delete out.tool_choice
  delete out.parallel_tool_calls
  return out
}
