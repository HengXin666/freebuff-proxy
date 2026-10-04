/**
 - check-sizes —— 一文件一行数的硬上限(后端 300 / 前端 500).
 *
 - 拦什么:单文件行数超过所在档位的上限.
 *
 - 判据真源:rules.mjs 的 LIMITS —— 用户指定的硬标准,不是本仓统计分位数,
 - 因此不按 p90 调整.存量用逐文件棘轮(.gates/sizes-baseline.json)过渡:
 - 已超限的文件以当前行数为上限,只拦继续增长;拆完后跑 --update 把水位降下来.
 *
 - 为什么不做成"全仓立刻清零":那会变成一个几万行的重构 PR,没人能审,
 - 真正的重构也会被淹没.棘轮让"新增即红"今天就生效.
 *
 - 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { LIMITS, fileWaiver, loadWhitelist, splitHintOf, tierOf } from '../../rules.mjs'
import { codeFiles, lineCount, readText } from '../../lib/scan/files.mjs'
import { Report } from '../../lib/text/report.mjs'
import { readBaseline, reconcile, writeBaseline } from '../../lib/text/ratchet.mjs'

const BASELINE = 'sizes-baseline.json'
const report = new Report('sizes')
const wl = loadWhitelist()

/** 实测每个受控文件的原始行数. */
function survey() {
  const lines = {}
  for (const rel of codeFiles()) lines[rel] = lineCount(readText(rel))
  return lines
}

const lines = survey()
const over = {}
const tierCounts = { backend: 0, frontend: 0 }
for (const [rel, n] of Object.entries(lines)) {
  const waiver = fileWaiver(rel, wl)
  const limit = waiver ?? (tierOf(rel) === 'frontend' ? LIMITS.frontendFileLines : LIMITS.backendFileLines)
  if (n > limit) {
    over[rel] = n
    tierCounts[tierOf(rel)]++
  }
  // 带了豁免却把登记上限突破了 —— 直接红(豁免不是空白支票).
  if (waiver !== null && n > waiver) {
    report.add(rel, 1, `豁免上限 ${waiver} 行已被突破（当前 ${n} 行）`, '继续拆分，或与用户确认后调高 |N')
  }
}

const { entries } = readBaseline(BASELINE)
const { grown, shrunk, fresh } = reconcile(over, entries)

for (const [rel, was, now] of grown) {
  report.add(rel, 1, `${now} 行 > 上限 ${limitLabel(rel)}（基线水位 ${was}）`, splitHintOf(rel))
}
for (const rel of fresh) {
  report.add(rel, 1, `${over[rel]} 行 > 上限 ${limitLabel(rel)}（不在基线内）`, splitHintOf(rel))
}

// 陈旧豁免:白名单登记了却已经不超限 = 该删的条目(双向校验).
for (const rel of wl.files.keys()) {
  const n = lines[rel]
  if (n === undefined) {
    report.add('.gates/whitelist.txt', 0, `陈旧豁免：${rel} 已不存在`, '删除该条目')
  } else if (n <= (tierOf(rel) === 'frontend' ? LIMITS.frontendFileLines : LIMITS.backendFileLines)) {
    report.add('.gates/whitelist.txt', 0, `陈旧豁免：${rel} 已降到 ${n} 行，不再超限`, '删除该条目')
  }
}

if (process.argv.includes('--update')) {
  writeBaseline(BASELINE, over, { note: '体量棘轮：逐文件当前行数水位，只许降不许涨' })
  report.note('已重录体量基线')
} else if (shrunk.length > 0) {
  report.note(`${shrunk.length} 个文件已降到水位之下，请 --update 重录`)
}

report.note(
  `扫描 ${Object.keys(lines).length} 个文件；超限 ${Object.keys(over).length} 个` +
    `（后端 ${tierCounts.backend} / 前端 ${tierCounts.frontend}）；` +
    `基线 ${Object.keys(entries).length} 个`,
)

/** 该文件的上限说明(用于报错文案). */
function limitLabel(rel) {
  return tierOf(rel) === 'frontend' ? `${LIMITS.frontendFileLines} 行` : `${LIMITS.backendFileLines} 行`
}

process.exit(report.finish())
