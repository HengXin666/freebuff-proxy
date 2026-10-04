/**
 - check-lanes —— 分流表覆盖(lane 元门禁).
 *
 - 拦什么:仓库顶层的某个条目没有任何 lane 或豁免名单认领.症状是"改了
 - 东西却一条门禁都不跑",而它在 hook 运行时完全看不出来(不报错,不输出).
 - 这是分流设计里唯一必须自动化的一环.
 *
 - 判据真源:lanes.mjs 的 LANES / NO_GATE_PREFIXES,与 Stop hook 共用同一张表.
 - 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { execFileSync } from 'node:child_process'

import { ROOT } from '../../rules.mjs'
import { Report } from '../../lib/text/report.mjs'
import { LANES, NO_GATE_PREFIXES } from '../../lanes.mjs'

const report = new Report('lanes')

/** 仓库顶层条目(第一段路径). */
function topLevelEntries() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  const set = new Set()
  for (const line of out.split('\n')) {
    if (!line) continue
    set.add(line.includes('/') ? `${line.split('/')[0]}/` : line)
  }
  return [...set].sort()
}

const claimed = new Set()
for (const lane of Object.values(LANES)) for (const p of lane.prefixes) claimed.add(p)
const exempt = new Set(NO_GATE_PREFIXES)

const unclaimed = topLevelEntries().filter((e) => !claimed.has(e) && !exempt.has(e))
for (const e of unclaimed) {
  report.add(e, 0, `顶层条目 ${e} 没有被任何 lane 认领`, `在 scripts/gates/lanes.mjs 的 LANES 里加前缀，或写进 NO_GATE_PREFIXES 并给出理由`)
}

report.note(
  `lane ${Object.keys(LANES).length} 条，认领前缀 ${claimed.size} 个，` +
    `豁免 ${exempt.size} 个，顶层条目 ${topLevelEntries().length} 个`,
)
process.exit(report.finish())
