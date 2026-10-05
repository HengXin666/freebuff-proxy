/**
 - check-dirs ---- 同一目录里的受控文件数不得超过 5 个.
 *
 - 拦什么:一个目录直接挂着 6 个以上受控文件(用户硬标准:超过就拆子目录).
 *
 - 判据真源:rules.mjs 的 LIMITS.dirFiles.存量用棘轮(
 - .gates/dirs-baseline.json)过渡;用 dir:<path> 白名单登记的目录表示
 - "确认永远允许"(本仓目前为空 ---- 空是因为硬标准要求拆,拆完就该清).
 *
 - 棘轮的 key 是目录路径,值是该目录的文件数;降了要 --update 重录,
 - 涨了直接红.
 *
 - 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import path from 'node:path'

import { LIMITS, dirWaived, loadWhitelist } from '../../rules.mjs'
import { codeFiles } from '../../lib/scan/files.mjs'
import { Report } from '../../lib/text/report.mjs'
import { readBaseline, reconcile, writeBaseline } from '../../lib/text/ratchet.mjs'

const BASELINE = 'dirs-baseline.json'
const report = new Report('dir-files')
const wl = loadWhitelist()

/** 每个目录直接挂着的受控文件数. */
function survey() {
  const counts = {}
  for (const rel of codeFiles()) {
    const dir = path.posix.dirname(rel)
    counts[dir] = (counts[dir] ?? 0) + 1
  }
  return counts
}

const counts = survey()
const over = {}
for (const [dir, n] of Object.entries(counts)) {
  if (dirWaived(dir, wl)) continue
  if (n > LIMITS.dirFiles) over[dir] = n
}

const { entries } = readBaseline(BASELINE)
const { grown, shrunk, fresh } = reconcile(over, entries)

for (const [dir, was, now] of grown) {
  report.add(
    `${dir}/`,
    0,
    `${now} 个文件 > 上限 ${LIMITS.dirFiles}（基线水位 ${was}）`,
    `按职责拆成 ${dir}/<域>/* 子目录，每个 ≤ ${LIMITS.dirFiles} 个文件`,
  )
}
for (const dir of fresh) {
  report.add(
    `${dir}/`,
    0,
    `${over[dir]} 个文件 > 上限 ${LIMITS.dirFiles}（不在基线内）`,
    `按职责拆成 ${dir}/<域>/* 子目录，每个 ≤ ${LIMITS.dirFiles} 个文件`,
  )
}

for (const dir of wl.dirs) {
  const n = counts[dir] ?? 0
  if (n <= LIMITS.dirFiles) {
    report.add('.gates/whitelist.txt', 0, `陈旧目录豁免：${dir}（当前 ${n} 个文件，未超限）`, '删除该条目')
  }
}

if (process.argv.includes('--update')) {
  writeBaseline(BASELINE, over, { note: '目录文件数棘轮：逐目录当前文件数水位，只许降不许涨' })
  report.note('已重录目录基线')
} else if (shrunk.length > 0) {
  report.note(`${shrunk.length} 个目录已降到水位之下，请 --update 重录`)
}

const max = Math.max(0, ...Object.values(counts))
report.note(`扫描 ${Object.keys(counts).length} 个目录，最大 ${max} 个文件/目录；超限 ${Object.keys(over).length} 个`)

process.exit(report.finish())
