/**
 - check-format —— 格式红线(不引入任何格式化工具,零依赖).
 *
 - 拦什么(六条,全部是"机器能判,人不用争论"的形态):
 - 1. 缩进含 tab(本仓 1874 个函数无一处用 tab,混入会破坏所有 diff 对齐);
 - 2. 行尾空白;
 - 3. 文件末尾不是恰好一个换行(缺换行会让 cat/diff 粘行);
 - 4. 行宽超过 LIMITS.lineLength(默认走棘轮,见下);
 - 5. UTF-8 BOM;
 - 6. CRLF 行尾.
 *
 - 为什么不装 prettier/eslint:AGENTS.md 铁律规定镜像只带 2 个运行时依赖,
 - 为一个格式约束引入工具链不划算;这六条判据用 40 行脚本就能钉死,且不会有
 - 版本升级导致的整仓重排.
 *
 - 行宽的存量很大(p90 远低于上限但长尾有几百行),因此只有行宽走棘轮:
 - 逐文件登记当前超标数,只许降不许涨.
 *
 - 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { LIMITS, ROOT } from '../../rules.mjs'
import { codeFiles, lineCount, readText } from '../../lib/scan/files.mjs'
import { Report } from '../../lib/text/report.mjs'
import { readBaseline, reconcile, writeBaseline } from '../../lib/text/ratchet.mjs'

const report = new Report('format')
const BASELINE = 'format-long-lines.json'

/** 允许出现超长行的文件类型:CSS 的 data-URI / HTML 的内联 SVG 无法折行. */
const LONG_LINE_EXEMPT = ['.html']

const observed = {}

for (const rel of codeFiles()) {
  const text = readText(rel)
  if (text.charCodeAt(0) === 0xfeff) {
    report.add(rel, 1, '文件以 UTF-8 BOM 开头', '去掉 BOM（编辑器保存为"UTF-8 无 BOM"）')
  }
  if (text.includes('\r\n')) {
    report.add(rel, 1, '文件含 CRLF 行尾', '统一为 LF')
  }
  if (text !== '' && !text.endsWith('\n')) {
    report.add(rel, lineCount(text), '文件末尾缺换行', '在最后一行后补一个换行')
  }
  if (text.endsWith('\n\n')) {
    report.add(rel, lineCount(text), '文件末尾有多余空行', '文件应以单个换行结束')
  }

  let longLines = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (/[ \t]+$/.test(raw) && raw.trim() !== '') {
      report.add(rel, i + 1, '行尾有空白字符', '删掉行尾空白（编辑器可开 trim trailing whitespace）')
    }
    const indent = raw.match(/^[ \t]*/)[0]
    if (indent.includes('\t')) {
      report.add(rel, i + 1, '缩进含 tab', '统一用 2 空格缩进')
    }
    if (raw.length > LIMITS.lineLength && !LONG_LINE_EXEMPT.some((e) => rel.endsWith(e))) {
      longLines++
    }
  }
  if (longLines > 0) observed[rel] = longLines
}

// —— 行宽棘轮 ——
const { entries } = readBaseline(BASELINE)
const { grown, shrunk, fresh } = reconcile(observed, entries)
for (const [file, was, now] of grown) {
  report.add(file, 0, `超长行(${LIMITS.lineLength}+) 从 ${was} 涨到 ${now}`, '拆行，或把长参数列表逐行展开')
}
for (const file of fresh) {
  report.add(file, 0, `超长行(${LIMITS.lineLength}+) 新出现在基线外: ${observed[file]} 行`, '拆行')
}
if (process.argv.includes('--update')) {
  // 必须无条件重录:首次运行时 shrunk 恒为空(基线里什么都没有),
  // 只在"降了"时写就会永远写不出基线文件,而门禁看起来还在正常报错.
  const file = writeBaseline(BASELINE, observed, { note: `行宽 ${LIMITS.lineLength} 的逐文件超标数棘轮：只许降不许涨` })
  report.note(`已重录基线: ${file}（${Object.keys(observed).length} 个文件）`)
} else if (shrunk.length > 0) {
  report.note(`${shrunk.length} 个文件的超长行数已下降，请跑 --update 重录基线（否则基线留着虚高的数）`)
}
report.note(`行宽 ${LIMITS.lineLength}：基线内 ${Object.keys(entries).length} 个文件，本次超标 ${Object.keys(observed).length} 个`)
void ROOT

process.exit(report.finish())
