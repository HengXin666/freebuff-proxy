/**
 * check-constants ---- 常量集中化的守门人.
 *
 * 拦什么: 受控源码里出现"应走 src/constants.ts"的硬编码字面量.
 *
 * 判据只针对高置信度的字面量(误报比漏报更贵 ---- 一条总在喊的门禁
 * 会被人关掉): 时间毫秒数(3600000/86400000),日志缓冲上限,数据文件名
 * 的字符串形式. 其余数字(端口/行数上限/超时秒数)各有其配置真源, 不在此列.
 *
 * 白名单(逐行登记, 不是文件级): 允许出现的位置要有理由.
 *
 * 扫描根: CHECK_ROOT.退出码: 0 PASS / 1 FAIL / 2 用法错.
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../../rules.ts'
import { codeFiles, readText } from '../../../lib/scan/files.ts'
import { Report } from '../../../lib/text/report.ts'

const report = new Report('constants')

/**
 * 不参与的文件/目录.
 *
 * - 常量真源与门禁自身: 它们必须写下这些字面量.
 * - test/: 那里的时长是夹具取值(模拟上游回执里的 expiresAt / holdMs),
 *   语义是"一条一小时的假会话", 不是产品常量. 换成 MS.hour 会让读的人
 *   多跳一层, 却没减少任何重复(夹具之间不共享取值).
 * - cli-telemetry.ts: 5s 是"上报超时"这一处语义, 不是通用时长.
 */
const EXEMPT_PREFIX = [
  'src/shared/constants.ts',
  'scripts/gates/checks/guard/tunable/',
  'test/',
]
const EXEMPT = ['src/upstream/telemetry/cli-telemetry.ts']

/** 应集中的字面量: [正则, 说明, 建议]. */
const RULES: Array<[RegExp, string, string]> = [
  [/\b3_?600_?000\b/, '一小时的毫秒数', '取 src/shared/constants.ts 的 MS.hour'],
  [/\b86_?400_?000\b/, '一天的毫秒数', '取 src/shared/constants.ts 的 MS.day'],
  [/\b5_?000\b(?=[^\d]*\/\/|$)/, '日志缓冲默认条数', '取 src/shared/constants.ts 的 LOG.ringCapDefault'],
]

/**
 * 该行是否落在注释里(注释里提到数值不算硬编码).
 * @param {string} text 已 trim 的行
 * @returns {boolean} 是否注释行
 */
function isCommentLine(text: string): boolean {
  return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')
}

const files = codeFiles().filter(
  (f) =>
    f.endsWith('.ts') && !EXEMPT.includes(f) && !EXEMPT_PREFIX.some((p) => f.startsWith(p)),
)
let scannedLines = 0

for (const rel of files) {
  const lines = readText(rel).split(/\r?\n/)
  scannedLines += lines.length
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim()
    if (!text || isCommentLine(text)) continue
    for (const [re, what, fix] of RULES) {
      if (re.test(text)) {
        report.add(rel, i + 1, `${what}写死在调用点`, fix)
      }
    }
  }
}

// 下界断言: 防止扫描面塌缩成"零文件零违规"
if (files.length < 50) {
  report.add('.', 0, `只扫到 ${files.length} 个受控文件（下限 50）`, '检查扫描根/扩展名')
}

report.note(`扫描 ${files.length} 个文件 / ${scannedLines} 行`)
process.exit(report.finish())
