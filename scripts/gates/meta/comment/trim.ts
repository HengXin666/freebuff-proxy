/**
 * 注释精简器: 按段落剥离注释里的解释性内容, 只留"这段代码做什么".
 *
 * 用法: node scripts/gates/meta/comment/trim.ts [--dry-run] <file> ...
 *
 * 处置单位是段落(连续的非空行), 不是单行 ---- 逐行删会留下断句.
 * 同时处理块注释与连续行注释.
 *
 * 退出码: 0 = 成功 / 2 = 用法错.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const DRY = process.argv.includes('--dry-run')
const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'))

/** 解释性内容词元(与 check-comments 一致). */
const WHY_TOKENS = [
  '为什么', '原因', '决策', '历史', '教训', '曾经', '此前', '旧实现',
  '踩过', '事故', '实测', '否决', '权衡', '代价', '动机', '源于', '之所以',
]

/** 注释里出现 note 路径 = 指针, 整块保留. */
const NOTE_POINTER = /\.agents\/notes\//

/**
 * 去掉注释定界符与前导星号.
 * @param {string} line 原始行
 * @returns {string} 正文
 */
function body(line) {
  return line.replace(/^\s*\/?\*+\/?/, '').trim()
}

/**
 * 精简一个块注释.
 * @param {string} block 含定界符的块注释
 * @returns {string} 精简结果(空串 = 整块删除)
 */
function trimBlock(block) {
  if (NOTE_POINTER.test(block)) return block
  const lines = block.split('\n')
  const keep = []
  let para = []
  const flush = () => {
    if (para.length) {
      const head = body(para[0])
      if (!WHY_TOKENS.some((t) => head.includes(t))) keep.push(...para)
    }
    para = []
  }
  for (const line of lines) {
    const b = body(line)
    if (!b || /^\s*\/?\*+\/?\s*$/.test(line)) {
      flush()
      keep.push(line)
      continue
    }
    if (b.startsWith('@')) {
      flush()
      keep.push(line)
      continue
    }
    para.push(line)
  }
  flush()
  if (!keep.map(body).filter(Boolean).length) return ''
  return keep.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * 精简一串连续的行注释.
 * @param {string[]} lines 文件所有行
 * @returns {string[]} 处理后
 */
function trimLineComments(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim().startsWith('//')) {
      out.push(lines[i])
      i++
      continue
    }
    const start = i
    const group = []
    while (i < lines.length && lines[i].trim().startsWith('//')) {
      group.push(lines[i])
      i++
    }
    if (i === start) {
      out.push(lines[i])
      i++
      continue
    }
    if (NOTE_POINTER.test(group.join('\n'))) {
      out.push(...group)
      continue
    }
    const head = group[0].replace(/^\s*\/\//, '').trim()
    if (WHY_TOKENS.some((t) => head.includes(t))) continue
    out.push(...group)
  }
  return out
}

let blocks = 0
let files = 0
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
      blocks++
    }
    out += trimmed || ''
    i = end + 2
  }
  const lines = trimLineComments(out.split('\n'))
  const out2 = lines.join('\n')
  if (out2 !== out) {
    changed = true
    blocks++
  }
  if (changed) {
    if (!DRY) fs.writeFileSync(full, out2.replace(/\n{3,}/g, '\n\n'))
    files++
  }
}
console.log(`${DRY ? '[dry-run] ' : ''}块 ${blocks} / 文件 ${files}`)
