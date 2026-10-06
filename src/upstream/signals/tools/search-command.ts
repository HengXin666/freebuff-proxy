/**
 * 官方 code_search 参数 -> 一条 ripgrep 命令.
 *
 * 为什么落成命令而不是同名工具: 下游那个同名 code_search 要求[绝对搜索目录], 而上游
 * 不会把这个路径给下来 ---- 官方 cwd 是[相对项目根], 语义与形态都不是绝对路径.
 * 命令执行天然在会话工作目录里跑, 相对路径直接可用, 不需要任何按机器配置的根.
 *
 * 官方 flags 参数的文档原文就是 Advanced ripgrep flags(-i / -t ts / -g *.ts / -A 3),
 * 所以逐个引号包住原样交给 rg; 引号同时挡住 shell 对 *.ts 之类做通配展开.
 *
 * 见 .agents/notes/implemented/bug-fix/2026-10-06-downstream-code-search-mapping.md
 */

/**
 * 单引号包裹一个 shell 参数(内部的单引号按 POSIX 规则转义).
 *
 * @param {string} value 原始参数
 * @returns {string} 可直接拼进命令行的文本
 */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 该官方形态参数是不是 code_search 的载荷.
 *
 * 判据是 pattern 字段: run_terminal_command 的载荷只有 command / cwd /
 * timeout_seconds / process_type, 两者不会撞.
 *
 * @param {any} src 官方形态参数
 * @returns {boolean} 是搜索载荷为真
 */
export function isSearchPayload(src: any): boolean {
  return typeof src?.pattern === 'string'
}

/**
 * 把官方 code_search 参数合成一条命令.
 *
 * 搜索根省略时用 [.]: 命令在会话工作目录里跑, 那就是[整个项目]. rg 不在 PATH 时
 * 退到 grep ---- 官方 flags 是 rg 方言, 回退路径不带它们(带上只会让 grep 报错).
 *
 * @param {any} src 官方形态参数
 * @returns {string} 命令行文本
 */
export function buildSearchCommand(src: any): string {
  const pattern = typeof src?.pattern === 'string' ? src.pattern : ''
  const flags = typeof src?.flags === 'string' ? src.flags.trim() : ''
  const root = typeof src?.cwd === 'string' && src.cwd.trim() ? src.cwd.trim() : '.'
  const max = Number.isInteger(src?.maxResults) && src.maxResults > 0 ? src.maxResults : null

  const rg = ['rg', '-n', '--no-heading', '--color', 'never']
  if (max !== null) rg.push('-m', String(max))
  if (flags) for (const token of flags.split(/\s+/).filter(Boolean)) rg.push(quote(token))
  rg.push('-e', quote(pattern), '--', quote(root))

  const grep = ['grep', '-rn', '-E', '--', quote(pattern), quote(root)]
  return `if command -v rg >/dev/null 2>&1; then ${rg.join(' ')}; else ${grep.join(' ')}; fi`
}
