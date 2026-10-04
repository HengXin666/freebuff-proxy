/**
 * check-md-in-comment —— 注释里禁止 markdown 语法（用户指定硬标准）。
 *
 * ## 三类判据
 *
 * 1. markdown 标记：反引号、成对加粗、成对删除线、文本。
 *    这条是用户第二轮明确要求的：「所有注释里禁止出现 markdown 语法」。
 * 2. JSDoc 定界符完整：每段块注释必须以 /** 或 /* 开头、以 *​/ 结尾。
 *    单列一条是因为它出过一次真实事故：一个"去 markdown 标记"的自动修复器把
 *    JSDoc 的 /** 说明 *​/ 里的  当成成对加粗吃掉，开头变成 / 说明 /
 *    —— 直接产出 5 个语法不可解析的文件，而 tsc 会在语法错处早退，
 *    把整条类型棘轮打成假绿（"语法坏了"伪装成"类型债减少了"）。
 *    门禁必须能独立发现"定界符被谁吃了"，否则同一形状会以别的理由复发。
 * 3. 加粗标记必须成对： 在同一段注释内出现次数为偶数。
 *    跨行加粗（开头 ... 结尾）在注释里是常见的——旧修复器只逐行匹配，
 *    结果只吃掉一边，留下孤立的 。这条专门拦那种半残状态。
 *
 * ## 与 check-style 的分工
 *
 * check-style 管标点与表情（中文全角标点棘轮 + 表情零容忍），
 * 本门禁管注释里的 markdown。两者都读同一份注释提取器
 * （lib/comments.mjs），保证"门禁看到的注释"与"修复器改的注释"完全一致。
 *
 * 扫描根：CHECK_ROOT。退出码：0 PASS / 1 FAIL / 2 用法错。
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.mjs'
import { trackedFiles } from '../../lib/scan/files.mjs'
import { Report } from '../../lib/text/report.mjs'
import { commentListOf } from '../../lib/text/comments.mjs'

const report = new Report('md-in-comment')

/** 参与扫描的注释型文件。 */
const EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx']

/**
 * 豁免：.agents/skills/** 是第三方 skill 的源码，不是本仓产品代码。
 * 对它套用本仓的注释规范等于要求上游作者改代码；且它已被
 * .gates/lanes.mjs 的 notes-lane 认领（不是脱离门禁）。
 */
// 豁免：第三方 skill（.agents/skills）、以及**判据文件自身**（它们必须写下被禁的
// 模式字符串作为匹配定义，否则无法检测；不豁免就会自报，而门禁判自己违规只有两种
// 结局：把判据写得看不懂，或者把门禁关掉）。
const EXEMPT = [
  '.agents/skills/',
  'scripts/gates/checks/style/',
  'scripts/gates/meta/fix-style.mjs',
  // 归档的决策记录是冻结的（封存后永不编辑）—— 与格式化规范冲突时以冻结为准。
  '.agents/notes/archived/',
]

/** 注释里必须没有的 markdown 标记。 */
const MARKERS = [
  ['反引号', /`/],
  ['成对加粗', /\*\*[^*\n]+\*\*/],
  ['成对删除线', /~~[^~\n]+~~/],
  ['链接语法', /\[[^\]\n]+\]\([^)\n]+\)/],
]

/** 扫描根下的受控文件。 */
function files(root = ROOT) {
  if (root === ROOT) {
    return trackedFiles()
      .filter((f) => EXT.some((e) => f.endsWith(e)))
      .filter((f) => !EXEMPT.some((p) => f.startsWith(p)))
      .filter((f) => fs.existsSync(path.join(root, f)))
  }
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (EXT.some((x) => e.name.endsWith(x))) out.push(path.relative(root, p).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out
}

const list = files(ROOT)
let checked = 0

for (const rel of list) {
  let comments
  try {
    comments = commentListOf(rel)
  } catch {
    continue
  }
  for (const c of comments) {
    checked++
    const head = c.text.slice(0, 3)
    const tail = c.text.slice(-2)
    // 判据 2：定界符完整
    if (c.text.startsWith('/*')) {
      if (!(head === '/**' || head === '/*\n' || head === '/* ')) {
        report.add(rel, 0, `块注释开头异常: ${JSON.stringify(head)}`, 'JSDoc 必须是 /** 开头；修复器吃掉 ** 时就会变成 / 开头')
      }
      if (!c.text.endsWith('*/')) {
        report.add(rel, 0, `块注释结尾异常: ${JSON.stringify(tail)}`, '块注释必须以 */ 结尾')
      }
    }
    // 判据 3：星号组必须成对。
    //
    // 必须先把"路径写法里的 **"剔掉再数，否则会误报：本仓注释大量出现
    // .agents/skills/**  src/web/**  dashboard/**（表示"该目录下全部"），
    // 那是路径不是加粗标记。误报比漏报更能杀掉一条门禁 —— 实测这四处把
    // 5 个正确的注释判成了违规。
    const body = c.text
      .replace(/^\/\*+/, '')
      .replace(/\*+\/$/, '')
      .replace(/[\w./-]+\/\*\*/g, '<dir>')
    const stars = (body.match(/\*\*/g) ?? []).length
    if (stars % 2 === 1) {
      report.add(rel, 0, `注释里的 ** 未成对（${stars} 个）`, '去掉加粗标记；跨行加粗在注释里不要用')
    }
    // 判据 1：markdown 标记
    for (const [name, re] of MARKERS) {
      const n = (body.match(new RegExp(re.source, 'gm')) ?? []).length
      if (n > 0) {
        report.add(rel, 0, `注释里有 markdown ${name}（${n} 处）`, '改成纯文本；路径与符号名直接写')
      }
    }
  }
}

// 下界断言（WS-E 的纪律）：只判"违规数 == 0"的门禁，在输入被整批破坏时会静默通过。
// 注释段数合法地变成 0 的情形只有一个 -- 扫描面被写坏（根路径错/扩展名错/git 不可用）。
const MIN_FILES = 20
const MIN_COMMENTS = 100
if (list.length < MIN_FILES) {
  report.add('.', 0, `只扫到 ${list.length} 个文件（下限 ${MIN_FILES}）-- 扫描面可能被写坏`, '检查 CHECK_ROOT / 扩展名 / trackedFiles 是否可用')
}
if (checked < MIN_COMMENTS) {
  report.add('.', 0, `只解析出 ${checked} 段注释（下限 ${MIN_COMMENTS}）-- 注释提取可能失效`, '检查解析器与文件后缀；注意 .ts 用 ScriptKind.TS')
}

report.note(`扫描 ${list.length} 个文件 / ${checked} 段注释（下限 ${MIN_FILES} 文件 / ${MIN_COMMENTS} 段）`)
process.exit(report.finish())
