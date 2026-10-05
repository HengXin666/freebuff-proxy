/**
 * check-comments ---- 注释只写"做什么"的守门人.
 *
 * 拦什么: 注释块里出现"解释动机/决策/历史"的内容. 这些属于 .agents/notes 与 docs,
 * 不属于代码注释 ---- 代码注释的职责是说明这段代码在做什么.
 *
 * 判据(词元命中, 不做语义分析):
 *   在块注释 / 行注释里出现 为什么 / 因为 / 原因 / 决策 / 历史 / 教训 / 曾经 /
 *   此前 / 旧实现 / 踩过 / 事故 / 实测 / 否决 / 权衡 / 代价 / 而不是 / 以免 / 否则.
 *
 * 为什么不判语义: 语义判据需要模型, 会带来不确定的 CI 结果; 而词元表可以被
 * 逐条列举、逐条解释, 误报率可度量. 词元表本身是判据真源, 只在此处定义.
 *
 * 豁免: 引用了 note 路径的注释(那种注释是"指针", 指向解释所在的地方).
 *
 * 扫描根: CHECK_ROOT.退出码: 0 PASS / 1 FAIL / 2 用法错.
 */
import { readText } from '../../lib/scan/files.ts'
import { codeFiles } from '../../lib/scan/files.ts'
import { Report } from '../../lib/text/report.ts'

const report = new Report('comments')

/** 解释性内容词元(判据真源). */
const WHY_TOKENS = [
  // 解释动机 / 记录历史: 属于 notes 与 docs.
  '为什么', '原因', '决策', '历史', '教训', '曾经', '此前', '旧实现',
  '踩过', '事故', '实测', '否决', '权衡', '代价', '动机', '源于',
  '旧行为', '原来', '之所以',
]

/** 注释里出现 note 路径 = 指针, 不是解释本身. */
const NOTE_POINTER = /\.agents\/notes\//

/** 豁免:门禁自身与注释规范文件. */
const EXEMPT_PREFIX = ['scripts/gates/checks/style/', 'scripts/gates/meta/trim-comments.ts']

/**
 * 该行是否注释.
 * @param {string} text 已 trim 的行
 * @returns {boolean} 是否注释行
 */
function isComment(text: string): boolean {
  return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')
}

const files = codeFiles().filter(
  (f) => f.endsWith('.ts') && !EXEMPT_PREFIX.some((p) => f.startsWith(p)),
)
let scannedComments = 0

for (const rel of files) {
  const lines = readText(rel).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim()
    if (!text || !isComment(text)) continue
    scannedComments++
    if (NOTE_POINTER.test(text)) continue
    for (const tok of WHY_TOKENS) {
      // "说明原因/给出原因" 是功能描述(把原因写清楚), 不是解释动机.
      if (text.includes('说明原因') || text.includes('给出原因')) continue
      if (text.includes(tok)) {
        report.add(
          rel,
          i + 1,
          `注释含解释性内容「${tok}」`,
          '注释只写这段代码做什么; 为什么/决策/历史 写进 .agents/notes/ 或 docs/, 注释里只留一条指向它的路径',
        )
        break
      }
    }
  }
}

if (scannedComments < 500) {
  report.add('.', 0, `只扫到 ${scannedComments} 条注释（下限 500）`, '检查扫描根/扩展名')
}

report.note(`扫描 ${files.length} 个文件 / ${scannedComments} 条注释`)
process.exit(report.finish())
