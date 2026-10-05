/**
 * 给"从 .js 改名而来的 .ts"的参数补内联类型标注(只处理 TS7006).
 *
 * ## 为什么只做这一件事
 *
 * 前车之鉴:本仓曾写过一个同时补"类字段声明"的版本,它把 JSDoc 里
 * @type {Array<{...}>} 的结尾 }> 当成类型结尾截断,产出的字段声明
 * 语法不合法(models: Array<{ ... note?: string),反而把 273 条错误变成
 * 更多.补参数类型不会碰任何声明结构,因此风险低一个量级.
 *
 * 类型来源只取已知映射表(res/req 是 HTTP 对象,route/method 是
 * 字符串等).映射表里没有的一律不猜 ---- 猜错会引入新的类型错误,比 any
 * 更难查.剩下的一律用 any 显式标注(显式 any 是诚实的:它表示"接受
 * 这里没有类型信息",而不是"假装类型是对的").
 *
 * ## 做法
 *
 * 用 TypeScript 编译器 API 定位参数节点(不是正则),只在这些节点的
 * 名字后插入 : Type.
 *
 * 用法:node scripts/gates/meta/fix-ts-params.ts <file.ts> [...]
 *       node scripts/gates/meta/fix-ts-params.ts --dry-run <file.ts> [...]
 * 退出码:0 = 已处理;2 = 用法错.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { ROOT } from '../rules.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const dry = process.argv.includes('--dry-run')
const files = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (files.length === 0) {
  console.error('usage: node scripts/gates/meta/fix-ts-params.ts [--dry-run] <file.ts> [...]')
  process.exit(2)
}

/**
 * 已知的参数类型映射.只放有明确对应物的,其余走 any.
 * @type {Record<string, string>}
 */
const KNOWN = {
  res: 'import("node:http").ServerResponse',
  req: 'import("node:http").IncomingMessage',
  route: 'string',
  method: 'string',
  url: 'URL',
}

/**
 * 取全仓 TS7006 报错的位置(文件 + 行 + 列 + 参数名).
 * @returns {Map<string, Array<{line: number, col: number, name: string}>>} 文件 → 参数位置
 */
function collect() {
  const tsc = path.join(ROOT, 'node_modules/typescript/bin/tsc')
  const args = ['-p', path.join(ROOT, 'tsconfig.json'), '--noEmit', '--checkJs', '--pretty', 'false']
  let out = ''
  try {
    out = execFileSync(process.execPath, [tsc, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  const map = new Map()
  for (const line of out.split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error TS7006: Parameter '([^']+)' implicitly has an 'any' type/.exec(line)
    if (!m) continue
    const file = m[1].replace(/\\/g, '/').replace(`${ROOT}/`, '')
    if (!map.has(file)) map.set(file, [])
    map.get(file).push({ line: Number(m[2]), col: Number(m[3]), name: m[4] })
  }
  return map
}

const errors = collect()
let touched = 0
let params = 0

for (const rel of files) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) continue
  const list = errors.get(rel)
  if (!list || list.length === 0) continue
  const src = fs.readFileSync(full, 'utf8')
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)

  // 收集要改的参数名节点(按位置去重)
  const targets = new Map()
  const visit = (node) => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && !node.type) {
      const name = node.name.text
      const { line, character } = sf.getLineAndCharacterOfPosition(node.name.getStart(sf))
      const key = `${line + 1}:${character + 1}`
      if (list.some((e) => e.line === line + 1 && Math.abs(e.col - (character + 1)) <= 2)) {
        targets.set(key, { pos: node.name.getEnd(), name })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (targets.size === 0) continue

  let out = src
  for (const { pos, name } of [...targets.values()].sort((a, b) => b.pos - a.pos)) {
    const type = KNOWN[name] ?? 'any'
    out = `${out.slice(0, pos)}: ${type}${out.slice(pos)}`
    params++
  }
  if (out !== src) {
    touched++
    if (!dry) fs.writeFileSync(full, out)
  }
}

console.log(`${dry ? 'dry-run: ' : ''}补参数类型 ${params} 处 / ${touched} 个文件`)
