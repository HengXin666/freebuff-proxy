/**
 * 文本规范自动修复器 ---- 把注释与文档里的中文标点换成 ASCII,并清掉注释里的
 * markdown 标记与表情.
 *
 * ## 三条事故教训(这个脚本是重灾区,改动前必须读)
 *
 * 本脚本的第一版一次性改坏 223 个文件,制造了三类损坏,每一条都写进判据了:
 *
 * 1. markdown 标记被整批剥除.文档里的 文本,加粗,# 标题
 *    被当成"注释里的 markdown"处理掉了 ---- README 的加粗 74 到 0,链接 15 到 1,
 *    而反引号还在,文档变成"只剩一半 markdown"的畸形.现在文档模式不再碰
 *    任何 markdown 标记(用户禁的是"注释里的 markdown",文档本来就是 markdown).
 * 2. JSDoc 定界符被吃./** 说明 *​/ 里的  被当加粗配对吃掉,开头变成
 *    / 说明 /,直接产出 5 个语法不可解析的文件;而 tsc 在语法错处早退,
 *    把整条类型棘轮打成假绿.现在先保护定界符,再做任何替换.
 * 3. 笔记/note 的 ## Problem 标题被吃.行首 # 被当标题标记剥掉,
 *    .agents/notes/** 79 篇的 section 标题全丢,note 格式门禁硬红.
 *    现在行首 # 只在"代码注释里"才处理,且只针对注释文本.
 *
 * 还有一条通用纪律:中文标点半角化本身是用户要求的目标状态(硬标准第三条),
 * 所以它不算"污染".真正的污染只有"结构被破坏"这一类.
 *
 * ## 用法
 *
 *
 * node scripts/gates/meta/fix-style.mjs --dry-run              # 只看会改哪些文件
 * node scripts/gates/meta/fix-style.mjs                        # 只改代码注释
 * node scripts/gates/meta/fix-style.mjs --docs                 # 只改文档正文(不碰 markdown 标记)
 * node scripts/gates/meta/fix-style.mjs --punct-only path...   # 只做标点,不碰任何标记
 *
 *
 * 退出码:0 = 无需改动或已改完;1 = dry-run 且有改动;2 = 用法错.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../rules.mjs'
import { mapComments } from '../lib/text/comments.mjs'

/**
 * 全角标点到 ASCII 的映射表.
 *
 * 刻意不映射破折号 --:中文里的 ---- 是成对的,替换成 -- 会与代码里的
 * 自减,命令行参数混淆;它由门禁棘轮管着,需要时人工处理.
 */
const MAP = {
  '\uFF0C': ',',
  '\u3002': '.',
  '\u3001': ',',
  '\uFF1B': ';',
  '\uFF1A': ':',
  '\uFF1F': '?',
  '\uFF01': '!',
  '\u201C': '"',
  '\u201D': '"',
  '\u2018': "'",
  '\u2019': "'",
  '\uFF08': '(',
  '\uFF09': ')',
  '\u3010': '[',
  '\u3011': ']',
  '\u300A': '<',
  '\u300B': '>',
  '\u3008': '<',
  '\u3009': '>',
  '\u300C': '[',
  '\u300D': ']',
  '\u300E': '[',
  '\u300F': ']',
  '\u3014': '[',
  '\u3015': ']',
  '\uFF5E': '~',
  '\u00B7': '.',
  '\uFF06': '&',
  '\uFF03': '#',
  '\uFF20': '@',
  '\uFF05': '%',
  '\uFF0B': '+',
  '\uFF0D': '-',
  '\uFF1D': '=',
  '\uFF1C': '<',
  '\uFF1E': '>',
  '\uFF0F': '/',
  '\uFF3C': '\\',
  '\uFF5C': '|',
  '\uFF0A': '*',
  '\u2026': '...',
}

const EMOJI = /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u2B00-\u2BFF]|\u{FE0F}/gu

/**
 * 只做标点替换,绝不碰任何结构标记.这是所有模式的公共底层.
 * @param {string} text 原文
 * @returns {string} 替换后的文本
 */
function punctOnly(text) {
  let out = text
  for (const [from, to] of Object.entries(MAP)) out = out.split(from).join(to)
  // 破折号与书名号不在主表里(见 MAP 上方的说明),但注释里必须清掉:
  // 不清的话 style 门禁报违规,而修复器说"已改完",两者矛盾.
  // 放在注释模式专用路径里,避免波及代码里的 -- 与模板串.
  out = out.split('\u2014').join('--')
  out = out.replace(/[\u300C]/g, '"').replace(/[\u300D]/g, '"')
  return out.replace(EMOJI, '').replace(/[\uFF3E\u25BD\u03C9\u2267\u2266\u256F\u2570]/g, '')
}

/**
 * 注释文本的规范化:标点替换 + 去掉 markdown 标记(但保护 JSDoc 定界符).
 * @param {string} text 注释原文
 * @returns {string} 规范化后的注释原文
 */
function normalizeComment(text) {
  // 1) 保护 JSDoc 定界符,让后面的星号处理碰不到它们
  const OPEN = '\u0001'
  const CLOSE = '\u0002'
  let out = text.replace(/\/\*\*/g, OPEN).replace(/\*\//g, CLOSE)
  out = punctOnly(out)
  // 2) 成对且同行闭合才去标记(跨行加粗会留下孤立星号,宁可留给门禁报)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  out = out.replace(/~~([^~\n]+)~~/g, '$1')
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1')
  out = out.replace(/`([^`\n]*)`/g, '$1')
  // 3) 还原定界符
  return out.split(OPEN).join('/**').split(CLOSE).join('*/')
}

const dry = process.argv.includes('--dry-run')
const docsMode = process.argv.includes('--docs')
const punctOnlyMode = process.argv.includes('--punct-only')
const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'))
for (const a of process.argv.slice(2)) {
  if (a.startsWith('-') && !['--dry-run', '--docs', '--punct-only'].includes(a)) {
    console.error(`usage: 未知参数 ${a}（合法: --dry-run / --docs / --punct-only）`)
    process.exit(2)
  }
}

const CODE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx']
const DOC_EXT = ['.md', '.html', '.txt']
const EXEMPT = ['.agents/skills/', 'dashboard/version.json', 'docs/reverse/captures/', 'package-lock.json']

/**
 * 只有在用户显式把路径写在命令行上时才动的文件.
 *
 * 为什么:AGENTS.md 自己是"未经允许不得编辑"的受保护文件.自动修复器
 * 按 git ls-files 全量扫时会把它一并改写 ---- 那正是把项目最高优先级约定
 * 交给一个批处理脚本去改.要改就必须有人在命令行上点名.
 */
const PROTECTED = ['AGENTS.md', 'CLAUDE.md', '.agents/notes/AGENTS.md', '.agents/notes/implemented/AGENTS.md', '.agents/notes/archived/AGENTS.md']

/**
 * 目标文件列表.
 * @returns {string[]} 仓库相对路径
 */
function targets() {
  // 命令行点名 = 显式授权;否则走全量扫描并跳过受保护文件.
  const explicit = argv.length > 0
  const base = explicit
    ? argv
    : execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter((f) => !PROTECTED.includes(f))
  const ext = docsMode || punctOnlyMode ? [...DOC_EXT, ...CODE_EXT] : CODE_EXT
  return base.filter((f) => !EXEMPT.some((p) => f.startsWith(p))).filter((f) => ext.some((e) => f.endsWith(e)))
}

let files = 0
let segments = 0
for (const rel of targets()) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) continue

  if (CODE_EXT.some((e) => rel.endsWith(e))) {
    // 代码:只动注释,且绝不碰 JSDoc 定界符.
    const { changed } = mapComments(rel, (text) => (punctOnlyMode ? punctOnly(text) : normalizeComment(text)))
    if (changed > 0) {
      files++
      segments += changed
    }
    continue
  }

  // 文档:剥掉代码块,行内代码与 URL 之后替换标点,再把剥掉的部分原样贴回.
  // 文档里的 markdown 语法必须保留(用户禁的是"注释里的 markdown").
  const src = fs.readFileSync(full, 'utf8')
  const holes = []
  const masked = src
    .replace(/```[\s\S]*?```/g, (m) => `\u0000${holes.push(m) - 1}\u0000`)
    .replace(/`[^`\n]*`/g, (m) => `\u0000${holes.push(m) - 1}\u0000`)
    .replace(/https?:\/\/\S+/g, (m) => `\u0000${holes.push(m) - 1}\u0000`)
  const fixed = punctOnly(masked).replace(/\u0000(\d+)\u0000/g, (_, i) => holes[Number(i)])
  if (fixed !== src) {
    files++
    segments++
    if (!dry) fs.writeFileSync(full, fixed)
  }
}

const mode = punctOnlyMode ? 'punct-only ' : docsMode ? 'doc ' : 'code '
console.log(`${dry ? 'dry-run: ' : ''}${mode}${files} 个文件 / ${segments} 处改动`)
process.exit(dry && files > 0 ? 1 : 0)
