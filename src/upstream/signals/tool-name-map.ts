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
  return back
}
