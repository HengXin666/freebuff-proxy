/**
 * 上游 MCP 工具名形态的本地镜像 -- 单一真源.
 *
 * 内容取自官方 orchestrator.js 的两处 (2026-10-05 取):
 *   - mcp-constants.ts / mcp.ts (第 105342-105352 行): 分隔符与暴露名规则
 *   - getMCPToolData (第 105356 行): 重名冲突时 hash 后缀与 mcpOrigin 回填
 *
 * 用途: 把下游客户端声明的 (上游官方工具集里没有等价物) 工具, 以官方本来
 * 就支持的形态承载出去; 回程再按 mcpOrigin 拆包还原成下游认识的名字.
 *
 * 官方 protocol 侧真值 (customToolDefinitionsSchema, orchestrator.js:109672)
 * 与出站 wire 的关系见 .agents/notes/implemented/architecture/
 * 2026-10-05-third-party-tool-carrier.md: 该字段在本地 session 状态里,
 * 展开进 tools 才上 wire, 所以本地这一层只做名字形态与搬运.
 *
 * 上游改规则后必须回来重对. 本地不算判定权, 判据永远在上游.
 */

import { createHash } from 'node:crypto'

/** MCP 工具名分隔符 (上游 mcp-constants.ts MCP_TOOL_SEPARATOR). */
export const MCP_TOOL_SEPARATOR = '__'

/** 上游校验的严格工具名形态: 1..64 个字母数字下划线连字符. */
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** 上游宽松校验的旧形态 (1..128): 先按它原样放行, 不做裁剪. */
const LEGACY_VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/

/**
 * 承载下游私有工具时使用的 server 名.
 *
 * 上游按 mcpOrigin.server 记账; 这里固定一个不属于任何真实 MCP server 的
 * 名字, 让[这是代理搬运的下游工具]在 wire 上可辨识.
 */
export const MCP_CARRIER_SERVER = 'proxy'

/**
 * 合成官方形态的 MCP 暴露工具名 -- 与上游 mcpExposedToolName 同义.
 *
 * 规则逐字对齐: 宽松校验通过则原样返回 server 加分隔符加 tool; 否则把非法
 * 字符换成下划线, 仍不通过严格校验则截 55 字符并追加 sha256 前 8 位.
 *
 * @param {string} server MCP server 名
 * @param {string} tool 工具名
 * @returns {string} 暴露给模型的工具名
 */
export function mcpExposedToolName(server: string, tool: string): string {
  const raw = server + MCP_TOOL_SEPARATOR + tool
  if (LEGACY_VALID_TOOL_NAME.test(raw)) return raw
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (VALID_TOOL_NAME.test(cleaned)) return cleaned
  return `${cleaned.slice(0, 55)}_${sha256Hex8(raw)}`
}

/**
 * 十六进制 sha256 的前 8 位 -- 与上游 createHash 用法同义.
 *
 * @param {string} text 输入
 * @returns {string} 8 个十六进制字符
 */
function sha256Hex8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/**
 * 把下游工具的函数定义归一成上游能收的入参 schema.
 *
 * 下游给的是 OpenAI 形态 parameters (JSON Schema); 缺失或不是对象时给空对象
 * schema. 上游 processCustomToolDefinitions 会对它做 toJSONSchema, 传非法值
 * 会让整条请求体构造失败 (整次 chat 直接报错, 不是单个工具失效).
 *
 * @param {any} fn OpenAI 形态的 function 定义
 * @returns {any} JSON Schema
 */
export function toolInputSchema(fn: any): any {
  const p = fn?.parameters
  if (p && typeof p === 'object' && !Array.isArray(p)) return p
  return { type: 'object', properties: {} }
}
