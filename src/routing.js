/**
 * 极简路由（minimal routing）——代理侧实现 dsh-routing-suite 的请求协议。
 *
 * 思路来源：github.com/yjh051108/dsh-routing-suite（dsh-router-standard preset，
 * P1-P30 实测）。核心结论：同一个模型的行为不是连续的——persona 轴会坍缩成
 * 三个稳定区（spec 计划-集体 / react 执行-个体 / 中间是陷阱），而 persona 是
 * 主导触发条件（一句话之差即可翻转轨迹）；首轮「极简条件」最接近训练分布，
 * 性能最高。套件在客户端（DSH 侧）注入 persona + 首轮核心工具面 + 近距离引导，
 * 但当流量经过翻译/反向代理链时这些注入可能被改写或丢弃。本模块把同一套协议
 * 下沉到代理层：开关打开后，代理在转发前改写请求——
 *
 * 1. persona：在最前面注入与任务匹配的极简 persona（spec/react/weak 三档，
 *    按模型选 persona：Pro=spec 句，Flash=neutral+classify）。
 * 2. 首轮工具面：历史里还没有 assistant tool_calls 时，把工具裁剪到该模式的
 *    核心工具集（spec 读优先 / react 写优先）+ shell；首个工具调用后放行全部。
 * 3. 近距离引导：weak 模式下在最后一个用户消息后追加固定引导文本
 *    （简单任务快速收敛 / 复杂任务深度收敛），固定文本保持缓存命中。
 *
 * 零依赖、纯函数，与 free-mode.js 的 free-mode 门禁兼容：
 * 新 system 消息以 FREEBUFF_SYSTEM_OPENING 开头，满足上游 free_mode 检查。
 */

import { FREEBUFF_SYSTEM_OPENING, FREEBUFF_SIGNATURE_TOOL_NAME } from './free-mode.js'

/** 三行为带 + weak 内部路由（数值接口与套件一致）。 */
export const MODE_SPEC = 0
export const MODE_REACT = 1
export const MODE_WEAK = 'weak'

/* persona（与 dsh-router-standard router-core.mjs 逐字一致） */
export const SPEC_PERSONA = 'You are a helpful software engineer assistant.'

export const MIXED_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Work directly: prefer writing or editing code over describing plans. '
  + 'Verify your changes by reading and running them.'

export const REACT_PERSONA =
  'You are a hands-on software engineer who delivers working output fast.\n'
  + 'Work directly: write or edit code, then verify it by reading and running. '
  + 'Keep the loop tight — produce, verify, fix — and do not build test '
  + 'harnesses, scaffolding, or ceremony the user did not ask for. '
  + 'Finish with a usable deliverable and a short summary.'

/** weak（内部路由）persona——按模型选最优（P11/P24）：Pro=spec 句+分类；Flash=neutral+分类+防跑偏。 */
export const WEAK_PRO =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.'

export const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.'

/** 近距离引导（weak 模式，P14/P16/P17/P19/P20）：简单任务快速收敛；复杂任务深度收敛。 */
export const GUIDE_WEAK =
  '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'

export const GUIDE_DEEP =
  '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'

/**
 * We/Let's 集体思维链锚定（spec 模式）。
 * 实测 spec 盆地 = 计划-集体轨迹（We / Let's，let me ≈ 0，P1-P30）；P15 显示
 * 语域会自回归自锚定（区分度 0→+2.0 反衰减），P22 提醒"锚定应是提醒，不是格式
 * 要求"。因此以一句轻量提醒缀在 spec persona 后，把 we/let's 链稳定地"链化"出来，
 * 而不强制首 token 格式。
 *
 * Pro（P11 实测）：远距 persona 锚定即生效（we=7~12, let me≈0）。
 * Flash（P11 + 本项目实测）：远距锚定反噬（we 9→0）；必须用**近距离** user 消息
 * 注入 + 首 token We 自锚定（P15）才链化成功（工具化多轮会话 we=11, let's=4~5,
 * let me=0，跨轮保持）。
 */
export const WE_CHAIN_ANCHOR =
  "Plan and reason collectively: use first-person plural (we / let's)."

/** Flash 专用：近距注入 + 首 token We 自锚定（P15：自回归一致性把语域越锚越牢）。 */
export const WE_CHAIN_ANCHOR_FLASH =
  `${WE_CHAIN_ANCHOR} Begin your reasoning with "We".`

/** 复杂度启发式：长任务或架构词任务 = 复杂（深度引导）。 */
const COMPLEX_RE =
  /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

const REACT_RE =
  /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi

const SPEC_RE =
  /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi

/** True when the routed model id is a Flash-family model. */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/** 复杂度启发式：长文本或架构类关键词 → 复杂任务。 */
export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

/** 量化为行为带：spec [0,0.2) / transition [0.2,0.5) / react [0.5,1]；weak 单独。 */
export function bandOf(mode) {
  if (mode === 'weak') return 'weak'
  const m = Math.min(1, Math.max(0, Number(mode) || 0))
  if (m < 0.2) return 'spec'
  if (m < 0.5) return 'transition'
  return 'react'
}

/** 按模式 + 模型选 persona。 */
export function personaFor(mode, modelId) {
  switch (bandOf(mode)) {
    case 'spec':
      return SPEC_PERSONA
    case 'transition':
      return MIXED_PERSONA
    case 'weak':
      return isFlashModel(modelId) ? WEAK_FLASH : WEAK_PRO
    default:
      return REACT_PERSONA
  }
}

/** 首轮核心工具面（shell 由调用方按实际目录补上）。 */
export function coreFor(mode) {
  switch (bandOf(mode)) {
    case 'spec':
      return ['read', 'edit', 'glob', 'grep'] // read-first
    case 'transition':
      return ['read', 'edit', 'write', 'glob', 'grep'] // union
    default:
      return ['read', 'write', 'edit'] // write-first
  }
}

function countHits(regex, text) {
  return [...text.matchAll(regex)].length
}

/**
 * 任务分类：明确关键词选稳定带（1 react / 0 spec）；模糊或未命中 → 'weak'
 * （内部路由，模型每任务自分类，P11 最优域）。
 * @param {string} text
 * @returns {number | 'weak'}
 */
export function classifyTask(text) {
  if (typeof text !== 'string') return 'weak'
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return 1
  if (spec > react) return 0
  return 'weak'
}

/** 提取消息文本（string 或 content 块数组）。 */
function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text
        }
        return ''
      })
      .join(' ')
  }
  return ''
}

/**
 * 解析路由模式：风格钉死（spec/react/weak）优先，否则按任务自动分类。
 * @param {string | null | undefined} override 'auto' | 'spec' | 'react' | 'weak'
 * @param {string} firstUserText
 * @returns {number | 'weak'}
 */
export function resolveMode(override, firstUserText) {
  if (override === 'spec') return 0
  if (override === 'react') return 1
  if (override === 'weak') return 'weak'
  return classifyTask(firstUserText)
}

/**
 * 对 chat/completions 请求应用极简路由改写（仅当开关打开时由 proxy.js 调用）。
 *
 * 改写规则：
 * - 在最前面注入一条 system 消息：`FREEBUFF_SYSTEM_OPENING + persona`
 *   （persona 位于请求最前 = 套件 order 0；开头保持 free-mode 门禁标记）。
 *   spec 模式（含钉死 spec 与自动分类命中 spec）会缀上 WE_CHAIN_ANCHOR，
 *   把 we/let's 集体思维链稳定"链化"出来。
 * - 历史里尚无 assistant tool_calls 时，把 tools 裁剪到 coreFor(mode) + shell
 *   + end_turn 签名工具；已有工具调用 → 放行全部工具（首轮锚定后不再干预）。
 *   **工具保证**：客户端给了工具就绝不裁空——核心集裁剪后为空则保留原工具集，
 *   保证模型始终可调用工具；end_turn（Freebuff 特殊签名工具，保住请求模型/
 *   额度）始终保留。
 * - weak 模式：最后一个消息是用户消息时，在其后追加一条固定引导（复杂任务
 *   用深度引导），实现近距离（near-field）路由。
 *
 * 其余字段（model/stream/thinking/reasoning/codebuff_metadata 等）不动。
 *
 * @param {Record<string, any>} body 客户端请求体
 * @param {string} modelId 上游模型 id（用于按模型选 persona）
 * @param {{ modeOverride?: string | null }} [opts] modeOverride: 'auto'|'spec'|'react'|'weak'
 * @returns {Record<string, any>} 改写后的请求体
 */
export function applyMinimalRouting(body, modelId, opts = {}) {
  if (!body || typeof body !== 'object') return body
  const messages = Array.isArray(body.messages) ? body.messages.map((m) => ({ ...m })) : []

  // 会话首个有文本的用户消息 = 任务（无状态请求自带全量历史，与套件 sessionMode 同源）
  const firstUserText = messages
    .filter((m) => m && m.role === 'user')
    .map(messageText)
    .find((t) => t.trim().length > 0)
  const mode = resolveMode(opts?.modeOverride || null, firstUserText)
  const isFlash = isFlashModel(modelId)
  let persona = personaFor(mode, modelId)
  // spec 盆地 = we/let's 集体链：
  // - Pro：远距 persona 锚定即生效（we=7~12，let me≈0）；
  // - Flash：远距锚定反噬（P11 + 实测 we 9→0），system 里保持纯 spec 句，改由
  //   近距离 user 消息 + 首 token We 锚定（见下方 near-field 注入）。
  if (bandOf(mode) === 'spec' && !isFlash) {
    persona = `${persona}\n${WE_CHAIN_ANCHOR}`
  }

  // 1) persona 置顶（free-mode 门禁标记保留在最前）
  const personaSystem = {
    role: 'system',
    content: `${FREEBUFF_SYSTEM_OPENING}\n\n${persona}`,
  }
  const routed = [personaSystem, ...messages]

  // 2) 首轮工具面：已有 assistant tool_calls 的历史 → 放行全部；否则裁剪到核心集。
  //    裁剪后为空（客户端工具全是非常规名）→ 保留原工具集，保证模型可调用工具。
  const tools = Array.isArray(body.tools) ? body.tools : []
  let routedTools = tools
  if (tools.length > 0) {
    const hasToolCalls = messages.some(
      (m) =>
        m &&
        m.role === 'assistant' &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0,
    )
    if (!hasToolCalls) {
      const core = new Set(coreFor(mode))
      // shell 按实际目录保留；end_turn 特殊签名工具必须保留（上游凭它保留请求
      // 模型/额度；proxy.js 的 ensureFreebuffToolSignature 还会在末尾兜底追加）
      for (const t of tools) {
        const name = t && t.function ? t.function.name : null
        if (name === 'bash' || name === 'pwsh' || name === FREEBUFF_SIGNATURE_TOOL_NAME) {
          core.add(name)
        }
      }
      const filtered = tools.filter((t) => {
        const name = t && t.function ? t.function.name : null
        return name !== null && core.has(name)
      })
      routedTools = filtered.length > 0 ? filtered : tools
    }
  }

  // 3) near-field 引导：仅当最后一个消息是（有文本的）用户消息时追加，避免插在
  //    assistant tool_calls 与 tool 结果之间破坏协议配对。
  //    - weak 模式：固定路由引导（简单任务快速收敛 / 复杂任务深度收敛）；
  //    - flash + spec：we/let's 集体链近距锚定（首 token We 自锚定，P14/P15）。
  let routedMessages = routed
  const flashSpecAnchor = isFlash && bandOf(mode) === 'spec' ? WE_CHAIN_ANCHOR_FLASH : null
  if (bandOf(mode) === 'weak' || flashSpecAnchor) {
    const lastIdx = routedMessages.length - 1
    const last = routedMessages[lastIdx]
    if (last && last.role === 'user' && messageText(last).trim().length > 0) {
      const guide = flashSpecAnchor || (isComplexTask(messageText(last)) ? GUIDE_DEEP : GUIDE_WEAK)
      routedMessages = [
        ...routedMessages,
        { role: 'user', content: guide },
      ]
    }
  }

  return { ...body, messages: routedMessages, tools: routedTools }
}
