/**
 - 官方 system 模板的渲染 -- 从 cli-bridge/upstream.ts 逐字搬出.
 - 模板里的动态区块必须按当前请求填充, 否则等于每次都告诉上游"我要建那个文件".
 */
/**
 * manager 层 system 的 mission 段是动态的:抓包提取的模板里嵌着
 * 当时那条用户消息(USER_TURN_MARKER: create file /tmp/user-turn-proof.txt...).
 * 原样发出等于每次都告诉上游"我要建这个文件" ---- 必须按当前请求替换.
 *
 * 模板尾部形态(抓包 line 14):
 *   ...固定前缀...

{mission}

Call the decide tool exactly once. ...
 *
 * @param {string} tpl manager 模板
 * @param {string} mission 当前用户消息
 */
/**
 - 把 manager 模板里的 mission 段替换成当前用户消息.
 - @param {string} tpl 模板
 - @param {string} mission 当前用户消息
 - @returns {string} 渲染后的 system
 */
export function renderManagerSystem(tpl, mission) {
  let out = String(tpl || '');
  // 替换 "Call the decide tool" 之前,最后一个空行之后的整段为当前 mission
  const anchor = '\n\nCall the `decide` tool';
  const ai = out.lastIndexOf(anchor);
  if (ai > 0) {
    // 找 anchor 之前最后一个空行,作为 mission 起点
    const head = out.slice(0, ai);
    const cut = head.lastIndexOf('\n\n');
    if (cut > 0) {
      out = head.slice(0, cut) + '\n\n' + String(mission || '') + out.slice(ai);
    }
  }
  return out;
}

/**
 * 生成 worker 层 system(官方模板 + 动态区块填充).
 *
 * 官方模板含两个动态区块 <repository_stats> / <changed_file_paths>,
 * 以及一句 "Current date: ...". 抓包快照里这几处是冻住的, 必须每次重算;
 * 形态与官方一致的判据见 .agents/notes/implemented/bug-fix/2026-10-06-system-template-dynamic-sections.md
 */
/**
 - 填充 worker 模板的动态区块(repository_stats / changed_file_paths / 日期).
 - @param {string} tpl 模板
 - @param {{date?: string, repositoryStats?: string, changedFilePaths?: string}} [opts] 动态值
 - @returns {string} 渲染后的 system
 */
export function renderWorkerSystem(tpl, opts = {}) {
  const date = opts.date
    || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  let out = String(tpl || '');
  out = out.replace(/Current date: [^\n]*/, `Current date: ${date}.`);
  /**
   * <repository_stats> 的内容是[换行分隔的 key: value 行], 不是 JSON.
   *
   * 官方把 stats 逐行拼出来, 没有值的行直接不发(见 orchestrator 的 stats 数组).
 * 形态必须是换行分隔的 key: value 行, 不是 JSON.
   * 我们此前发的是 JSON 字符串, 形态与官方完全不同 ---- 那本身就是第三方客户端
   * 信号. 这里按官方形态生成; 没有 git 时只留官方也一定会有的那一行.
   */
  out = out.replace(/<repository_stats>[\s\S]*?<\/repository_stats>/, (m) => {
    if (opts.repositoryStats) return String(opts.repositoryStats);
    return `<repository_stats>\nrepository_visibility: unknown\n${closeTagOf(m)}`
  })
  /**
   * Changed file paths 那行本身也是动态的:
   *   有 git: 'Changed file paths (N):' / 'Changed file paths (showing a of b):'
   *   无 git: 'Changed file paths (unavailable):' 且块内是固定的 unavailable 文案.
   * 我们此前把块内替换成空串 ---- 官方从不发空块, 空块同样是不一致.
   */
  // 整块替换(开标签到闭标签), 不逐标签替换 ---- 逐标签替换会在模板里已有
  // 占位文案时把它重复注入一遍(实测出现两行 unavailable).
  const files = Array.isArray(opts.changedFilePaths) ? opts.changedFilePaths : null
  const hasFiles = Boolean(files && files.length > 0)
  out = out.replace(/<changed_file_paths>[\s\S]*?<\/changed_file_paths>/, (m) => {
    const close = closeTagOf(m)
    const body = hasFiles ? files.join('\n') : '(Git metadata unavailable to this host)'
    return `<changed_file_paths>\n${body}\n${close}`
  })
  out = out.replace(
    /Changed file paths \([^)]*\):/,
    `Changed file paths (${hasFiles ? files.length : 'unavailable'}):`,
  )
  return applyPlaceholders(out, opts)
}

/**
 * 替换官方占位符 {CODEBUFF_*}.
 *
 * 语法沿用官方(见 orchestrator 的 PLACEHOLDER): 形如 {CODEBUFF_CURRENT_DATE},
 * 简单字符串替换, 未知占位符替换成空串 ---- 与官方行为一致.
 * 这样用户从官方模板里抄来的占位符在我们这里也能直接用.
 *
 * 只填我们能填的: 其余占位符的取值来自[客户端本地上下文](git 仓库 / 文件树 /
 * cwd / 系统信息 / 知识文件), 本代理不接触用户机器, 无从获知, 只能按官方[没有值
 * 就空串]的行为处理.
 *
 * @param {string} text 已渲染的文本
 * @param {any} opts 动态值(date / userInput / agentName / initialPrompt / stepsRemaining)
 * @returns {string} 替换后的文本
 */
function applyPlaceholders(text, opts) {
  const now = new Date()
  const values = {
    CURRENT_DATE: typeof opts.date === 'string' && opts.date
      ? opts.date
      : now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    AGENT_NAME: typeof opts.agentName === 'string' && opts.agentName
      ? opts.agentName
      : 'Buffy',
    USER_INPUT_PROMPT: typeof opts.userInput === 'string' ? opts.userInput : '',
    INITIAL_AGENT_PROMPT: typeof opts.initialPrompt === 'string' ? opts.initialPrompt : '',
    REMAINING_STEPS: Number.isFinite(opts.stepsRemaining) ? String(opts.stepsRemaining) : '',
  }
  return PLACEHOLDER_NAMES.reduce(
    // 取不到就换成空串: 必须显式给 '' ---- 传 undefined 会让 replaceAll 把
    // 占位符替换成字符串 "undefined"(实测).
    (acc, name) => acc.replaceAll(`{CODEBUFF_${name}}`, values[name] ?? ''),
    text,
  )
}

/**
 * 官方占位符名单(取自 orchestrator 的 placeholderNames, 顺序照抄).
 *
 * 我们只对其中五个有值(见 applyPlaceholders); 另外八个的取值来自客户端本地
 * 上下文, 本代理拿不到 ---- 替换成空串, 与官方[没有值就空串]一致.
 */
const PLACEHOLDER_NAMES = [
  'AGENT_NAME',
  'CURRENT_DATE',
  'FILE_TREE_PROMPT_SMALL',
  'FILE_TREE_PROMPT',
  'FILE_TREE_PROMPT_LARGE',
  'GIT_CHANGES_PROMPT',
  'INITIAL_AGENT_PROMPT',
  'KNOWLEDGE_FILES_CONTENTS',
  'PROJECT_ROOT',
  'REMAINING_STEPS',
  'SYSTEM_INFO_PROMPT',
  'USER_CWD',
  'USER_INPUT_PROMPT',
]

export { PLACEHOLDER_NAMES, applyPlaceholders }

/**
 * 取某个开标签对应的闭标签原样文本(用于保持模板里的闭标签写法).
 *
 * @param {string} block 匹配到的整块
 * @returns {string} 闭标签
 */
function closeTagOf(block) {
  const m = String(block).match(/<\/[a-z_]+>/)
  return m ? m[0] : '</repository_stats>'
}
