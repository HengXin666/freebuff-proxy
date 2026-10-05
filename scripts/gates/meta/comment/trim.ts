/**
 * 注释精简器: 把"为什么/决策/历史/教训"类内容从注释里剥离, 只留"做什么".
 *
 * 用法: node scripts/gates/meta/trim-comments.ts [--dry-run] [<file> ...]
 *
 * 处置规则(按块注释为单位):
 *   - 一个注释块里, 保留首行(描述职责)+ 仍然描述"做什么"的行(JSDoc 标签、
 *     参数/返回值说明、行为列举);
 *   - 丢弃: 含"为什么/因为/原因/决策/历史/教训/曾经/此前/旧实现/踩过/事故/
 *     实测/否决/权衡/代价/而不是/以免/否则"的句子及其续行;
 *   - 块里若只剩 JSDoc 标签, 保留标签; 若整块只讲原因, 整块删除.
 *
 * 输出:
 *   - 每个文件改写后立刻再平衡(避免留下连续空行);
 *   - 汇总"删了多少块/多少行".
 *
 * 退出码: 0 = 成功(含无改动) / 2 = 用法错.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const DRY = process.argv.includes('--dry-run')
const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'))

/** 命中即视为"解释性内容"的词. */
const WHY = /为什么|因为|原因|决策|历史|教训|曾经|此前|旧实现|踩过|事故|实测|否决|权衡|代价|而不是|以免|否则|以前|当初|源于|动机/

/**
 * 判断一行注释是否必须丢弃.
 * @param {string} line 注释原文行
 * @returns {boolean} 是否丢弃
 */
function dropLine(line) {
  return WHY.test(line)
}

/**
 * 精简一个注释块.
 * @param {string} block 含定界符的块注释
 * @returns {string} 精简后的块(可能为空串表示整块删除)
 */
function trimBlock(block) {
  const lines = block.split('\n')
  const kept = []
  for (const l of lines) {
    if (!dropLine(l)) kept.push(l)
  }
  // 全是定界符/空行时整块删除
  const body = kept
    .map((l) => l.replace(/^\s*\/?\*+\/?/, '').trim())
    .filter(Boolean)
  if (!body.length) return ''
  // 收掉"只剩定界符"的碎块
  if (body.length === 1 && !/^@/.test(body[0])) return kept.join('\n')
  return kept.join('\n')
}

let blocksTrimmed = 0
let linesRemoved = 0
let filesChanged = 0

for (const rel of targets) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) continue
  const src = fs.readFileSync(full, 'utf8')
  let out = ''
  let i = 0
  let changed = false
  while (i < src.length) {
    const start = src.indexOf('/**', i)
    if (start < 0) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, start)
    const end = src.indexOf('*/', start + 3)
    if (end < 0) {
      out += src.slice(start)
      break
    }
    const block = src.slice(start, end + 2)
    const trimmed = trimBlock(block)
    if (trimmed !== block) {
      changed = true
      blocksTrimmed++
      linesRemoved += block.split('\n').length - (trimmed ? trimmed.split('\n').length : 0)
    }
    out += trimmed || ''
    i = end + 2
  }
  if (changed) {
    // 收敛连续空行: 删除产生"三个以上连续换行"
    out = out.replace(/\n{3,}/g, '\n\n')
    if (!DRY) fs.writeFileSync(full, out)
    filesChanged++
  }
}

console.log(`${DRY ? '[dry-run] ' : ''}块 ${blocksTrimmed} 个 / 行 ${linesRemoved} / 文件 ${filesChanged}`)
