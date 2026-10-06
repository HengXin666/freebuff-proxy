/**
 * 出站注入哪些官方工具 -- 单一真源.
 *
 * 为什么需要: 官方 37 工具里有一部分在下游没有任何对应物, 回程无从还原,
 * 模型一旦选中它们, 下游只会报 unknown tool. 哪些名字值得注入由本表的 group
 * 字段决定, 控制台[官方工具]页据此分组渲染成可勾选列表.
 *
 * 分类判据是[下游有没有对应工具], 不是主观的常用程度:
 *   - common: 官方的等价物在下游存在(见 tool-name-map.ts 的 CLIENT_TO_OFFICIAL_TOOL),
 *     回程能还原成下游名并派发. 默认注入.
 *   - orphan: 下游没有对应工具, 回程只能把官方名原样透传, 下游必然报
 *     unknown tool. 默认不注入.
 *
 * 名字集必须与抓包真值 docs/reverse/captures/official-tools.json 逐条一致;
 * 上游改工具集后必须回来重对(test/suites/entries/verify/tool/official-select.ts 有断言).
 *
 * 见 .agents/notes/implemented/feature/2026-10-06-official-tool-injection-selection.md
 */

/** 分类: common 可派发 / orphan 不可派发. */
export type OfficialToolGroup = 'common' | 'orphan'

/** 官方工具的一项元数据. */
export interface OfficialToolMeta {
  /** 官方工具名(wire 上的名字). */
  name: string
  /** 分组: 下游有没有对应工具. */
  group: OfficialToolGroup
  /** 面对使用者的一句话说明(控制台列表显示). */
  desc: string
}

/**
 * 官方 37 工具的元数据表.
 *
 * 顺序按抓包原序, 便于与 official-tools.json 肉眼对账.
 */
export const OFFICIAL_TOOL_META: readonly OfficialToolMeta[] = Object.freeze([
  { name: 'read_files', group: 'common', desc: '读取文件内容, 对应下游 read' },
  { name: 'str_replace', group: 'common', desc: '在文件里替换文本, 对应下游 edit' },
  { name: 'write_file', group: 'common', desc: '写入或新建文件, 对应下游 write' },
  { name: 'run_terminal_command', group: 'common', desc: '执行 shell 命令, 对应下游 bash' },
  { name: 'code_search', group: 'common', desc: '按正则搜索代码, 对应下游 grep 或同名 code_search' },
  { name: 'glob', group: 'common', desc: '按通配符找文件, 对应下游 glob' },
  { name: 'list_directory', group: 'orphan', desc: '列出目录内容, 下游没有对应工具' },
  { name: 'write_todos', group: 'common', desc: '写待办清单, 对应下游 todo_write' },
  { name: 'run_file_change_hooks', group: 'orphan', desc: '触发客户端的文件变更钩子, 下游没有' },
  { name: 'end_turn', group: 'orphan', desc: '把控制权交回用户, 下游没有对应工具' },
  { name: 'web_search', group: 'common', desc: '联网搜索, 对应下游 web_search' },
  { name: 'read_url', group: 'common', desc: '抓取网页正文, 对应下游 web_fetch' },
  { name: 'report_project_profile', group: 'orphan', desc: '上报项目画像, 下游没有' },
  { name: 'suggest_prompts', group: 'orphan', desc: '给出后续提问建议卡片, 下游没有' },
  { name: 'ask_questions', group: 'common', desc: '向用户提问并等回答, 对应下游 ask_user_question' },
  { name: 'read_thread_context', group: 'orphan', desc: '读取另一个会话的上下文, 下游没有' },
  { name: 'request_elevation', group: 'orphan', desc: '申请管理员权限执行命令, 下游没有' },
  { name: 'register_preview', group: 'orphan', desc: '注册本地预览页, 下游没有' },
  { name: 'preview_open', group: 'orphan', desc: '打开浏览器标签页, 下游没有' },
  { name: 'preview_status', group: 'orphan', desc: '列出浏览器标签页, 下游没有' },
  { name: 'preview_close', group: 'orphan', desc: '关闭浏览器标签页, 下游没有' },
  { name: 'preview_press', group: 'orphan', desc: '在页面里按键, 下游没有' },
  { name: 'preview_scroll', group: 'orphan', desc: '滚动页面, 下游没有' },
  { name: 'preview_wait', group: 'orphan', desc: '等待页面条件成立, 下游没有' },
  { name: 'preview_resize', group: 'orphan', desc: '调整浏览器视口, 下游没有' },
  { name: 'preview_set_color_scheme', group: 'orphan', desc: '切换页面深浅色, 下游没有' },
  { name: 'preview_recording_start', group: 'orphan', desc: '开始录屏, 下游没有' },
  { name: 'preview_recording_stop', group: 'orphan', desc: '停止录屏, 下游没有' },
  { name: 'preview_snapshot', group: 'orphan', desc: '读页面可访问性树, 下游没有' },
  { name: 'preview_screenshot', group: 'orphan', desc: '截屏, 下游没有' },
  { name: 'preview_click', group: 'orphan', desc: '点击页面元素, 下游没有' },
  { name: 'preview_type', group: 'orphan', desc: '在页面输入文本, 下游没有' },
  { name: 'preview_navigate', group: 'orphan', desc: '页面跳转, 下游没有' },
  { name: 'preview_evaluate', group: 'orphan', desc: '在页面里执行脚本, 下游没有' },
  { name: 'preview_logs', group: 'orphan', desc: '读页面控制台日志, 下游没有' },
  { name: 'browser_check', group: 'orphan', desc: '浏览器自检, 下游没有对应工具' },
  { name: 'write_doc', group: 'orphan', desc: '写文档文件, 下游没有' },
])

/** 官方全部工具名(与抓包真值同序). */
export const ALL_OFFICIAL_TOOL_NAMES: readonly string[] = Object.freeze(
  OFFICIAL_TOOL_META.map((t) => t.name),
)

/** 默认注入的名字: 下游能派发的那些(group === common). */
export const DEFAULT_INJECTED_TOOLS: readonly string[] = Object.freeze(
  OFFICIAL_TOOL_META.filter((t) => t.group === 'common').map((t) => t.name),
)

/** 选择结果: 定了注入哪些名字, 以及是哪种模式. */
export interface OfficialToolSelection {
  /** 本次要注入的官方工具名(已与真源求过交集, 顺序按真源). */
  names: string[]
  /** all 全注入(未配置过) / none 全不注入(显式清空) / subset 按名单注入. */
  mode: 'all' | 'none' | 'subset'
}

/**
 * 按控制台配置解析出本次要注入的官方工具名.
 *
 * 三种输入对应三种模式, 必须分开:
 *   - null / undefined: 没配置过, 全注入(与旧行为一致, 零回归).
 *   - []: 显式清空, 一个都不注入.
 *   - [名字...]: 只注入这些, 且先与真源求交集 ---- 配置里可能有上游已经删掉的名字.
 *
 * @param {unknown} selected 控制台配置的官方工具名数组; null 表示未配置
 * @returns {OfficialToolSelection} 名字与模式
 */
export function selectOfficialTools(selected: unknown): OfficialToolSelection {
  if (selected == null) return { names: [...ALL_OFFICIAL_TOOL_NAMES], mode: "all" }
  const want = new Set(
    (Array.isArray(selected) ? selected : []).filter((n) => typeof n === 'string' && n),
  )
  // 空数组不再等于[一个都不注入]: 上游按[工具集完整性]判第三方客户端, 出站
  // 一个官方工具都不带会被直接拒(2026-10-06 实测: 无 tools / 单个工具 -> 503,
  // 完整 37 工具 -> 200). 所以这里把它当成[未配置], 走自动规则.
  // 下拉到 0 个的能力没有存在价值 ---- 它只会制造一个必然失败的配置.
  // 见 .agents/notes/implemented/bug-fix/2026-10-06-official-toolset-floor.md
  if (want.size === 0) return { names: [...ALL_OFFICIAL_TOOL_NAMES], mode: "all" }
  const names = ALL_OFFICIAL_TOOL_NAMES.filter((n) => want.has(n))
  return { names, mode: 'subset' }
}
/**
 * 按[下游本次声明]算出真正可注入的官方工具.
 *
 * 判据只有一句: 模型选中这个官方工具后, 回程能把它还原成下游这次真的声明过的
 * 名字 ---- 还原得回去才可能派发, 还原不回去必然是 unknown tool.
 *
 * 为什么不沿用 group 那张静态表: 同一台机器上并存两种客户端形态, 静态表对不上
 * 任何一种. 实测(dsh 55 工具 / PTC 只声明 run_code):
 *   - 原生 55 工具: 静态表判 10 个可派发, 与自动规则一致;
 *   - PTC 只声明 run_code: 静态表仍判 10 个可派发, 实际 37 个全都派发不了.
 *
 * 自动规则对任意客户端形态零配置生效: 新客户端接进来不需要维护任何表.
 *
 * @param {unknown} declared 下游本次声明的工具名(Set / 字符串数组 / OpenAI 工具数组)
 * @returns {string[]} 可注入的官方工具名(顺序按真源)
 */
export function injectableOfficialTools(declared: unknown): string[] {
  const set = toNameSet(declared)
  const back = buildOfficialToClientMap(set)
  return ALL_OFFICIAL_TOOL_NAMES.filter((name) => set.has(back[name] || name))
}

import { toNameSet, buildOfficialToClientMap } from '../tool-name-map.ts'
