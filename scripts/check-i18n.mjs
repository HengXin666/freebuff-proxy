#!/usr/bin/env node
/**
 * 多语言红线（CI 强制）。
 *
 * 为什么需要它：控制台文案一旦有人图快直接写中文字面量，多语言就会
 * **静默退化** —— 中文用户看不出问题，英文用户看到一块中文，而且没人
 * 会在 review 里发现。所以这里用机器把三条线钉死：
 *
 *   1. dashboard/app.js 里不得出现硬编码 CJK 字面量（必须走 t('key')）。
 *      —— 例外：注释、console.* 调试输出、以及白名单里的纯数据字符串。
 *   2. 各语种词条 key 必须与基准语种（zh-CN）完全一致：不许缺、也不许多。
 *   3. 代码里 t('xxx') 用到的 key 必须在字典里存在。
 *
 * 退出码：0 = 通过；1 = 有违规（CI 会 fail）。
 * 用法：node scripts/check-i18n.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'dashboard', 'app.js')
const I18N = path.join(ROOT, 'dashboard', 'i18n.js')

/** CJK 统一表意文字 + 常用中文标点。 */
const CJK = /[㐀-䶿一-鿿豈-﫿＀-￯]/

const errors = []
const fail = (msg) => errors.push(msg)

// ---------------------------------------------------------------- 1. 字面量
const appSrc = fs.readFileSync(APP, 'utf8')
const lines = appSrc.split('\n')

/** 允许硬编码中文的行：注释（含块注释中间行）、调试输出。 */
function lineExempt(line, inBlock) {
  const trimmed = line.trim()
  if (inBlock) return true // 块注释内部一律豁免
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return true
  if (/console\.(log|warn|error|debug|info)\b/.test(line)) return true
  return false
}

// 扫描并跟踪块注释状态：块注释里的中文是给人看的说明，不是界面文案
let inBlock = false
lines.forEach((line, i) => {
  const wasInBlock = inBlock
  // 更新块注释状态（先于豁免判断，保证 /* 起始行也被覆盖）
  const openIdx = line.indexOf('/*')
  const closeIdx = line.indexOf('*/')
  if (openIdx !== -1 && (closeIdx === -1 || closeIdx < openIdx)) inBlock = true
  else if (closeIdx !== -1 && wasInBlock) inBlock = false

  if (!CJK.test(line)) return
  if (lineExempt(line, wasInBlock)) return
  // 去掉该行里的注释部分再判断，避免"代码是 t('x') 但行尾有中文注释"误报
  const codeOnly = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
  if (!CJK.test(codeOnly)) return
  fail(
    `${path.relative(ROOT, APP)}:${i + 1} 含硬编码中文，必须改用 t('key') 并写入 dashboard/i18n.js\n` +
      `    ${line.trim().slice(0, 120)}`,
  )
})

// ---------------------------------------------------------- 2/3. 词条一致性
const mod = await import(I18N)
const dictKeys = mod.dictKeys()
const locales = mod.LOCALES
const baseLocale = mod.DEFAULT_LOCALE

const baseKeys = new Set(mod.localeKeys(baseLocale))
for (const loc of locales) {
  if (loc === baseLocale) continue
  const keys = new Set(mod.localeKeys(loc))
  const missing = [...baseKeys].filter((k) => !keys.has(k))
  const extra = [...keys].filter((k) => !baseKeys.has(k))
  if (missing.length) {
    fail(`[${loc}] 缺少 ${missing.length} 个词条（基准 ${baseLocale}）：${missing.slice(0, 12).join(', ')}`)
  }
  if (extra.length) {
    fail(`[${loc}] 多出 ${extra.length} 个基准没有的词条：${extra.slice(0, 12).join(', ')}`)
  }
}

// 重复 key：JS 对象里后者**静默覆盖**前者，是一条看不见的数据丢失。
// 并行编辑极易引入，所以单独扫源文本（不靠运行时对象，否则查不出来）。
{
  const seen = new Map()
  const i18nSrc = fs.readFileSync(I18N, 'utf8')
  const re = /^ {2}'([a-zA-Z0-9_.]+)':/gm
  let mm
  while ((mm = re.exec(i18nSrc))) {
    const k = mm[1]
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
  if (dupes.length) {
    fail(`dashboard/i18n.js 有重复 key（后者静默覆盖前者）：${dupes.join(', ')}`)
  }
}

// 代码里实际用到的 key（覆盖 i18n.js 自身定义以外的所有文件）
const usedKeys = new Set()
const scanFiles = [APP, path.join(ROOT, 'dashboard', 'index.html')]
for (const f of scanFiles) {
  if (!fs.existsSync(f)) continue
  const src = fs.readFileSync(f, 'utf8')
  // 直接调用：t('key')
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) usedKeys.add(m[1])
  // 间接引用：映射表/常量里存 key 名（如 POOL_LABELS 的 premium: 'model.poolPremium'），
  // 由 t(POOL_LABELS[x]) 在运行时取出。不扫就会把这类判成死词条。
  for (const m of src.matchAll(/'((?:common|nav|login|account|quota|model|proxy|toast|dur|overview|user|system|logs|playground)\.[a-zA-Z0-9_.]+)'/g)) {
    usedKeys.add(m[1])
  }
}
const dictSet = new Set(dictKeys)
const unknown = [...usedKeys].filter((k) => !dictSet.has(k))
if (unknown.length) {
  fail(`代码里用了 ${unknown.length} 个字典中不存在的 key：${unknown.slice(0, 12).join(', ')}`)
}

// ------------------------------------------------------------------- 输出
if (errors.length) {
  console.error(`\n[i18n] 多语言红线未通过（${errors.length} 项）：\n`)
  for (const e of errors) console.error('  - ' + e)
  console.error('\n  修复方式：文案写进 dashboard/i18n.js（先加 zh-CN，再补其它语种），')
  console.error('  代码里改用 t(\'key\')；禁止在 dashboard/app.js 直接写中文字面量。\n')
  process.exit(1)
}

// 死词条（字典有、代码没引用）：并行编辑常留下"两人各写一份、其中一份没人用"。
// 只警告不失败 —— 是冗余不是故障，但必须看得见，否则字典会一直膨胀。
const orphans = dictKeys.filter((k) => !usedKeys.has(k))
if (orphans.length) {
  console.warn(
    `[i18n] 提示：${orphans.length} 个词条未被代码引用（死词条，建议清理）：` +
      `${orphans.slice(0, 12).join(', ')}${orphans.length > 12 ? ' …' : ''}`,
  )
}

console.log(
  `[i18n] ok — 字典 ${dictKeys.length} 条 × ${locales.length} 语种（${locales.join(', ')}）；` +
    `代码引用 ${usedKeys.size} 个 key，无硬编码中文。`,
)
