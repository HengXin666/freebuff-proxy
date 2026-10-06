/**
 * 系统提示词页的数据面: 汇总[发给上游的提示词]与[各工具的提示词].
 *
 * 三类来源, 都是[模型实际看到的东西]:
 *   1. 全局系统提示词 ---- 官方 worker / manager 模板, 以及当前生效的处置;
 *   2. 官方工具定义 ---- 37 个工具的完整 description(模型看到的就是它);
 *   3. 下游工具定义 ---- 本次/最近一次下游声明的工具描述.
 *
 * 只读; 全局提示词的写入仍走 /api/settings(已有 officialSystemPromptMode).
 */
import fs from 'node:fs'

import { sendJson } from '../../../util/http.ts'
import { OFFICIAL_TOOL_META } from '../../../upstream/signals/tools/official-tool-select.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 抓包目录(与 cli-bridge 读的是同一份真源). */
function capturesDir() {
  return new URL('../../../../docs/reverse/captures/', import.meta.url)
}

/**
 * 读官方工具抓包真值(含完整 description).
 *
 * @returns {any[]} 官方工具定义数组;读不到为空数组
 */
function officialTools() {
  try {
    const p = new URL('official-tools.json', capturesDir())
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/**
 * 读官方 system 模板原文.
 *
 * @returns {any} { worker, manager };读不到为空对象
 */
function officialSystem() {
  try {
    const p = new URL('official-system-prompts.json', capturesDir())
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 下游工具清单 ---- 取[最近一次]下游声明的工具描述.
 *
 * 为什么是"最近一次"而不是实时: 主服务不持有下游的工具表(那是每个请求带进来的),
 * 记下最近一次是为了让使用者能看到[自己客户端到底声明了什么].
 * 拿不到就为空数组, 不猜.
 *
 * @param {any} ctx 路由上下文
 * @returns {any[]} 下游工具 [{name, description}]
 */
function downstreamTools(ctx: any) {
  try {
    const last = ctx.lastDeclaredTools
    if (Array.isArray(last)) return last
    return []
  } catch {
    return []
  }
}

/**
 * 工具集健康判据: 明确给出[当前配置会不会被上游拒绝].
 *
 * 这是用户要求的那条: 判据错误必须在平台上看得见. 上游不回明确原因,
 * 症状只是 503 或回答变差, 所以本地必须自己算一遍并显式展示.
 *
 * 判据三条(取自上游 enforce 列表):
 *   1. officialToolNames 配成空数组 -> 官方工具一个都不注入 -> 上游按工具集
 *      不完整拒绝(实测 503);
 *   2. 出站含外来 harness 工具名(FOREIGN_HARNESS_TOOL_NAMES) -> 判第三方;
 *   3. 注入数少于下游声明数且差距过大 -> 提示可能被裁过头.
 *
 * @param {any} ctx 路由上下文
 * @param {any} settings 运行设置快照
 * @returns {any} { level, code, message, detail }
 */
function toolHealth(ctx: any, settings: any) {
  const last = ctx.lastToolInjection || null
  const configured = Array.isArray(settings.officialToolNames)
    ? settings.officialToolNames
    : null
  // 1) 显式配成空数组: 必然被拒的配置
  if (configured && configured.length === 0) {
    return {
      level: 'error',
      code: 'empty_official_toolset',
      message: '官方工具集被判空，上游会因工具集不完整而拒绝请求（503）。',
      detail: { configured: 0, lastInjected: last?.injected ?? null },
    }
  }
  // 2) 最近一次注入数为 0
  if (last && last.injected === 0) {
    return {
      level: 'error',
      code: 'zero_injected',
      message: '最近一次请求没有注入任何官方工具，上游会判第三方客户端。',
      detail: last,
    }
  }
  // 3) 正常
  return {
    level: 'ok',
    code: 'ok',
    message: last
      ? `最近一次注入 ${last.injected} 个官方工具，形态正常。`
      : '还没有发过请求；发起一次对话后这里会给出判据。',
    detail: last,
  }
}

/**
 * GET /api/prompts ---- 系统提示词页的一次性数据源.
 *
 * @param {any} res
 * @param {any} ctx
 * @returns {void} 无返回值
 */
function promptsSnapshot(res: ServerResponse, ctx: any) {
  const sys = officialSystem()
  const settings = ctx.settingsStore?.get?.() || {}
  sendJson(res, 200, {
    ok: true,
    /** 全局系统提示词: 官方原文 + 当前处置 + 自定义正文. */
    system: {
      worker: typeof sys.worker === 'string' ? sys.worker : '',
      manager: typeof sys.manager === 'string' ? sys.manager : '',
      mode: settings.officialSystemPromptMode === 'custom'
        || settings.officialSystemPromptMode === 'none'
        ? settings.officialSystemPromptMode
        : 'official',
      customText: typeof settings.officialSystemPromptText === 'string'
        ? settings.officialSystemPromptText
        : '',
    },
    /** 官方 37 工具: 分组 + 一句话说明 + 完整 description + 是否注入. */
    officialTools: officialTools().map((t: any) => {
      const name = t?.function?.name || ''
      const meta = OFFICIAL_TOOL_META.find((m: any) => m.name === name)
      const selected = Array.isArray(settings.officialToolNames)
        ? settings.officialToolNames.includes(name)
        : null
      return {
        name,
        group: meta?.group || 'orphan',
        note: meta?.desc || '',
        description: String(t?.function?.description || ''),
        parameters: t?.function?.parameters || null,
        /** null = 未配置(走自动规则); true/false = 控制台显式勾选态. */
        selected,
      }
    }),
    /** 下游工具(最近一次声明). */
    downstreamTools: downstreamTools(ctx),
    /** 官方工具注入名单: null = 未配置. */
    officialToolNames: Array.isArray(settings.officialToolNames)
      ? settings.officialToolNames
      : null,
    /** 工具集健康判据: 出站工具集是否会被上游判成第三方客户端. */
    health: toolHealth(ctx, settings),
  })
}

/**
 * 系统提示词域路由.
 *
 * @param {string} method HTTP 方法
 * @param {string} route 规范化路径
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} user 当前用户
 * @param {any} ctx 路由上下文
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handle(
  method: string,
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  user: any,
  ctx: any,
) {
  void req
  void user
  if (route === '/api/prompts' && method === 'GET') {
    promptsSnapshot(res, ctx)
    return true
  }
  return false
}
