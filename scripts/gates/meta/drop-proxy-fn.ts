/**
 * 从一个文件里按函数名删除一组闭包函数(大括号配对定位).
 *
 * ## 为什么不用行号
 *
 * 实测踩到:按行号区间删 src/proxy.ts 的 5 个限额函数时,区间偏了几行,
 * 结果把相邻的 buildForwardBody 尾部一起删掉(git diff 显示只加 20 行
 * 却删了 340 行).node --check 通过(删完仍是合法 JS),坏在运行时 ----
 * 直到 npm test 报 admit_failed 才暴露.
 *
 * 按名字 + 大括号配对定位则不依赖行号,且能检出"找不到"与"配对失败".
 *
 * 用法:node scripts/gates/meta/drop-proxy-fn.ts <文件> <函数名> [...]
 * 退出码:0 = 已删;2 = 用法错或有函数找不到.
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../rules.ts'

const [rel, ...names] = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (!rel || names.length === 0) {
  console.error('usage: node scripts/gates/meta/drop-proxy-fn.ts <文件> <函数名> [...]')
  process.exit(2)
}

const full = path.join(ROOT, rel)
const L = fs.readFileSync(full, 'utf8').split('\n')
const drop = new Set()

for (const name of names) {
  const re = new RegExp(`^(\\s*)(async )?function ${name}\\(`)
  const i = L.findIndex((l) => re.test(l))
  if (i < 0) {
    console.error(`usage: 找不到函数 ${name}`)
    process.exit(2)
  }
  // 往前收完整 JSDoc
  let d = i
  if (d > 0 && /^\s*\*\/$/.test(L[d - 1])) {
    let q = d - 1
    while (q > 0 && !/^\s*\/\*\*/.test(L[q])) q--
    if (/^\s*\/\*\*/.test(L[q])) d = q
  }
  // 往后用大括号配对(不用"第一个 }",那会截断含对象字面量的函数体)
  let depth = 0
  let seen = false
  let j = i
  for (; j < L.length; j++) {
    for (const ch of L[j]) {
      if (ch === '{') {
        depth++
        seen = true
      } else if (ch === '}') {
        depth--
      }
    }
    if (seen && depth === 0) break
  }
  if (!seen || depth !== 0) {
    console.error(`usage: ${name} 的大括号不配对（depth=${depth}）`)
    process.exit(2)
  }
  const count = j - d + 1
  console.log(`  ${name}: 行 ${d + 1}-${j + 1}（${count} 行）`)
  for (let k = d; k <= j; k++) drop.add(k)
}

const out = L.filter((_, i) => !drop.has(i))
// 合并相邻空行(删块会留下连续空行)
const cleaned = out.filter((l, i) => !(l.trim() === '' && out[i - 1]?.trim() === ''))
fs.writeFileSync(full, cleaned.join('\n'))
console.log(`已删 ${names.length} 个函数；${rel} 现在 ${cleaned.length} 行`)
