/**
 * - 门禁规则的唯一真源:阈值,路径分档,白名单语法,扫描根解析.
 *
 * - 唯一真源:同一组数字只在这里定义一处;
 * - 就会变成"文档说 300,脚本判 500",而两边都看起来是对的.所有 check-*.mjs
 * - 只能从这里取常量,不得在自己文件里再写一份数字.
 *
 * - 扫描根与白名单路径都可用环境变量覆盖 ---- 负向探针靠这个把夹具指进临时目录,
 *
 * - 决策记录:.agents/notes/implemented/process/2026-10-05-code-quality-redlines.md
 */
import fs from 'node:fs'
import path from 'node:path'

/** 扫描根(探针用 CHECK_ROOT 指到临时目录). */
export const ROOT = process.env.CHECK_ROOT ?? process.cwd()

/** 白名单文件(探针用 CHECK_WHITELIST 指到夹具). */
export const WHITELIST_PATH =
  process.env.CHECK_WHITELIST ?? path.join(ROOT, '.gates/whitelist.txt')

/** 棘轮基线目录. */
export const BASELINE_DIR = process.env.CHECK_BASELINE_DIR ?? path.join(ROOT, '.gates')

/**
 * - 体量与结构的硬阈值.
 *
 * - backend / frontend 是用户指定的硬标准(300 / 500 行),不是统计分位数
 * - ---- 因此不按 p90 调整,存量用逐文件棘轮过渡.
 */
export const LIMITS = {
  backendFileLines: 300,
  frontendFileLines: 500,
  dirFiles: 5,
  functionLines: 80,
  lineLength: 120,
}

/**
 * - 路径分档:后端 / 前端 / 豁免.
 *
 */
export const TIERS = {
  frontend: ['dashboard/'],
  exempt: ['.agents/', '.gates/', 'docs/', 'data/', 'data-test/', 'node_modules/', 'tools/', 'src/catalog/'],
}

/** 代码扩展名(计入体量/目录数/格式/注释门禁的集合). */
export const CODE_EXT = ['.ts', '.css', '.html']

/** 参与函数长度与类型门禁的扩展名(需要 AST / tsc 的集合). */
export const AST_EXT = ['.ts']

/** git ls-files 之外需要额外忽略的产物路径(glob 前缀). */
export const IGNORE_PATHS = ['dashboard/version.json', 'package-lock.json']

/** 判定一个仓库内路径属于哪一档. */

/**
 * - 见上方模块说明.
 *
 * - @param {string} rel 仓库相对路径
 * - @returns {'backend'|'frontend'|'exempt'} 档位
 */
export function tierOf(rel) {
  if (TIERS.exempt.some((p) => rel.startsWith(p))) return 'exempt'
  if (TIERS.frontend.some((p) => rel.startsWith(p))) return 'frontend'
  return 'backend'
}

/** 该文件的行数上限(exempt 返回 Infinity). */

/**
 * - 见上方模块说明.
 *
 * - @param {string} rel 仓库相对路径
 * - @returns {number} 行数上限(豁免档为 Infinity)
 */
export function lineLimitOf(rel) {
  const tier = tierOf(rel)
  if (tier === 'frontend') return LIMITS.frontendFileLines
  if (tier === 'backend') return LIMITS.backendFileLines
  return Number.POSITIVE_INFINITY
}

/**
 * - 超限时给出的可操作修复路径 ---- 必须落在这个文件自己的目录下.
 *
 */

/**
 * - 见上方模块说明.
 *
 * - @param {string} rel 仓库相对路径
 * - @returns {string} 修复提示
 */
export function splitHintOf(rel) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.'
  const limit = lineLimitOf(rel)
  return `按职责拆成 ${dir}/<域>/* 子目录，每个文件 ≤ ${limit} 行`
}

/** 是否是参与门禁的代码文件. */

/**
 * - 见上方模块说明.
 *
 * - @param {string} rel 仓库相对路径
 * - @returns {boolean} 是否参与门禁
 */
export function isCodeFile(rel) {
  if (IGNORE_PATHS.includes(rel)) return false
  if (tierOf(rel) === 'exempt') return false
  return CODE_EXT.some((e) => rel.endsWith(e))
}

/** 是否是参与 AST 门禁的代码文件. */

/**
 * - 见上方模块说明.
 *
 * - @param {string} rel 仓库相对路径
 * - @returns {boolean} 是否参与 AST 门禁
 */
export function isAstFile(rel) {
  return isCodeFile(rel) && AST_EXT.some((e) => rel.endsWith(e))
}

/**
 * - 解析白名单文件.语法(与 skill 模板一致,粒度尽可能细):
 *
 * - # 整行注释
 * - <path>|<N>           行数豁免,且登记上限 N(挂上之后长过 N 依然红)
 * - <path>::<func>       只豁免这一个函数
 * - dir:<path>           目录文件数豁免
 *
 * - 畸形条目(缺 |N,N 不是正整数)会在解析阶段抛错 ---- 静默忽略等于
 * - 把"白名单写错了"伪装成"没有豁免".
 */

/**
 * - 见上方模块说明.
 *
 * - @param {string} [file] 白名单路径
 * - @returns {{files: Map<string, number>, funcs: Set<string>, dirs: Set<string>, raw: string[]}} 解析结果
 */
export function readWhitelist(file = WHITELIST_PATH) {
  const out = { files: new Map(), funcs: new Set(), dirs: new Set(), raw: [] }
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    out.raw.push(text)
    if (text.startsWith('dir:')) {
      out.dirs.add(text.slice(4).trim())
      continue
    }
    if (text.includes('::')) {
      out.funcs.add(text)
      continue
    }
    const [p, n] = text.split('|')
    const num = Number(n)
    if (!p || !Number.isInteger(num) || num <= 0) {
      throw new Error(`白名单语法错误（行数豁免必须写成 <path>|<N>）: ${text}`)
    }
    out.files.set(p.trim(), num)
  }
  return out
}

/** 该文件的行数豁免上限;无豁免返回 null. */

/**
 * - 见上方模块说明.
 *
 * - @param {string} rel 仓库相对路径
 * - @param {{files: Map<string, number>}} wl 白名单
 * - @returns {number|null} 豁免上限;无豁免为 null
 */
export function fileWaiver(rel, wl) {
  return wl.files.has(rel) ? wl.files.get(rel) : null
}

/** 该函数是否有豁免. */

/**
 * - 见上方模块说明.
 *
 * - @param {string} rel 仓库相对路径
 * - @param {string} name 函数名
 * - @param {{funcs: Set<string>}} wl 白名单
 * - @returns {boolean} 是否豁免
 */
export function funcWaived(rel, name, wl) {
  return wl.funcs.has(`${rel}::${name}`)
}

/** 该目录是否有文件数豁免. */

/**
 * - 见上方模块说明.
 *
 * - @param {string} rel 目录相对路径
 * - @param {{dirs: Set<string>}} wl 白名单
 * - @returns {boolean} 是否豁免
 */
export function dirWaived(rel, wl) {
  return wl.dirs.has(rel)
}

/**
 * - 见上方模块说明.
 *
 * - @param {string} [file] 白名单路径
 * - @returns {ReturnType<typeof readWhitelist>} 解析结果
 */
export function loadWhitelist(file = WHITELIST_PATH) {
  try {
    return readWhitelist(file)
  } catch (err) {
    console.error(`usage: ${err.message}`)
    console.error('  语法: <path>|<N> 行数豁免 / <path>::<func> 函数豁免 / dir:<path> 目录豁免')
    process.exit(2)
  }
}
