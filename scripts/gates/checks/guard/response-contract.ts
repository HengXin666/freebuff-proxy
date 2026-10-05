/**
 * check-response-contract ---- 上游响应契约的对账与棘轮.
 *
 *
 *   1. 常量本身自洽:字段名/判据码非空,不重复.重复的常量意味着同一事实
 *      有两个名字,那正是这个文件要消灭的东西.
 *   2. 快照与常量一致:docs/reverse/upstream-response-contract.json 必须
 *      与 src/upstream/response-contract.ts 声明完全相同(双向比对).
 *      上游改了字段名 → 只改常量一处 → 重生成快照 → 门禁转绿;快照忘更新会红.
 *   3. 裸字段读取只许降不许涨(棘轮):在真源之外的地方直接写
 *      .rateLimitsByModel / 'freebucksShortfall' 这类字面量,逐文件计数,
 *      只拦新增.存量(15 个文件读 rateLimitsByModel)不要求今天就清,
 *      但新的读取必须从真源取常量.
 *
 * 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.ts'
import { trackedFiles } from '../../lib/scan/files.ts'
import { Report } from '../../lib/text/report.ts'
import { readBaseline, reconcile, writeBaseline } from '../../lib/text/ratchet.ts'

const BASELINE = 'response-contract-baseline.json'
const TRUTH = 'src/upstream/response-contract.ts'
const SNAPSHOT = 'docs/reverse/upstream-response-contract.json'
const report = new Report('response-contract')

/** 真源之外允许出现裸字面量的地方(它们本身就是"关于字段名"的文档或夹具). */
const LITERAL_EXEMPT = [
  TRUTH,
  'docs/',
  'test/',
  'scripts/gates/',
  '.agents/',
  'cli-bridge/',
  'src/catalog/',
]

/** 只扫这些目录找裸字面量(产品运行时代码). */
const SCAN_ROOTS = ['src/', 'bin/']

let mod
try {
  mod = await import(`file://${path.join(ROOT, TRUTH)}`)
} catch (err) {
  report.add(TRUTH, 0, `无法加载真源: ${err.message}`, '修好模块语法后再跑')
  process.exit(report.finish())
}

/**
 * 校验一组常量:非空,无重复,无空串.
 * @param {string} label 组名(用于报错)
 * @param {string[]} values 常量值列表
 * @returns {number} 发现的问题数
 */
function checkConstants(label, values) {
  let bad = 0
  if (values.length === 0) {
    report.add(TRUTH, 0, `${label} 为空 —— 契约真源不允许没有条目`, '补上常量')
    return 1
  }
  const seen = new Map()
  for (const v of values) {
    if (!v || typeof v !== 'string') {
      report.add(TRUTH, 0, `${label} 含空值`, '删掉或修正该常量')
      bad++
      continue
    }
    seen.set(v, (seen.get(v) ?? 0) + 1)
  }
  for (const [v, n] of seen) {
    if (n > 1) {
      report.add(TRUTH, 0, `${label} 里 ${v} 重复了 ${n} 次`, '同一事实只许有一个常量名')
      bad++
    }
  }
  return bad
}

/** 快照 ↔ 常量双向比对. */
function checkSnapshot(fields, codes) {
  const file = path.join(ROOT, SNAPSHOT)
  if (!fs.existsSync(file)) {
    report.add(SNAPSHOT, 0, '快照不存在（上游改了字段名将无人发现）', 'node scripts/gates/meta/gen-response-contract.ts')
    return
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [key, live] of [['fields', fields], ['codes', codes]]) {
    const snapSet = new Set(snap[key] ?? [])
    const liveSet = new Set(live)
    const missing = [...liveSet].filter((v) => !snapSet.has(v))
    const stale = [...snapSet].filter((v) => !liveSet.has(v))
    if (missing.length) {
      report.add(SNAPSHOT, 0, `${key} 快照缺少 ${missing.length} 项（常量已加、快照未同步）：${missing.slice(0, 6).join(', ')}`, '重生成快照')
    }
    if (stale.length) {
      report.add(SNAPSHOT, 0, `${key} 快照多出 ${stale.length} 项（常量已删、快照未同步）：${stale.slice(0, 6).join(', ')}`, '重生成快照')
    }
  }
}

/** 统计每个字段名在真源之外被裸读的次数(棘轮观测值). */
function surveyLiterals(fields, codes) {
  const observed = {}
  const patterns = [
    ...fields.map((f) => ({ name: f, re: new RegExp(`[.'"\`]${escapeRe(f)}['"\`]`, 'g') })),
    ...codes.map((c) => ({ name: c, re: new RegExp(`['"\`]${escapeRe(c)}['"\`]`, 'g') })),
  ]
  for (const rel of trackedFiles()) {
    if (!SCAN_ROOTS.some((p) => rel.startsWith(p))) continue
    if (LITERAL_EXEMPT.some((p) => rel.startsWith(p))) continue
    let text
    try {
      text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    } catch {
      continue
    }
    for (const { name, re } of patterns) {
      const hits = text.match(re)
      if (!hits) continue
      observed[`${rel}::${name}`] = hits.length
    }
  }
  return observed
}

/** 正则转义. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const fields = mod.REQUIRED_FIELDS ?? []
const codes = mod.REQUIRED_CODES ?? []
checkConstants('REQUIRED_FIELDS', fields)
checkConstants('REQUIRED_CODES', codes)
checkSnapshot(fields, codes)

const observed = surveyLiterals(fields, codes)
const { entries } = readBaseline(BASELINE)
const { grown, fresh, shrunk } = reconcile(observed, entries)
for (const [key, was, now] of grown) {
  const [file, name] = key.split('::')
  report.add(file, 0, `裸读上游字段 ${name} 从 ${was} 次涨到 ${now} 次`, `从 src/upstream/response-contract.ts 取常量，不要写字面量`)
}
for (const key of fresh) {
  const [file, name] = key.split('::')
  report.add(`${file}`, 0, `新增裸读上游字段 ${name}（${observed[key]} 次）`, '从 src/upstream/response-contract.ts 取常量')
}
if (shrunk.length > 0) {
  report.note(`${shrunk.length} 处裸读已消除，请 --update 重录`)
}

if (process.argv.includes('--update')) {
  writeBaseline(BASELINE, observed, {
    note: '上游响应字段/判据码的裸读棘轮：只许降不许涨；新增读取必须从 response-contract.ts 取常量',
  })
  report.note('已重录响应契约基线')
}

report.note(
  `字段 ${fields.length} 个 / 判据码 ${codes.length} 个；` +
    `裸读分布 ${Object.keys(observed).length} 处（基线 ${Object.keys(entries).length} 处）`,
)

process.exit(report.finish())
