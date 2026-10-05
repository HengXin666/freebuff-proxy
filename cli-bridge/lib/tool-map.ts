/**
 - 客户端工具名与官方工具名的双向映射 -- 从 cli-bridge/upstream.ts 逐字搬出.
 - 下行改名让上游按官方语义理解; 映射不到的按名保留(实测结论, 不是推断).
 */
/**
 * 客户端工具名 → 官方工具名的映射表(下行方向).
 *
 *  为什么必须映射而不是直接追加(2026-10-04 定性):
 * 上游的官方工具集是固定 37 个(docs/reverse/captures/official-tools.json),
 * 里面没有 bash / edit / read / write / skill 这些下游 harness 的
 * 常用名.实测(远程 15:02)把 55 个第三方工具原样追加后,上游回
 * 503 {"message":"The model is temporarily unavailable."} ---- 而同会话,
 * 同模型,不带工具时是 200.唯一变量就是工具集.
 *
 * 所以:能映射的映射到官方等价物(模型看到的是官方名字,调用的也是官方
 * 语义),映射不了的丢弃(宁可让该工具在此链路不可用,也不能让整条链路
 * 因一个陌生工具名被拒).
 *
 * 反向映射(上行)见 UNMAP_TOOLS ---- 上游回 tool_calls 时把官方名还原成
 * 下游认识的名字,这样两边的模型/客户端都看到自己那套名字.
 */
export const MAP_TOOLS = Object.freeze({
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
 * 官方工具名 → 客户端熟悉的名字(上行方向,用于还原 tool_calls).
 *
 * 只对"我们做过下行映射"的名字建立反向关系 ---- 官方原生名(如 preview_click)
 * 没有下游对应物,保持原名返回,下游按原样收到即可.
 */
export const UNMAP_TOOLS = Object.freeze(
  Object.entries(MAP_TOOLS).reduce((acc, [client, official]) => {
    // 一个官方名可能对应多个客户端名:取第一个(表内顺序即优先级),
    // 保证还原是确定的(不能随对象键序漂移).
    if (!acc[official]) acc[official] = client
    return acc
  }, {}),
)

/**
 * 官方工具集 + 映射后的客户端工具,按 function.name 去重(官方优先).
 *
 * 与旧版(直接追加)的区别(这是本次修复的核心):
 *   - 客户端工具先经 MAP_TOOLS 换成官方等价名 → 上游只看到官方名字;
 *   - 映射不到的丢弃(旧版直接追加 → 上游看到陌生名 → 503);
 *   - 去重仍在(客户端声明了官方已有的名字时以官方定义为准).
 *
 * @param {any[]} official 官方工具定义
 * @param {any[]} clientTools 下游声明的工具
 */
/**
 - 官方工具集 + 映射后的客户端工具, 按 function.name 去重(官方优先).
 - @param {any[]} official 官方工具定义
 - @param {any[]} clientTools 下游声明的工具
 - @returns {any[]} 出站工具数组
 */
export function mergeOfficialTools(official, clientTools) {
  const list = Array.isArray(official) ? [...official] : [];
  if (!Array.isArray(clientTools) || clientTools.length === 0) return list;
  const seen = new Set(list.map((t) => t?.function?.name).filter(Boolean));
  for (const t of clientTools) {
    const n = t?.function?.name;
    if (!n) continue;
    /**
     *  映射不到时[原样保留],不是丢弃 ---- 这是实测结论,不是推断.
     *
     * 2026-10-05 单变量实测:声明 8 个官方完全不存在的工具名
     * (memory_save / git_status / subagent / send_message /
     * job_list / list_agents / git_diff / memory_search),
     * 出站 45 个工具(官方 37 + 这 8 个),上游回 HTTP 200.
     *
     * 即:上游并不因为"工具名官方没有"就拒绝请求.早期版本"映射不到即丢弃"
     * 是错的 ---- 实测 dsh 的 44 个工具里 30 个(68%)会被静默丢弃,
     * 用户以为声明了能调,实际根本没发出去(模型永远不会调用它们).
     *
     * 保留的意义:模型至少看得见这个工具,能按它的 schema 生成 tool_call,
     * 由客户端自己执行(本代理不执行工具,只转发).
     *
     * 那映射还要不要?要 ---- 对有官方等价物的名字(bash→
     * run_terminal_command 等)映射过去,让上游按官方语义理解和计费;
     * 没有等价物的保持原名,两边都不丢.
     */
    const mapped = MAP_TOOLS[n] || null;
    if (!mapped) {
      // 无官方等价物:原样保留(不改名,不丢弃)
      if (!seen.has(n)) {
        seen.add(n)
        list.push(t)
      }
      continue;
    }
    if (seen.has(mapped)) continue; // 官方优先,重复不追加
    seen.add(mapped);
    list.push({
      ...t,
      function: { ...t.function, name: mapped },
    });
  }
  return list;
}

/**
 * 把上游 tool_calls 里的官方工具名还原成下游认识的名字.
 *
 * 与 mergeOfficialTools(下行映射)配对:下行把 bash→run_terminal_command,
 * 上行就把 run_terminal_command→bash,这样下游拿到的工具名与它自己声明的
 * 一致,可以直接派发.
 *
 * 官方原生名(下游从没声明过)原样返回 ---- 不猜,不丢.
 *
 * @param {any} body 上游 chat 响应体(含 choices[].message.tool_calls)
 * @param {Record<string,string>} [unmappedNames] 本次请求用过的下行映射(客户端名→官方名)
 */
/**
 - 把上游 tool_calls 里的官方工具名还原成下游认识的名字.
 - @param {any} body 上游响应体
 - @param {Record<string,string>} [unmappedNames] 本次请求的下行映射
 - @returns {any} 还原后的响应体
 */
export function unmapToolCalls(body, unmappedNames = {}) {
  if (!body || typeof body !== 'object') return body
  const choices = Array.isArray(body.choices) ? body.choices : []
  // 本次请求里客户端实际声明过的官方名 → 还原回客户端名.
  // 优先用调用方给的精确表(同一官方名可能被多个客户端名映射到,
  // 只有本次声明过的那个才是正确的还原目标).
  const back = {}
  for (const [client, official] of Object.entries(unmappedNames || {})) {
    if (!back[official]) back[official] = client
  }
  for (const ch of choices) {
    const tc = ch?.message?.tool_calls
    if (!Array.isArray(tc)) continue
    for (const call of tc) {
      const officialName = call?.function?.name
      if (!officialName) continue
      const clientName = back[officialName] || UNMAP_TOOLS[officialName]
      if (clientName) call.function.name = clientName
    }
  }
  return body
}
