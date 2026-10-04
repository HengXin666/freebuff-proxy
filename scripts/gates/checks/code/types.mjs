/**
 - check-types —— 类型标注红线(用本仓已有的 tsc,不引入新工具).
 *
 - 拦什么:checkJs 类型错误数比基线涨了.
 *
 - 两份 project 分别跑,合并计数(后端 tsconfig.json / 前端
 - tsconfig.dashboard.json):后端要纯 ES2022,前端要 DOM lib.
 - 合成一份 project 会让前端满屏 "document is not defined" —— 那是环境声明
 - 缺失而不是类型问题,混进基线只会把数字灌成噪音.
 *
 - 为什么用棘轮而不是"全绿":tsconfig.json 此前是 checkJs: false,
 - 等于解析 JS 但不检查 —— "配置已存在但从不执行"是最常见的伪红线形态
 - (不是"没有配置",因此更难发现).存量近千条 implicit any,全仓清零是
 - 一个巨大的独立工程,会淹没真正的重构;棘轮让"新增即红"今天就生效.
 *
 - 扫描根:CHECK_ROOT(决定两份 tsconfig 的位置).退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.mjs'
import { Report } from '../../lib/text/report.mjs'
import { readBaseline, reconcile, writeBaseline } from '../../lib/text/ratchet.mjs'

const BASELINE = 'types-baseline.json'
const report = new Report('types')

/** 两份 project:后端(纯 ES2022)与前端(DOM lib). */
const PROJECTS = [
  { name: 'backend', file: 'tsconfig.checkjs.json' },
  { name: 'frontend', file: 'tsconfig.dashboard.json' },
]

/**
 - 跑一次 tsc(--checkJs),返回该 project 的逐文件错误计数.
 - @param {string} project tsconfig 文件(相对仓库根)
 - @returns {Record<string, number>} 文件 → 错误数
 */
function run(project) {
  const tsc = path.join(ROOT, 'node_modules/typescript/bin/tsc')
  if (!fs.existsSync(tsc)) {
    report.add('node_modules/typescript', 0, '找不到 typescript（npm ci 未执行或 node_modules 缺失）', '先 npm ci')
    return {}
  }
  const conf = path.join(ROOT, project)
  if (!fs.existsSync(conf)) return {}
  const args = ['-p', conf, '--noEmit', '--checkJs', '--pretty', 'false']
  let out = ''
  try {
    out = execFileSync(process.execPath, [tsc, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  const counts = {}
  for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+)/gm)) {
    const file = m[1].replace(/\\/g, '/').replace(`${ROOT}/`, '')
    counts[file] = (counts[file] ?? 0) + 1
  }
  return counts
}

const observed = {}
for (const p of PROJECTS) {
  if (!fs.existsSync(path.join(ROOT, p.file))) {
    report.note(`跳过 ${p.name}：${p.file} 不存在`)
    continue
  }
  const counts = run(p.file)
  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  report.note(`${p.name}（${p.file}）：${total} 条 checkJs 错误，涉及 ${Object.keys(counts).length} 个文件`)
  for (const [file, n] of Object.entries(counts)) observed[file] = (observed[file] ?? 0) + n
}

const { entries } = readBaseline(BASELINE)
//  按总数棘轮,不按文件路径(与 sizes/dirs 的逐文件水位刻意不同).
//
// 为什么:拆分一个文件会把它的 checkJs 错误原样搬到新文件路径上.逐文件
// 棘轮于是把这种"搬家"判成 fresh → FAIL,而真实债务一条没多.实测踩到过:
// 前端并行拆分期间,dashboard/views/system/index.js 的 10 条被当成新债.
//
// 总数棘轮正好守住要守的那条线:不许新增类型错误."修掉 A 的 10 条,在 B
// 新增 10 条"确实能保持总数不变,但那不是绕过 —— 净债务没变,且位置移动本身
// 在 diff 里可见.
const observedTotal = Object.values(observed).reduce((s, n) => s + n, 0)
const baselineTotal = entries.__total__ ?? 0
const { grown, shrunk, fresh } = reconcile({ __total__: observedTotal }, { __total__: baselineTotal })
void grown
void fresh

if (shrunk.length > 0) {
  report.note(`类型错误总数已从 ${baselineTotal} 降到 ${observedTotal}，请 --update 重录`)
}
if (observedTotal > baselineTotal) {
  const worst = Object.entries(observed)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([f, n]) => `${f}(${n})`)
    .join(', ')
  report.add(
    '(全部)',
    0,
    `checkJs 类型错误总数从 ${baselineTotal} 涨到 ${observedTotal}（+${observedTotal - baselineTotal}）`,
    `修掉新增的类型错误；错误最多的文件: ${worst}`,
  )
}

if (process.argv.includes('--update')) {
  writeBaseline(BASELINE, { __total__: observedTotal }, {
    note: 'checkJs 类型错误**总数**棘轮（按总数而非逐文件：拆分会让错误平移，逐文件会把搬家误判成新债）',
  })
  report.note(`已重录类型基线: 总数 ${observedTotal}`)
}

report.note(`基线总数 ${baselineTotal} → 本次 ${observedTotal}；文件分布仅作诊断（${Object.keys(observed).length} 个文件）`)

process.exit(report.finish())
