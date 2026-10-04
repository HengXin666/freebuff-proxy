/**
 - 受控文件集合的唯一来源:git ls-files 减去豁免档.
 *
 - 为什么不用 fs.readdir 递归:门禁要判的是"仓库里受控的东西",未跟踪的
 - 产物,node_modules,临时夹具都不该进入判据.git ls-files 同时也是
 - lane 覆盖率检查(每个顶层条目都必须被认领)的输入.
 *
 - 扫描根可被 CHECK_ROOT 覆盖,探针据此把夹具放进临时目录并 git init.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, isAstFile, isCodeFile, tierOf } from '../../rules.mjs'

/**
 - 仓库内受控文件列表(相对路径,正斜杠).
 *
 * ## 为什么必须包含未跟踪文件(实测踩到, 这是本门禁体系最大的盲区)
 *
 * 只用 git ls-files 时, 未跟踪文件对全部门禁完全隐形:
 *
 *     $ printf 'export const x = 1\n%.0s' {1..400} > src/proxy/_probe.ts
 *     $ node scripts/gates/checks/size/sizes.mjs | grep -c _probe   -> 0 (看不见)
 *     $ git add -N src/proxy/_probe.ts
 *     $ node scripts/gates/checks/size/sizes.mjs | grep -c _probe   -> FAIL (400 行)
 *
 * 后果比"漏一个文件"严重得多: 并行重构期间新拆出来的文件全都是未跟踪的
 * (实测当时有 45 个), 于是
 *   1. sizes / dirs / functions / notes / style 对它们一律零命中;
 *   2. fingerprint 的接线指纹输入同样来自这里, 门禁文件没 add 时改它不会被发现
 *      -- 管门禁还跑不跑这条兜底被直接削弱;
 *   3. 综合起来, 门禁全绿在 git add 之前恒真.
 *
 * 因此这里用 --cached --others --exclude-standard(已跟踪 + 未跟踪但不含
 * .gitignore 忽略项). 忽略项仍被排除, 因为它们是产物/数据, 不属于受控代码.
 * @param {string} [root] 扫描根(探针用)
 * @returns {string[]} 相对路径列表
 */
export function trackedFiles(root = ROOT) {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8' },
    )
    return [...new Set(out.split('\0').filter(Boolean))]
  } catch {
    // 探针夹具可能没有 git;退化为按目录遍历,仅用于夹具场景(小目录).
    return walk(root).map((p) => path.relative(root, p).split(path.sep).join('/'))
  }
}

/** 递归列目录下的文件(无 git 时的退化路径). */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/**
 - 受控代码文件(体量/目录/格式/注释门禁的输入).
 - @param {string} [root] 扫描根
 - @returns {string[]} 相对路径列表
 */
export function codeFiles(root = ROOT) {
  return trackedFiles(root).filter((f) => isCodeFile(f) && fs.existsSync(path.join(root, f)))
}

/**
 - 受控 AST 文件(函数长度/类型门禁的输入).
 - @param {string} [root] 扫描根
 - @returns {string[]} 相对路径列表
 */
export function astFiles(root = ROOT) {
  return codeFiles(root).filter((f) => isAstFile(f))
}

/**
 - 按档位过滤受控代码文件.
 - @param {'backend'|'frontend'|'exempt'} tier 目标档位
 - @param {string} [root] 扫描根
 - @returns {string[]} 相对路径列表
 */
export function filesOfTier(tier, root = ROOT) {
  return codeFiles(root).filter((f) => tierOf(f) === tier)
}

/**
 - 读文件为 UTF-8.
 - @param {string} rel 相对路径
 - @param {string} [root] 扫描根
 - @returns {string} 文件内容
 */
export function readText(rel, root = ROOT) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

/**
 - 行数(按换行符切;末尾无换行的最后一行也算一行).
 - @param {string} text 文件内容
 - @returns {number} 行数
 */
export function lineCount(text) {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}
