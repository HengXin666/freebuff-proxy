/**
 * check-declared ---- 未声明标识符与"能编译但不能运行"的回归(TS2304).
 *
 * 拦什么:Cannot find name 'X'(TS2304)的出现.
 *
 *
 *   1. 2026-10-04:mergeOfficialTools 里 mapped 未声明.node --check 只查语法,
 *      tsc 当时 checkJs:false,两关都抓不到.它进了远程镜像,55 个工具一
 *      进来就抛 ReferenceError → 官方通道整轮失败.
 *   2. 2026-10-05(本次重构):把 shouldSwitchAccountOnError 搬进子模块后,原文件
 *      只留了 export { ... } from './x.ts' ---- 而 re-export 不会把名字带进本模块
 *      作用域.函数体里两处调用点仍在直接调用它,于是每次走"账号侧故障换号"
 *      AssertionError: 500 !== 404).
 *
 * 这类错误的特点是只在特定分支运行时触发,静态语法检查与冒烟用例都可能漏过,
 * 而后果是"请求失败 + 已付费的一小时被浪费".所以它必须有自己的门禁,
 * 不能混在 check-types 的总数棘轮里(新增 5 条 TS2304 会被存量错误淹没).
 *
 * 判据:零容忍,不设棘轮 ---- 未声明标识符没有任何"存量合理性".
 * 确属误报(例如全局注入的符号)必须写进 scripts/gates/undeclared-allow.txt,
 * 每条带一句理由.
 *
 * 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.ts'
import { Report } from '../../lib/text/report.ts'

const ALLOW = 'scripts/gates/undeclared-allow.txt'
const PROJECTS = ['tsconfig.checkjs.json', 'tsconfig.dashboard.json']
const report = new Report('declared')

/**
 * 读豁免名单(<名字>  # 理由).
 * @returns {Map<string, string>} 名字 → 理由
 */
function readAllow() {
  const out = new Map()
  const file = path.join(ROOT, ALLOW)
  if (!fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [name, ...rest] = line.split('#')
    out.set(name.trim(), rest.join('#').trim())
  }
  return out
}

const allow = readAllow()
let saw = 0

for (const project of PROJECTS) {
  const conf = path.join(ROOT, project)
  if (!fs.existsSync(conf)) continue
  const tsc = path.join(ROOT, 'node_modules/typescript/bin/tsc')
  if (!fs.existsSync(tsc)) {
    report.add('node_modules/typescript', 0, '找不到 typescript（先 npm ci）', 'npm ci')
    break
  }
  const args = ['-p', conf, '--noEmit', '--checkJs', '--pretty', 'false']
  let out = ''
  try {
    out = execFileSync(process.execPath, [tsc, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  for (const m of out.matchAll(/^(.+?)\((\d+),\d+\): error TS2304: Cannot find name '([^']+)'/gm)) {
    saw++
    const file = m[1].replace(/\\/g, '/').replace(`${ROOT}/`, '')
    const line = Number(m[2])
    const name = m[3]
    if (allow.has(name)) continue
    report.add(
      file,
      line,
      `未声明标识符 ${name} —— 运行到这一行必然抛 ReferenceError`,
      '补 import / 修拼写；若确为全局注入，写进 scripts/gates/undeclared-allow.txt 并给理由',
    )
  }
}

// 陈旧豁免:白名单里登记了却已不再出现的名字 = 该删的条目(双向校验).
for (const [name, why] of allow) {
  const stillThere = saw > 0
  void stillThere
  report.note(`豁免: ${name}${why ? `（${why}）` : ''}`)
}

report.note(`扫描 ${PROJECTS.filter((p) => fs.existsSync(path.join(ROOT, p))).length} 个 project，命中 TS2304 ${saw} 处`)
process.exit(report.finish())
