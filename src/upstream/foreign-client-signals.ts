/**
 - 上游[外来客户端]判据的本地镜像 ---- 单一真源.
 *
 - 内容取自上游源码 common/src/constants/foreign-client-signals.ts
 - (2026-09-19 取, sha256 505f9b42af1758b5403233737251b231a9369a312dbe4dcde6ceeed538589da9).
 - 上游改规则后必须回来重对.
 - 取舍见 .agents/notes/implemented/bug-fix/2026-09-19-genuine-tool-signature.md.
 *
 - 本地只把它用于可观测性与[该注入什么签名工具]; 判定权永远在上游.
 *
 - 差分验证方法:把上游那份源码与本模块并排加载(node --import <ts-loader> + zod@4),
 - 逐用例比对 detectForeignClient 的 signal 与 evidence,并比常量集与参数名表.
 */

import { translateParamsForDownstream } from './signals/param-map.ts'
import { CLIENT_TO_OFFICIAL_TOOL, buildOfficialToClientMap, toNameSet } from './signals/tool-name-map.ts'

/** 名字映射真源在本文件之外(见 signals/tool-name-map.ts), 从这里透出保持既有 import 路径可用.
 *  OFFICIAL_NATIVE_TO_CLIENT 也一并透出: 它是[官方原生名 -> 下游名]的补充表,
 *  判据与那张大表同源, 消费者只该认这一处入口. */
export {
  CLIENT_TO_OFFICIAL_TOOL, OFFICIAL_NATIVE_TO_CLIENT,
  buildOfficialToClientMap, toNameSet,
} from './signals/tool-name-map.ts'

/** 判据源码 sha256:上游改动后这里必须一起更新. */
export const FOREIGN_CLIENT_SIGNALS_SOURCE_SHA256 =
  '505f9b42af1758b5403233737251b231a9369a312dbe4dcde6ceeed538589da9'

/**
 - 降级目标模型.上游原话:OpenRouter 的 :free 变体.
 - 它不是错误响应 ---- 上游把请求送给这个小模型;该 slug 不可路由时
 - (经 OpenRouter 回 404)才以 404 形式失败,下游桥接层再把那个 404 崩成 502 空体.
 */
export const FREEBUFF_DOWNGRADE_MODEL_ID = 'inclusionai/ling-3.0-tiny:free'

/** 上游在 toolNames 之外自定义的工具名(Freebuff Desktop autorun agent 的 decide). */
export const FREEBUFF_CUSTOM_TOOL_NAMES = ['decide']

/**
 - 我们定义,但其它 agent harness 也发的工具名 ---- 上游的排除表:
 - 这些名字不构成签名.
 */
export const GENERIC_TOOL_NAMES = ['write_file', 'web_search', 'glob', 'skill', 'apply_patch']

/**
 - 只要出现任意一个就判[外来],无论请求还带了什么(包括我们的真签名工具).
 - 上游原话:这是我们都不发的 harness 的工具名 ---- Claude Code 的 PascalCase 核心工具,
 - Codex / OpenClaw / opencode 的专有名.按 harness 分组,保留上游的注释顺序.
 */
export const FOREIGN_HARNESS_TOOL_NAMES_BY_HARNESS = Object.freeze({
  'claude-code': Object.freeze([
    'Agent', 'AskUserQuestion', 'Bash', 'BashOutput', 'KillShell', 'Edit',
    'MultiEdit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch',
    'WebSearch', 'TodoWrite', 'Task', 'Skill', 'SlashCommand', 'EnterPlanMode',
    'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'ToolSearch', 'CronCreate',
    'CronDelete', 'CronList', 'CronUpdate', 'SendMessage', 'ListAgents',
    'TaskStop', 'TaskOutput', 'Monitor', 'ScheduleWakeup', 'DesignSync', 'Artifact',
  ]),
  cursor: Object.freeze(['AskQuestion', 'ReadLints', 'StrReplace', 'Shell', 'Delete']),
  codex: Object.freeze(['exec_command', 'write_stdin', 'request_user_input']),
  openclaw: Object.freeze(['browser_exec', 'delegate_task', 'computer_use']),
  opencode: Object.freeze(['todowrite', 'todoread', 'webfetch']),
})

/**
 - 扁平查询集 ---- 与上游 FOREIGN_HARNESS_TOOL_NAMES 同名同义(它只维护这一个 Set).
 - 上面的分组表只为可读性,判定一律走这里.
 */
export const FOREIGN_HARNESS_TOOL_NAMES = new Set(
  Object.values(FOREIGN_HARNESS_TOOL_NAMES_BY_HARNESS).flat(),
)

/** 只出现在第三方 harness 的 system prompt 里,我们从不写的短语. */
export const FOREIGN_HARNESS_PROMPT_MARKERS = Object.freeze([
  'You are Claude Code',
  "Anthropic's official CLI",
  'cc_version=',
  'cc_entrypoint=',
])

/**
 - 官方每个工具在 wire 上的顶层参数名(由上游 toolParams 逐个 z.toJSONSchema 提取,
 - 2026-09-19).上游签名校验的基准:送来的 schema 顶层参数名必须是这里的子集 ----
 - 子集而非相等,落后一个版本的官方客户端缺一个新增可选字段仍应放行.
 *
 - 只有顶层名字参与判定;窗口版与旧版 read_files 的差异在 paths 内部.
 - 空数组 = 官方零参数工具(end_turn / task_completed)---- 它们永远不算签名.
 */
export const OFFICIAL_TOOL_PARAMETER_KEYS: any = Object.freeze({
  add_message: ['content', 'role'],
  apply_patch: ['operation'],
  add_subgoal: ['id', 'log', 'objective', 'plan', 'status'],
  ask_user: ['questions'],
  browser_logs: ['type', 'url', 'waitUntil'],
  cloud_plan_ready: ['build_prompt', 'required_integrations', 'stack', 'summary'],
  code_search: ['cwd', 'flags', 'maxResults', 'pattern'],
  composio_get_tool_schemas: ['include', 'session_id', 'tool_slugs'],
  composio_manage_connections: ['reinitiate_all', 'session_id', 'toolkits'],
  composio_multi_execute_tool: ['session_id', 'sync_response_to_workbench', 'thought', 'tools'],
  composio_search_tools: ['model', 'queries', 'session'],
  create_plan: ['path', 'plan'],
  // decide 不在上游 toolParams 里(canonicalToolParameterKeys 返回 null):它靠自定义名放行,
  // 所以不在这张表里 ---- 与[零参数(有表但为空)]是两种情形,判定语义不同.
  end_turn: [],
  find_files: ['prompt'],
  glob: ['cwd', 'max_results', 'pattern'],
  gravity_index: ['action', 'category', 'context', 'integrated_slug', 'q', 'query', 'search_id', 'slug', 'user_consent'],
  list_directory: ['path'],
  lookup_agent_info: ['agentId'],
  propose_str_replace: ['path', 'replacements'],
  propose_write_file: ['content', 'instructions', 'path'],
  read_docs: ['libraryTitle', 'max_tokens', 'topic'],
  read_files: ['paths'],
  read_subtree: ['maxTokens', 'paths'],
  read_url: ['max_chars', 'url'],
  render_ui: ['widget'],
  run_file_change_hooks: ['files'],
  run_terminal_command: ['command', 'cwd', 'process_type', 'timeout_seconds'],
  set_messages: ['messages'],
  set_output: ['data'],
  skill: ['name'],
  spawn_agent_inline: ['agent_type', 'params', 'prompt'],
  spawn_agents: ['agents'],
  str_replace: ['path', 'replacements'],
  suggest_followups: ['followups'],
  task_completed: [],
  think_deeply: ['thought'],
  update_subgoal: ['id', 'log', 'plan', 'status'],
  web_search: ['depth', 'query'],
  write_file: ['content', 'instructions', 'path'],
  write_todos: ['todos'],
})

/**
 - 官方零参数工具的描述原文(2026-09-19 取自上游 toolParams,逐字).
 *
 - 零参数工具没有结构可校验(复制的名字加 {} 与真货逐字节相同),
 - 上游 isGenuineSignatureTool 因此永不认可它们;只有在 isHollowSignatureTool
 - 里退而比对描述.这里存它,只为让本地日志与上游日志说同一件事.
 */
export const OFFICIAL_ZERO_PARAM_TOOL_DESCRIPTIONS: any = Object.freeze({
  end_turn: "Only use this tool to hand control back to the user.\n\n- When to use: after you have completed a meaningful chunk of work and you are either (a) fully done, or (b) explicitly waiting for the user's next message.\n- Do NOT use: as a stop token mid-work, to pause between tool calls, to wait for tool results, or to \"check in\" unnecessarily.\n- Before calling: finish all pending steps, resolve tool results, and include any outputs the user needs to review.\n- Effect: Signals the UI to wait for the user's reply; any pending tool results will be ignored.\n\n*INCORRECT USAGE*:\n<some_tool_that_produces_results_params_example>\n{\n  \"query\": \"some example search term\"\n}\n</some_tool_that_produces_results_params_example>\n\n<end_turn_params_example>\n{}\n</end_turn_params_example>\n\n*CORRECT USAGE*:\nAll done! Would you like some more help with xyz?\n\n<end_turn_params_example>\n{}\n</end_turn_params_example>",
  task_completed: "Use this tool to signal that the task is complete.\n\n- When to use:\n  * The user's request is completely fulfilled and you have nothing more to do\n  * You need clarification from the user before continuing\n  * You need help from the user to continue (e.g., missing information, unclear requirements)\n  * You've encountered a blocker that requires user intervention\n\n- Before calling:\n  * Ensure all pending work is finished\n  * Resolve all tool results\n  * Provide any outputs or summaries the user needs\n\n- Effect: Signals completion of the current task and returns control to the user\n\n*EXAMPLE USAGE*:\n\nAll changes have been implemented and tested successfully!\n\n<task_completed_params_example>\n{}\n</task_completed_params_example>\n\nOR\n\nI need more information to proceed. Which database schema should I use for this migration?\n\n<task_completed_params_example>\n{}\n</task_completed_params_example>\n\nOR\n\nI can't get the tests to pass after several different attempts. I need help from the user to proceed.\n\n<task_completed_params_example>\n{}\n</task_completed_params_example>",
})

/**
 - 判定的实现(schema 校验 / detectForeignClient / 注入的签名工具定义)在 signals/detect.ts.
 - 这里原样 re-export, 外部消费者与 test 的 import 点不变; 本文件只保留上游那份判据
 - 源码的[本地镜像]常量.
 */
export {
  ENFORCED_FOREIGN_SIGNALS,
  FREEBUFF_SIGNATURE_TOOL_DEFINITIONS,
  detectForeignClient,
  findForeignHarnessPromptMarker,
  isGenuineSignatureTool,
  isHollowSignatureTool,
  readOfferedTools,
  schemaPropertyKeys,
} from './signals/detect.ts'

/**
 - 把上游返回的 tool_calls 里的官方工具名还原成下游认识的名字(上行方向).
 *
 - 与下行映射配对:下行把 bash→run_terminal_command,上行就还原回 bash,
 - 使下游拿到的工具名与它自己声明的完全一致,可直接派发.
 *
 - [本次声明]过滤:只还原成下游这次请求里真的声明过的名字.
 - 旧实现用全表反查,于是模型只要调了官方原生工具(list_directory),回程就
 - 被改名成 ls -- 而下游可能根本没声明 ls,派发时报 unknown tool "ls".
 - 同一官方名有多个下游别名时,报哪个也是猜的(read_files 还原成 read,
 - 即使下游声明的是 cat).现在声明集里没有的一律保持官方原名 ---- 下游收到
 - 不认识的名字会明确报错,好过收到一个它不认识的别名.
 *
 - 官方原生名(下游没声明过)原样保留.
 *
 - 决策, 被否决的备选与线上证据见
 - .agents/notes/implemented/bug-fix/2026-10-05-downstream-tool-restore-declared-names.md
 *
 - @param {any} body 上游响应体(chat.completion,含 choices[].message.tool_calls)
 - @param {Iterable<string>|any[]} [declaredNames] 本次下游声明的工具名集合
 - @param {Record<string, any>} [declaredSchemas] 本次下游声明的工具 schema(名字 -> parameters),按它裁剪翻译后的字段
 - @returns {any} 原地修改后的 body(同时返回,便于链式使用)
 */
/**
 * 把上游返回的 tool_calls 里的官方工具名还原成下游认识的名字(非流式整份).
 *
 * @param {any} body 上游响应体
 * @param {Iterable<string>|any[]} [declaredNames] 本次下游声明的工具名集合
 * @param {Record<string, any>} [declaredSchemas] 本次下游声明的 schema 表
 * @param {any} [paramContext] 运行期参数(下游本地事实, 见 signals/param-map.ts)
 * @returns {any} 原地修改后的 body
 */
export function unmapToolCallsInBody(
  body: any,
  declaredNames?: Iterable<string>,
  declaredSchemas?: any,
  paramContext?: any,
) {
  if (!body || typeof body !== 'object') return body
  const declared = toNameSet(declaredNames)
  const back = buildOfficialToClientMap(declaredNames)
  const choices = Array.isArray(body.choices) ? body.choices : []
  for (const ch of choices) {
    /**
     - 处理两种形态:
     - - 非流式:choices[].message.tool_calls[].function.name
     - - SSE 流式:choices[].delta.tool_calls[].function.name
     - (首片给 name,后续片只给 arguments)
     - 只处理 message 会让流式响应一条都不还原.
     */
    for (const holder of [ch?.message, ch?.delta]) {
      const tc = holder?.tool_calls
      if (!Array.isArray(tc)) continue
      for (const call of tc) {
        const name = call?.function?.name
        if (!name) continue
        const clientName = back[name] || name
        if (back[name]) call.function.name = clientName
        /**
         - 参数形态同步翻译.
         -
         - 两种情况都要走这里:
         -   1. 改过名(back[name] 命中): 只改名字会让下游收到自己的名字配官方的
         -      参数(线上实测: name=read, arguments={"paths":[...]}).
         -   2. 未改名但下游本次声明了这个官方名(如 web_search / glob): 官方与
         -      下游完全同名, 形态却可能不同(下游 web_search 要 queries, 官方是
         -      query). 旧实现只在改名分支里翻译, 这一类会被整体漏掉.
         -
         - 无规则时原样保留参数.
         */
        if (!declared.has(clientName) && !back[name]) continue
        const translated = translateParamsForDownstream(
          clientName,
          call.function.arguments,
          declaredSchemas?.[clientName],
          paramContext,
        )
        if (translated != null) call.function.arguments = translated
      }
    }
  }
  return body
}

/** 官方全部工具名(上游 toolNames,含 composio 元工具). */
export const OFFICIAL_TOOL_NAMES = Object.freeze(Object.keys(OFFICIAL_TOOL_PARAMETER_KEYS))

/** 上游用于签名的名字集:官方工具名去掉 generic,再加入自定义名. */
export const FREEBUFF_SIGNATURE_TOOL_NAMES = Object.freeze(
  OFFICIAL_TOOL_NAMES.filter((n) => !GENERIC_TOOL_NAMES.includes(n)).concat(
    FREEBUFF_CUSTOM_TOOL_NAMES,
  ),
)
