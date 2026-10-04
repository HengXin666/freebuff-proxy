/**
 * 注释提取 —— 用 TypeScript 的注释扫描拿到"真实注释文本"。
 *
 * 为什么必须这么拿：字符串字面量里的 ， 是数据（例如中文界面文案、
 * mock 夹具、上游回执原文），把注释规范应用到字符串上会直接改坏功能。
 * 正则做不到这个区分（模板串、正则字面量、转义引号都会骗过它），所以这里
 * 用编译器 API 逐个节点取前导/后置注释，天然只覆盖注释。
 *
 * 本模块被两类调用者共用：规范门禁（判违规）与自动修复器（改注释文本），
 * 两者必须看到同一份注释文本，否则会变成"门禁说没改干净、修复器说已改完"。
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.mjs'
import { ts } from '../scan/ast.mjs'

/**
 * 取出一个文件里所有注释的原文（去重，按出现位置）。
 * @param {string} rel 仓库相对路径
 * @param {string} [src] 文件内容（不传则从磁盘读）
 * @param {string} [root] 扫描根
 * @returns {string[]} 注释原文列表
 */
export function commentListOf(rel, src = null, root = ROOT) {
  const text = src ?? fs.readFileSync(path.join(root, rel), 'utf8')
  const kind = rel.endsWith('.ts') || rel.endsWith('.tsx') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  let sf
  try {
    sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, kind)
  } catch {
    return []
  }
  const seen = new Set()
  const out = []
  /** 收集一个区间（去重：同一段注释可能同时是前导与后置）。 */
  const collect = (pos, end) => {
    const key = `${pos}:${end}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ pos, end, text: text.slice(pos, end) })
  }
  const visit = (node) => {
    for (const r of ts.getLeadingCommentRanges(text, node.pos) ?? []) collect(r.pos, r.end)
    for (const r of ts.getTrailingCommentRanges(text, node.end) ?? []) collect(r.pos, r.end)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  // 文件末尾的注释（没有后继节点，前导注释扫描拿不到）
  for (const r of ts.getLeadingCommentRanges(text, text.length) ?? []) collect(r.pos, r.end)
  return out
}

/**
 * 取出一个文件里所有注释拼成的文本（门禁只需判断"有没有"）。
 * @param {string} rel 仓库相对路径
 * @param {string} [src] 文件内容
 * @param {string} [root] 扫描根
 * @returns {string} 注释文本（换行连接）
 */
export function commentTextOf(rel, src = null, root = ROOT) {
  return commentListOf(rel, src, root)
    .map((c) => c.text)
    .join('\n')
}

/**
 * 把文件里的注释逐段替换后写回（只动注释，不动任何字符串）。
 *
 * ## 一处致命细节：注释区间必须合并重叠再替换
 *
 * 编译器 API 的 getLeadingCommentRanges 与 getTrailingCommentRanges 会把
 * 同一段注释报告两次（它既是上一个节点的后置注释，又是下一个节点的前导注释），
 * 区间因此重叠。若按重叠区间逐个 splice：
 *
 *   1. 第一次替换改变了文本长度；
 *   2. 第二次用原始下标去切已经被改过的字符串 → 切在错误的位置，
 *      把代码字符搬进注释里。
 *
 * 实测后果（2026-10-05）：dashboard/views/models/index.js 与
 * overview/accounts.js 被这个 bug 改成语法不可解析，且报错位置与真凶无关
 * （node --check 指向一个看似正常的条件表达式）。
 *
 * 修法：先把区间按 pos 排序并合并所有重叠段，再一次性、从后往前替换。
 *
 * @param {string} rel 仓库相对路径
 * @param {(text: string) => string} map 注释文本变换
 * @param {string} [root] 扫描根
 * @returns {{changed: number}} 被改动的注释段数
 */
export function mapComments(rel, map, root = ROOT) {
  const file = path.join(root, rel)
  const text = fs.readFileSync(file, 'utf8')
  const list = commentListOf(rel, text, root)
  if (list.length === 0) return { changed: 0 }
  const merged = mergeRanges(list)
  // 从后往前替换，避免前面的改动让后面的下标失效
  let out = text
  let changed = 0
  for (let i = merged.length - 1; i >= 0; i--) {
    const c = merged[i]
    const next = map(out.slice(c.pos, c.end))
    if (next === out.slice(c.pos, c.end)) continue
    out = out.slice(0, c.pos) + next + out.slice(c.end)
    changed++
  }
  if (changed > 0) fs.writeFileSync(file, out)
  return { changed }
}

/**
 * 合并重叠/相邻的注释区间（同一段注释会被前导与后置扫描各报一次）。
 * @param {Array<{pos: number, end: number}>} list 注释区间
 * @returns {Array<{pos: number, end: number}>} 合并后的区间（按 pos 升序）
 */
function mergeRanges(list) {
  const sorted = [...list].sort((a, b) => a.pos - b.pos)
  const out = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.pos <= last.end) {
      last.end = Math.max(last.end, r.end)
      continue
    }
    out.push({ pos: r.pos, end: r.end })
  }
  return out
}
