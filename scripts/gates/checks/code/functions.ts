/**
 - check-functions ---- 函数长度上限(AST 判据).
 *
 - 拦什么:单个函数体超过 LIMITS.functionLines 行.一个 2000 行的函数不可能
 - 被正确修改,它同时是"改一处坏一片"的结构性根源,也是本仓最长那条链
 - (createProxyHandler 2109 行)的成因.
 *
 - 为什么必须用 AST 而不是正则:正则数不清箭头函数,方法,嵌套闭包的边界,
 - 也分不清字符串里的 function.误报会让人把整条门禁关掉.
 *
 - 注释规范(导出 JSDoc / @param 一致性)不在这里 ---- 那属于 check-notes.
 - 一个判据只在一个脚本里存在,否则两边各改一半就会漂移.
 *
 - 存量:写于本门禁之前的超长函数按 文件::函数名 → 行数 登记在
 - .gates/functions-baseline.json,只许降不许涨(拆小后跑 --update 重录).
 *
 - 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { LIMITS, funcWaived, loadWhitelist } from '../../rules.ts'
import { astFiles } from '../../lib/scan/files.ts'
import { Report } from '../../lib/text/report.ts'
import { readBaseline, reconcile, writeBaseline } from '../../lib/text/ratchet.ts'
import { isFunctionLike, nameOf, parseFile, spanOf, walk } from '../../lib/scan/ast.ts'

const BASELINE = 'functions-baseline.json'
const report = new Report('functions')
const wl = loadWhitelist()

/** 实测所有超限函数:key = 文件::函数名 → 行数. */
function survey() {
  const over = {}
  let total = 0
  for (const rel of astFiles()) {
    let sf
    try {
      sf = parseFile(rel)
    } catch (err) {
      report.add(rel, 1, `解析失败: ${err.message}`, '修语法后重跑（解析失败不许静默跳过）')
      continue
    }
    walk(sf, (node) => {
      if (!isFunctionLike(node)) return
      total++
      const name = nameOf(sf, node)
      const { lines } = spanOf(sf, node)
      if (lines <= LIMITS.functionLines) return
      if (funcWaived(rel, name, wl)) return
      over[`${rel}::${name}`] = Math.max(over[`${rel}::${name}`] ?? 0, lines)
    })
  }
  return { over, total }
}

const { over, total } = survey()
const { entries } = readBaseline(BASELINE)
const { grown, shrunk, fresh } = reconcile(over, entries)

for (const [key, was, now] of grown) {
  const [file, fn] = key.split('::')
  report.add(
    file,
    0,
    `${fn} 从 ${was} 行涨到 ${now} 行 > 上限 ${LIMITS.functionLines}`,
    '按职责抽子函数：把闭包依赖的状态收进一个对象参数，逐个搬出去',
  )
}
for (const key of fresh) {
  const [file, fn] = key.split('::')
  report.add(
    file,
    0,
    `${fn} 有 ${over[key]} 行 > 上限 ${LIMITS.functionLines}（不在基线内）`,
    '按职责抽子函数，或把状态封装进对象',
  )
}

if (process.argv.includes('--update')) {
  const file = writeBaseline(BASELINE, over, { note: `函数长度棘轮（上限 ${LIMITS.functionLines} 行）：逐函数当前行数，只许降不许涨` })
  report.note(`已重录基线: ${file}（${Object.keys(over).length} 个超限函数）`)
} else if (shrunk.length > 0) {
  report.note(`${shrunk.length} 个函数已拆小，请 --update 重录基线`)
}
report.note(`扫描 ${total} 个函数，超上限 ${Object.keys(over).length} 个；基线 ${Object.keys(entries).length} 个`)

process.exit(report.finish())
