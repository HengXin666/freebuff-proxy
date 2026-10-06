/**
 * check-syntax ---- 语法可解析性(所有门禁的前置).
 *
 * 拦什么:任何受控源文件语法不可解析.
 *
 *
 * ## 两种后缀走两条路(TS 迁移期)
 *
 * - .js / .mjs / .cjs:node --check(它不认 TS 语法).
 * - .ts / .tsx:tsc 的语法级检查(--noCheck --noEmit).
 *   不用 node --check:它对 TS 会报 Unexpected token 'interface'.
 *   也不用完整 tsc:那是 check-types 的职责,本门禁只要"能不能解析".
 *
 * 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.ts'
import { trackedFiles } from '../../lib/scan/files.ts'
import { Report } from '../../lib/text/report.ts'

const report = new Report('syntax')

/** 用 tsc --noCheck 验证的文件后缀. */
const TS_EXT = ['.ts', '.tsx']

/** 豁免:.agents/ 下的 skill 脚本不属于本仓产品代码. */
const EXEMPT = ['.agents/']

/** 扫描面下限:防止根路径/扩展名写错时"零违规"与"什么都没扫"无法区分. */
const MIN_FILES = 20

/**
 * 取受控源文件.
 *
 * 必须过滤"索引里有,磁盘上没有"的路径:git rm 之后索引与磁盘会不同步,
 * 并行重构期间被删掉的文件会在 git ls-files 里滞留,让门禁报出一个
 * 语法不可解析的假阳性(真凶是文件已被删除).告警理由错比不告警更耗时.
 *
 * @returns {string[]} 相对路径
 */
function sourceFiles() {
  return trackedFiles()
    .filter((f) => TS_EXT.some((e) => f.endsWith(e)))
    .filter((f) => !EXEMPT.some((p) => f.startsWith(p)))
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
}

/** 取错误输出的前两行(去掉调用栈). */
function firstLines(stderr) {
  return `${stderr ?? ''}`
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('    at '))
    .slice(0, 2)
    .join(' / ')
}

const files = sourceFiles()
const tsFiles = files.filter((f) => TS_EXT.some((e) => f.endsWith(e)))

if (tsFiles.length > 0) {
  /**
   * tsc 的取值顺序: 先 CHECK_ROOT 下(真实仓库), 再回落到本门禁自己的仓库.
   *
   * 回落是负向探针需要的: 探针把夹具建在临时目录(CHECK_ROOT 指过去),
   * 那里没有 node_modules; 但"能否解析"这件事与 root 在哪无关,
   * 用本仓的 tsc 解析夹具完全等价. 不回落会让语法探针因为"找不到 tsc"
   * 而永久失败(正是本轮 CI 红的原因).
   *
   * 探针夹具与 CI 检出的前提见 .agents/notes/implemented/bug-fix/2026-10-05-ci-checkout-and-probe-fixtures.md.
   */
  const ownRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')
  const tsc = [
    path.join(ROOT, 'node_modules/typescript/bin/tsc'),
    path.join(ownRoot, 'node_modules/typescript/bin/tsc'),
  ].find((p) => fs.existsSync(p))
  if (!tsc) {
    report.add('node_modules/typescript', 0, '存在 .ts 文件但找不到 typescript（先 npm ci）', 'npm ci')
  } else {
    // --noCheck:只解析不做类型检查,正是本门禁想要的粒度.
    const args = ['--noEmit', '--noCheck', '--pretty', 'false', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext']
    let out = ''
    try {
      out = execFileSync(process.execPath, [tsc, ...args, ...tsFiles.map((f) => path.join(ROOT, f))], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (err) {
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    for (const line of out.split('\n')) {
      const m = /^(.+?)\(\d+,\d+\): (error TS\d+: .+)$/.exec(line.trim())
      if (!m) continue
      const rel = m[1].replace(/\\/g, '/').replace(`${ROOT}/`, '')
      report.add(rel, 0, `语法不可解析（tsc 解析阶段）：${m[2]}`, '先修语法；语法错会让 tsc 早退，连带把类型棘轮打成假绿')
    }
  }
}

if (files.length < MIN_FILES) {
  report.add('.', 0, `只扫到 ${files.length} 个文件（下限 ${MIN_FILES}）—— 扫描面可能被写坏`, '检查 CHECK_ROOT / 扩展名 / git ls-files 是否可用')
}

report.note(`tsc 解析 ${tsFiles.length} 个（下限 ${MIN_FILES}）`)
process.exit(report.finish())
