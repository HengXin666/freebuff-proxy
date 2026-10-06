/**
 * 客户端工具名 <-> 官方工具名的双向映射真源, 以及回程还原表的构造.
 *
 * 从 foreign-client-signals.ts 按职责切出: 那个文件管"上游如何识别外来客户端"
 * 的信号集, 本文件只管"名字怎么来回翻译". 两者一起超过 300 行上限后按此切分,
 * 语义零改动.
 *
 * 为什么要单独成文件而不是两处各写一份: 原本 Node 侧(本表)与 bun 侧
 * (cli-bridge/lib/tool-map.ts 的 MAP_TOOLS)各有一张表, 只有一处带[本次声明]过滤,
 * 于是同一官方名在不同协议路径上会还原成不同的下游名. 这张表是 Node 侧的唯一真源,
 * 流式与非流式两条回程路径都从这里取还原表.
 * 双向映射的取舍与实证见 .agents/notes/implemented/bug-fix/2026-10-04-tool-name-bidirectional-mapping.md.
 */

/**
 * 客户端工具名 -> 官方工具名的映射表(下行方向).
 *
 * 能映射的映射到官方等价物(模型看到官方名字, 按官方语义理解与计费);
 * 映射不到的在载荷层保持原名(见 tool-carrier 的 MCP 载体通道).
 *
 * 反向映射(上行)由本文件的 buildOfficialToClientMap 构造.
 */
export const CLIENT_TO_OFFICIAL_TOOL = Object.freeze({
  bash: 'run_terminal_command',
  shell: 'run_terminal_command',
  sh: 'run_terminal_command',
  run_command: 'run_terminal_command',
  execute_command: 'run_terminal_command',
  terminal: 'run_terminal_command',
  edit: 'str_replace',
  apply_patch: 'str_replace',
  str_replace: 'str_replace',
  write: 'write_file',
  create_file: 'write_file',
  write_file: 'write_file',
  read: 'read_files',
  cat: 'read_files',
  read_file: 'read_files',
  read_files: 'read_files',
  grep: 'code_search',
  code_search: 'code_search',
  find: 'code_search',
  glob: 'glob',
  ls: 'list_directory',
  list_dir: 'list_directory',
  list_directory: 'list_directory',
  web_fetch: 'read_url',
  fetch: 'read_url',
  curl: 'read_url',
  read_url: 'read_url',
  web_search: 'web_search',
  search: 'web_search',
  todo_write: 'write_todos',
  write_todos: 'write_todos',
  ask_user_question: 'ask_questions',
  ask_questions: 'ask_questions',
  browser_check: 'browser_check',

  /**
   * 其它 harness 的等价名 -- Claude Code / Codex / Cursor / opencode.
   *
   * 为什么必须收进来: 本代理要同时服务多个下游(dsh / Claude Code / Codex ...).
   * 不收的代价不是"不可用"(载体通道仍会把它包成 proxy__x 发出去), 而是
   * 上游按外来客户端判据识别: 这些名字本身就在上游的
   * FOREIGN_HARNESS_TOOL_NAMES 里(见 ../../foreign-client-signals.ts), 原样或
   * 经载体发出去都躲不开语义降级; 映射到官方等价物后上游只看到官方名.
   *
   * 名字形态取自本仓已有的上游判据镜像(同文件 FOREIGN_HARNESS_TOOL_NAMES_BY_HARNESS),
   * 不另行猜测: 大写是 Claude Code 与 Cursor 的形态, 小写是 Codex 与 opencode 的.
   * 没有官方等价物的(Task / NotebookEdit / read_lints 之类)一律不进表 ----
   * 它们交给载体通道, 硬凑一个官方名等于篡改语义.
   */
  Bash: 'run_terminal_command',
  Read: 'read_files',
  Write: 'write_file',
  Edit: 'str_replace',
  MultiEdit: 'str_replace',
  Glob: 'glob',
  Grep: 'code_search',
  LS: 'list_directory',
  TodoWrite: 'write_todos',
  WebFetch: 'read_url',
  WebSearch: 'web_search',
  AskUserQuestion: 'ask_questions',
  StrReplace: 'str_replace',
  Shell: 'run_terminal_command',
  AskQuestion: 'ask_questions',
  exec_command: 'run_terminal_command',
  todowrite: 'write_todos',
  webfetch: 'read_url',
})

/**
 * 把"本次声明"归一成名字集合(复用既有真源, 不再重复实现).
 *
 * 既有实现还支持 OpenAI 工具数组形态([{function:{name}}]), 比这里原先那份
 * 只认 Set/数组的版本更完备.
 */
import { toNameSet } from './declared-names.ts'

export { toNameSet } from './declared-names.ts'

/**
 * 官方原生工具 -> 下游等价物的显式补充表(一对多方向).
 *
 * 为什么另立一张表而不是往 CLIENT_TO_OFFICIAL_TOOL 里加: 那张表的键是下游名,
 * 一个下游名只能指向一个官方名. 而这里要表达的恰恰是反过来的关系 ----
 * 两个不同的官方工具都能落到同一个下游工具上:
 *   ask_questions    -> ask_user_question(原生问答)
 *   suggest_prompts  -> ask_user_question(官方[后续提问建议卡片])
 *
 * suggest_prompts 为什么可以落过来(2026-10-06 裁决): 它的载荷是一组
 * {prompt, label} 选项, 与下游 ask_user_question 的 questions[].options[] 同构;
 * 官方 worker system 模板还明文要求[几乎每一轮都要调用它]. 不映射的代价是
 * 每轮都有一条注定 unknown tool 的调用; 映射过来后下游至少能把它渲染成
 * 一组可选项, 语义偏差(建议 vs 提问)由参数规则里的措辞兜住.
 *
 * 只对明确做过对标决策的官方名登记; 没有下游对应物的一律不写(写了就会把
 * 官方原生名翻成下游不认识的别名).
 */
export const OFFICIAL_NATIVE_TO_CLIENT: Record<string, string> = Object.freeze({
  suggest_prompts: 'ask_user_question',
})

/**
 * 构造 官方名 -> 下游名 的还原表, 并做[本次声明]过滤.
 *
 * 两个消费者共用同一条规则: 非流式的 unmapToolCallsInBody 与流式的逐分片改写
 * (src/proxy/transport/reply/sse-tool-rewrite.ts). 两份实现必然漂移, 而漂移的
 * 表现是"同一个工具在不同协议路径上还原成不同名字".
 *
 * [本次声明]过滤为什么必须有: 模型只要调了官方原生工具(list_directory), 全表反查
 * 就会把它改名成 ls ---- 而下游可能根本没声明 ls, 派发时报 unknown tool "ls".
 * 同一官方名有多个下游别名时, 报哪个也是猜的(read_files 还原成 read, 即使下游
 * 声明的是 cat). 声明集里没有的一律保持官方原名: 下游收到不认识的名字会明确
 * 报错, 好过收到一个它不认识的别名.
 *
 * @param {Iterable<string>|any[]} [declaredNames] 本次下游声明的工具名集合
 * @returns {Record<string, string>} 官方名 -> 下游名; 声明集为空时退化为全表
 */
export function buildOfficialToClientMap(declaredNames?: any): Record<string, string> {
  const declared = toNameSet(declaredNames)
  const back: Record<string, string> = {}
  for (const [client, official] of Object.entries(CLIENT_TO_OFFICIAL_TOOL)) {
    if (declared.size > 0 && !declared.has(client)) continue
    if (!back[official]) back[official] = client // 取第一个 = 表内优先级
  }
  // 显式补充表同样受[本次声明]过滤: 下游这次没声明过那个客户端名时不得造出别名.
  for (const [official, client] of Object.entries(OFFICIAL_NATIVE_TO_CLIENT)) {
    if (declared.size > 0 && !declared.has(client)) continue
    if (!back[official]) back[official] = client
  }
  return back
}
