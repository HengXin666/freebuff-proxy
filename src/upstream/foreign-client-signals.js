/**
 * 上游「外来客户端」判据的本地镜像 —— **单一真源**。
 *
 * 为什么需要它：上游按「请求形态是否来自官方客户端」决定降级（把请求改投一个小模型，
 * 或在该 slug 不可路由时以 404 失败），而判据的公开出处只剩源码：
 *   common/src/constants/foreign-client-signals.ts
 *   （2026-09-19 取，sha256 505f9b42af1758b5403233737251b231a9369a312dbe4dcde6ceeed538589da9）
 * 上游已把文档化的 docs/freebuff-abuse-detection.md 从仓库撤下。上游改规则后必须回来重对；
 * 取舍与实测见 .agents/notes/implemented/bug-fix/2026-09-19-genuine-tool-signature.md。
 *
 * 本地只把它用于**可观测性**与「该注入什么签名工具」——判定权永远在上游。
 *
 * 差分验证方法：把上游那份源码与本模块并排加载（node --import <ts-loader> + zod@4），
 * 逐用例比对 detectForeignClient 的 signal 与 evidence，并比常量集与参数名表。
 */

/** 判据源码 sha256：上游改动后这里必须一起更新（对照实验的版本锚点）。 */
export const FOREIGN_CLIENT_SIGNALS_SOURCE_SHA256 =
  '505f9b42af1758b5403233737251b231a9369a312dbe4dcde6ceeed538589da9'

/**
 * 降级目标模型。上游原话：OpenRouter 的 :free 变体，降级请求不花上游的推理预算。
 * 它**不是错误响应** —— 上游不回 4xx，而是把请求送给这个小模型；该 slug 不可路由时
 * （实测经 OpenRouter 回 404）才以 404 形式失败，下游桥接层再把那个 404 崩成 502 空体。
 */
export const FREEBUFF_DOWNGRADE_MODEL_ID = 'inclusionai/ling-3.0-tiny:free'

/** 上游在 toolNames 之外自定义的工具名（Freebuff Desktop autorun agent 的 decide）。 */
export const FREEBUFF_CUSTOM_TOOL_NAMES = ['decide']

/**
 * 我们定义、但其它 agent harness 也发的工具名 —— 上游的**排除表**：
 * 这些名字不构成签名（否则会把 opencode / Cline / Codex 自己人判成第三方）。
 */
export const GENERIC_TOOL_NAMES = ['write_file', 'web_search', 'glob', 'skill', 'apply_patch']

/**
 * 只要出现**任意一个**就判「外来」，无论请求还带了什么（包括我们的真签名工具）。
 * 上游原话：这是我们都不发的 harness 的工具名 —— Claude Code 的 PascalCase 核心工具、
 * Codex / OpenClaw / opencode 的专有名。按 harness 分组，保留上游的注释顺序。
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
 * 扁平查询集 —— 与上游 `FOREIGN_HARNESS_TOOL_NAMES` 同名同义（它只维护这一个 Set）。
 * 上面的分组表只为可读性，判定一律走这里。
 */
export const FOREIGN_HARNESS_TOOL_NAMES = new Set(
  Object.values(FOREIGN_HARNESS_TOOL_NAMES_BY_HARNESS).flat(),
)

/** 只出现在第三方 harness 的 system prompt 里、我们从不写的短语。 */
export const FOREIGN_HARNESS_PROMPT_MARKERS = Object.freeze([
  'You are Claude Code',
  "Anthropic's official CLI",
  'cc_version=',
  'cc_entrypoint=',
])

/**
 * 官方每个工具在 wire 上的**顶层参数名**（由上游 toolParams 逐个 z.toJSONSchema 提取，
 * 2026-09-19）。上游签名校验的基准：送来的 schema 顶层参数名必须是这里的**子集** ——
 * 子集而非相等，落后一个版本的官方客户端缺一个新增可选字段仍应放行。
 *
 * 只有顶层名字参与判定；窗口版与旧版 read_files 的差异在 paths 内部。
 * 空数组 = 官方零参数工具（end_turn / task_completed）—— 它们**永远不算签名**。
 */
export const OFFICIAL_TOOL_PARAMETER_KEYS = Object.freeze({
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
  // decide 不在上游 toolParams 里（canonicalToolParameterKeys 返回 null）：它靠自定义名放行，
  // 所以**不在这张表里** —— 与「零参数（有表但为空）」是两种情形，判定语义不同。
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
 * 官方**零参数**工具的描述原文（2026-09-19 取自上游 toolParams，逐字）。
 *
 * 为什么单独存：零参数工具没有结构可校验（复制的名字加 {} 与真货逐字节相同），
 * 上游 `isGenuineSignatureTool` 因此**永不认可**它们；只有在 `isHollowSignatureTool`
 * 里退而比对描述 —— 而那一条官方明说「只喂日志、不强制」，所以描述改动不会罚到
 * 落后一个版本的官方客户端。这里存它，只为让本地日志与上游日志说同一件事。
 */
export const OFFICIAL_ZERO_PARAM_TOOL_DESCRIPTIONS = Object.freeze({
  end_turn: "Only use this tool to hand control back to the user.\n\n- When to use: after you have completed a meaningful chunk of work and you are either (a) fully done, or (b) explicitly waiting for the user's next message.\n- Do NOT use: as a stop token mid-work, to pause between tool calls, to wait for tool results, or to \"check in\" unnecessarily.\n- Before calling: finish all pending steps, resolve tool results, and include any outputs the user needs to review.\n- Effect: Signals the UI to wait for the user's reply; any pending tool results will be ignored.\n\n*INCORRECT USAGE*:\n<some_tool_that_produces_results_params_example>\n{\n  \"query\": \"some example search term\"\n}\n</some_tool_that_produces_results_params_example>\n\n<end_turn_params_example>\n{}\n</end_turn_params_example>\n\n*CORRECT USAGE*:\nAll done! Would you like some more help with xyz?\n\n<end_turn_params_example>\n{}\n</end_turn_params_example>",
  task_completed: "Use this tool to signal that the task is complete.\n\n- When to use:\n  * The user's request is completely fulfilled and you have nothing more to do\n  * You need clarification from the user before continuing\n  * You need help from the user to continue (e.g., missing information, unclear requirements)\n  * You've encountered a blocker that requires user intervention\n\n- Before calling:\n  * Ensure all pending work is finished\n  * Resolve all tool results\n  * Provide any outputs or summaries the user needs\n\n- Effect: Signals completion of the current task and returns control to the user\n\n*EXAMPLE USAGE*:\n\nAll changes have been implemented and tested successfully!\n\n<task_completed_params_example>\n{}\n</task_completed_params_example>\n\nOR\n\nI need more information to proceed. Which database schema should I use for this migration?\n\n<task_completed_params_example>\n{}\n</task_completed_params_example>\n\nOR\n\nI can't get the tests to pass after several different attempts. I need help from the user to proceed.\n\n<task_completed_params_example>\n{}\n</task_completed_params_example>",
})

/** 官方全部工具名（上游 toolNames，含 composio 元工具）。 */
export const OFFICIAL_TOOL_NAMES = Object.freeze(Object.keys(OFFICIAL_TOOL_PARAMETER_KEYS))

/** 上游用于签名的名字集：官方工具名去掉 generic，再加入自定义名。 */
export const FREEBUFF_SIGNATURE_TOOL_NAMES = Object.freeze(
  OFFICIAL_TOOL_NAMES.filter((n) => !GENERIC_TOOL_NAMES.includes(n)).concat(
    FREEBUFF_CUSTOM_TOOL_NAMES,
  ),
)

/**
 * 一个 JSON-Schema 的顶层属性名集合；不是对象 schema（缺失 / 字符串 / 数组）时返回 null。
 * 与上游 schemaPropertyKeys 同义：读 properties，并递归并入 anyOf / oneOf / allOf
 * 各分支的 properties（z.toJSONSchema 对联合类型产出的就是这个形状）。
 * @param {unknown} schema
 * @returns {Set<string> | null}
 */
export function schemaPropertyKeys(schema) {
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
 * 送来的工具是不是「货真价实的」官方签名工具（上游 isGenuineSignatureTool 同义）。
 *
 * 三种情形：
 *   - 自定义名（decide）：官方没有 schema 可比，按名字放行。
 *   - 官方定义且**有参数**：schema 非空，且顶层参数名是官方参数名的子集。
 *   - 官方定义但**无参数**（end_turn / task_completed）：**永远不算** —— 复制的名字
 *     加 {} 与真货逐字节相同，没有结构可验证，官方不接受，我们也别指望它能过。
 *
 * @param {{ name?: unknown, parameters?: unknown }} tool
 * @returns {boolean}
 */
export function isGenuineSignatureTool(tool) {
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
 * 顶着官方签名名字、却不是官方东西的「洗白形态」——**只用于日志/可观测性**，
 * 不参与任何判定（上游也是这么用的）。零参数工具官方无法背书，于是退而看描述；
 * 也正因为它只喂日志，官方才不强制它，落后一个版本的官方客户端也不会因此被罚。
 *
 * @param {{ name?: unknown, parameters?: unknown }} tool
 * @returns {boolean}
 */
export function isHollowSignatureTool(tool) {
  const name = tool && typeof tool.name === 'string' ? tool.name : ''
  if (!FREEBUFF_SIGNATURE_TOOL_NAMES.includes(name)) return false
  if (FREEBUFF_CUSTOM_TOOL_NAMES.includes(name)) return false
  const ours = OFFICIAL_TOOL_PARAMETER_KEYS[name]
  if (!ours) return false
  // 有参数的工具：不是真货就是空心。
  if (ours.length > 0) return !isGenuineSignatureTool(tool)
  // 零参数工具：没有结构可校验，退而比对描述 —— 这正是代理注入的空心 end_turn
  // 会露馅的地方（上游夹具 PROXY_HOLLOW_END_TURN 用的就是这一句）。
  const shipped = OFFICIAL_ZERO_PARAM_TOOL_DESCRIPTIONS[name]
  if (typeof shipped !== 'string') return false
  const got = tool.description
  return typeof got !== 'string' || got.trim() !== shipped.trim()
}

/**
 * 从 OpenAI 形状的 tools 数组读出 { name, parameters }。
 * @param {unknown} tools
 * @returns {Array<{ name: string, parameters?: unknown, description?: unknown }>}
 */
export function readOfferedTools(tools) {
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
 * 任一 system 消息里的外来 harness 身份标记；取不到返回 null。
 * 只看 system 角色 —— 用户把 Claude Code 的记录粘进对话里绝不该被判外来。
 * @param {unknown} messages
 * @returns {string | null}
 */
export function findForeignHarnessPromptMarker(messages) {
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
 * 上游 detectForeignFreebuffClient 的同义实现：判断一个 free-mode 请求是不是来自
 * 别人的客户端。**本地只用于可观测性**（日志 + 响应头），判定权永远在上游；
 * 与上游保持同义，是为了让「正在被降级」在出问题时能被看见。
 *
 * 顺序本身就是安全故事（与上游一致）：外来工具名 / system 身份标记**压倒一切** ——
 * 带了官方真工具也照样判外来；之后「带了工具就必须有一个真签名」。无工具时的两个
 * 信号上游**只报不罚**，这里同样只报。
 *
 * @param {{ tools?: unknown, messages?: unknown, temperature?: unknown, top_p?: unknown, max_tokens?: unknown }} body
 * @param {boolean} [isRootAgent]
 * @returns {{ signal: string | null, toolCount: number, sampleToolNames: string[], hollowToolNames: string[], foreignToolNames: string[] }}
 */
export function detectForeignClient(body, isRootAgent = false) {
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

/** 上游会**据此降级**的信号（其余只报不罚）。 */
export const ENFORCED_FOREIGN_SIGNALS = Object.freeze([
  'foreign_toolset',
  'foreign_tool_names',
  'foreign_system_prompt',
])

/**
 * 我们注入的官方签名工具 —— **按上游判据逐字构造**。
 *
 * 为什么不是补一个空心 end_turn：上游 2026-09-17 起要求签名工具「名字 + 真实参数
 * schema」双真，零参数工具**永远不算签名**；上游还把「往 tools 末尾补空心 end_turn」
 * 这种形态逐字收进测试夹具（PROXY_HOLLOW_END_TURN）并在注释里点名 freebuff-proxy。
 *
 * 两个都带、任一通过即可（上游是 some()）：decide 走自定义名放行，
 * lookup_agent_info 走真实 schema 子集 —— 任一条规则变化，都还有另一条兜住。
 *
 * description 故意写成「别调用」：上游对**有参数**的工具只比对 schema、不比对描述
 * （描述只在零参数工具上用于日志），所以这里可以自由取舍；而一个真诚邀请模型调用的
 * 描述，会让模型真的去调一个下游客户端根本不认识的名字。
 */
export const FREEBUFF_SIGNATURE_TOOL_DEFINITIONS = Object.freeze([
  // 首位 = 主签名：带真实参数 schema，走上游的「schema 子集」判定。
  // 排在首位是因为它承载结构证据，而 decide 只是名字层面的兜底。
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
  // 兜底 = 官方自定义工具名（上游对自定义名不查 schema）。
  Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: 'decide',
      description: 'Protocol compatibility marker. Do not call this function.',
      parameters: Object.freeze({ type: 'object', properties: Object.freeze({}) }),
    }),
  }),
])
