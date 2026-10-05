/**
 * 注释与文档的文本规范(用户指定,第二轮追加的三条硬标准):
 *
 *   1. 禁止文本表情:任何形式的颜文字/emoji/警示符(含  这类 dingbat).
 *   2. 禁止 markdown 语法出现在注释里:反引号,加粗,删除,
 *      文本,# 标题,- 列表,> 引用,表格.
 *      (文档里的 markdown 是允许的 ---- 文档本来就是 markdown;本条只约束
 *      代码注释,因为源码注释里的 markdown 不会被渲染,只会变成噪音.)
 *   3. 标点只用 ASCII:代码注释与文档都禁止中文全角标点
 *      (,.,;:?!""''()[]<>[]--...~. 与全角运算符).
 *
 * ## 为什么这三条值得做成门禁
 *
 * 前两条是"可读性"的机械代理:本仓的注释风格是[讲为什么,讲踩过的坑],
 * 一旦掺进 markdown 标记与颜文字,正文的论证就会被符号噪音切碎;
 * 而且  这类字符在终端/diff/CI 日志里的宽度不一致,会把对齐打乱.
 *
 * 第三条有更实际的原因:全角标点会让找字符串失败.本仓大量使用
 * grep 定位(门禁,探针,以及每次排障),, 与 , 是不同字符,
 * 于是"我明明搜了这句话"变成搜不到.统一成 ASCII 之后,注释与代码的
 * 可搜索性一致.
 *
 * ## 存量策略
 *
 * 实测存量巨大(注释 18093 处 / 文档 19666 处 / markdown 语法 3541 处 /
 * 表情 111 处,共 224 个文件).因此:
 *   - 表情 与 markdown 零容忍(这两类合计 3652 处,一次清干净);
 *   - 标点 用逐文件棘轮(存量按文件登记,只许降不许涨),
 *     因为它是纯替换且量极大,一次性改动会让本次重构的 diff 无法审阅.
 *
 * 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.ts'
import { Report } from '../../lib/text/report.ts'
import { readBaseline, reconcile, writeBaseline } from '../../lib/text/ratchet.ts'
import { commentTextOf } from '../../lib/text/comments.ts'
import { trackedFiles } from '../../lib/scan/files.ts'

const BASELINE = 'style-baseline.json'
const report = new Report('style')

/** 中文全角标点(含全角运算符). */
const CJK_PUNCT = /[\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF1F\uFF01\u201C\u201D\u2018\u2019\uFF08\uFF09\u3010\u3011\u300A\u300B\u3008\u3009\u300C\u300D\u300E\u300F\u3014\u3015\u2014\u2026\uFF5E\u00B7\uFF06\uFF03\uFF20\uFF05\uFF0B\uFF0D\uFF1D\uFF0F\uFF3C\uFF5C\uFF0A\uFF1C\uFF1E]/

/**
 * 文本表情:只保留真正是表情的形态.
 *
 * ## 六条避免误报的约束(每条都是实测踩到的,且都差一点让人改坏生产代码)
 *
 *   1. 233 不许单独匹配 -- 会命中端口号 127.0.0.1:2334(本仓 mock 上游的监听端口).
 *   2. www 完全删掉 -- 会命中 https://www.codebuff.com.本仓记着一条生产事故:
 *      上游 base URL 少一个 www 就全量 401.一个表情门禁若诱导人去改这个 URL,
 *      损失远大于它防住的东西.
 *   3. :p / :P / :D 不许匹配 -- 本仓大量使用 file.md:anchor 与 标签:值 写法
 *      (node:path,释放会话:DELETE),冒号右边恰好是 p / D.要求冒号左边是
 *      行首或空白,而标识符里冒号左边永远是单词字符.
 *   4. 尖括号组合不许匹配 -- 会命中 HTML 标签(/b,p)与正则里的字符类.
 *   5. 脱字符不许匹配 -- 会命中代码里表示层级的 ^^^(示意写法).
 *   6. 判据只作用于注释与文档正文(调用方已剥掉代码块,行内代码与 URL).
 */
const EMOTICON =
  /(?:^|[ \t])[:;]-[)(](?![\w-])|(?<![\w.:/])233(?![\d.:])(?![\u4e00-\u9fff])|\(笑\)|\(哭\)|\(汗\)|（笑）|（哭）|（汗）|[\u2267]|[\u2266]|[\u256F]|[\u2570]/

/** emoji 与 dingbat(含  U+26A0 与变体选择符). */
const EMOJI = /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u2B00-\u2BFF]|\u{FE0F}/u

/** 注释里的 markdown 语法(逐条给名字,便于报错信息可操作). */
const MARKDOWN_IN_COMMENT = [
  ['反引号', /`/],
  ['加粗', /\*\*[^*\n]+\*\*/],
  ['删除线', /~~[^~\n]+~~/],
  ['链接', /\[[^\]\n]+\]\([^)\n]+\)/],
  ['标题', /^[ \t]*#{1,6}[ \t]/m],
  ['引用块', /^[ \t]*>[ \t]/m],
  ['表格', /^[ \t]*\|.*\|[ \t]*$/m],
]

/** 参与注释文本规范的文件. */
const CODE_EXT = ['.ts', '.css']

/** 参与文档标点规范的文件(markdown 语法在文档里是允许的). */
const DOC_EXT = ['.md', '.html', '.txt']

/** 豁免:第三方 skill 与生成产物. */
// 豁免:第三方 skill,生成产物,以及判据文件自身(它们必须写下被禁的模式
// 字符串作为匹配定义;不豁免就会自报,而门禁判自己违规只有两种结局:把判据
// 写得看不懂,或者把门禁关掉).
const EXEMPT = [
  '.agents/skills/',
  'dashboard/version.json',
  'docs/reverse/captures/',
  'scripts/gates/checks/style/',
  'scripts/gates/meta/fix-style.ts',
  // 归档的决策记录是冻结的(hx-agent-notes 明确:封存后永不编辑,翻译,
  // 重排版或移动).格式化规范与"冻结"冲突时必须以冻结为准 ---- 否则要么
  // 归档门禁红,要么为了过格式门禁去改历史记录,两者都比留一处旧标点更贵.
  '.agents/notes/archived/',
]

/**
 * 受控文件列表 ---- 必须复用共用的 trackedFiles(), 不能自己写一行 git ls-files.
 *
 * 实测教训: 本文件曾自己写 git ls-files, 于是"未跟踪文件对门禁隐形"这个盲区
 * 只被修在了用共用函数的那几条门禁上, style 仍然是瞎的(造一个 401 行的未跟踪
 * 文件, sizes 命中而 style 零命中).取文件的口径只允许有一处.
 * @returns {string[]} 相对路径
 */
function files() {
  return trackedFiles().filter((f) => fs.existsSync(path.join(ROOT, f)))
}

/** 文档里剥掉代码块,行内代码与 URL(那些地方出现任意字符都不该判违规). */
function docBody(rel, src) {
  if (rel.endsWith('.html')) {
    // HTML:只查文本节点之外的部分没意义,简单剥掉 <script>/<style> 与标签属性中的 URL
    return src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/https?:\/\/\S+/g, '')
  }
  return src
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/https?:\/\/\S+/g, '')
}

const observed = {}
const list = files().filter((f) => !EXEMPT.some((p) => f.startsWith(p)))

for (const rel of list) {
  const isCode = CODE_EXT.some((e) => rel.endsWith(e))
  const isDoc = DOC_EXT.some((e) => rel.endsWith(e))
  if (!isCode && !isDoc) continue
  let src
  try {
    src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    continue
  }
  const body = isCode ? commentTextOf(rel, src) : docBody(rel, src)
  if (!body) continue

  const punct = (body.match(new RegExp(CJK_PUNCT.source, 'g')) ?? []).length
  if (punct > 0) observed[rel] = punct

  if (isCode) {
    for (const [name, re] of MARKDOWN_IN_COMMENT) {
      const n = (body.match(new RegExp(re.source, 'gm')) ?? []).length
      if (n > 0) report.add(rel, 0, `注释里有 markdown ${name}（${n} 处）`, '去掉标记，用纯文本叙述；路径/符号名直接写，不加反引号')
    }
    const emo = (body.match(EMOJI) ?? []).length
    if (emo > 0) report.add(rel, 0, `注释里有 emoji/dingbat（${emo} 处）`, '删掉；要强调就用文字，例如「注意」「危险」')
    const face = (body.match(new RegExp(EMOTICON.source, 'g')) ?? []).length
    if (face > 0) report.add(rel, 0, `注释里有文本表情（${face} 处）`, '删掉；改写成一句陈述')
  } else {
    const emo = (body.match(EMOJI) ?? []).length
    if (emo > 0) report.add(rel, 0, `文档里有 emoji/dingbat（${emo} 处）`, '删掉')
    const face = (body.match(new RegExp(EMOTICON.source, 'g')) ?? []).length
    if (face > 0) report.add(rel, 0, `文档里有文本表情（${face} 处）`, '删掉')
  }
}

const { entries } = readBaseline(BASELINE)
const { grown, shrunk, fresh } = reconcile(observed, entries)
for (const [file, was, now] of grown) {
  report.add(file, 0, `中文标点从 ${was} 处涨到 ${now} 处`, '改成 ASCII 标点；自动修可用 node scripts/gates/meta/fix-style.ts')
}
for (const file of fresh) {
  report.add(file, 0, `中文标点新出现在基线外（${observed[file]} 处）`, '改成 ASCII 标点')
}
if (process.argv.includes('--update')) {
  writeBaseline(BASELINE, observed, { note: '中文全角标点的逐文件棘轮：只许降不许涨' })
  report.note(`已重录标点基线（${Object.keys(observed).length} 个文件）`)
} else if (shrunk.length > 0) {
  report.note(`${shrunk.length} 个文件的中文标点已减少，请 --update 重录`)
}

report.note(`扫描 ${list.length} 个受控文件；中文标点涉及 ${Object.keys(observed).length} 个（基线 ${Object.keys(entries).length} 个）`)
process.exit(report.finish())
