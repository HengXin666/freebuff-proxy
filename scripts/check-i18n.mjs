#!/usr/bin/env node
/**
 - 多语言红线(CI 强制).
 *
 - 为什么需要它:控制台文案一旦有人图快直接写中文字面量,多语言就会
 - 静默退化 ---- 中文用户看不出问题,英文用户看到一块中文,而且没人
 - 会在 review 里发现.所以这里用机器把三条线钉死:
 *
 - 1. dashboard/ 下所有 .js 里不得出现硬编码 CJK 字面量(必须走 t('key')).
 - ---- 例外:注释,console.* 调试输出,以及 i18n 字典文件自身(那里本来就是中文).
 *
 - 扫描范围从"只有 app.js"扩成整棵 dashboard/ 是必须的(2026-10-05 实测):
 - 前端正在被拆成多个模块,写死单文件路径会让红线在拆分完成后静默失去覆盖面
 - ---- 新模块里的硬编码中文再也没人拦,而 CI 依然是绿的.
 - 2. 各语种词条 key 必须与基准语种(zh-CN)完全一致:不许缺,也不许多.
 - 3. 代码里 t('xxx') 用到的 key 必须在字典里存在.
 *
 - 退出码:0 = 通过;1 = 有违规(CI 会 fail).
 - 用法:node scripts/check-i18n.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DASHBOARD = path.join(ROOT, 'dashboard')
const I18N = path.join(ROOT, 'dashboard', 'locale', 'index.js')
/** 词条目录(字典真源所在). 整个目录都不参与硬编码中文扫描. */
const DICT_DIR = path.dirname(I18N)

/**
 - 需要扫硬编码中文的源文件:dashboard 下所有 .js,排除 i18n 字典目录与字典文件本身
 - (字典的 value 本来就是中文,扫它必然全红).
 - @returns {string[]} 绝对路径列表
 */
function literalScanFiles() {
  const out = []
  /** 递归收集(目录层级由并行重构决定,不能写死深度). */
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        // 词条目录: 字典数据本身是中文, 扫它必然全红.
        // 判据按路径而不是按目录名列表: 字典真源是 dashboard/locale/,
        // 而目录名随拆分变过两次(i18n -> locales -> locale), 每次都要改这段,
        // 漏改就会把整个字典判成"硬编码中文". 用基准目录判断可以终结这种漂移.
        if (path.resolve(dir) === DICT_DIR || path.resolve(dir) === path.dirname(I18N)) {
          continue
        }
        walk(p)
        continue
      }
      if (!e.name.endsWith('.js')) continue
      // 字典真源文件本身(以及它同目录下的词条文件)不参与"硬编码中文"扫描.
      if (path.resolve(path.dirname(p)) === path.dirname(I18N)) continue
      if (p === I18N) continue
      out.push(p)
    }
  }
  walk(DASHBOARD)
  return out
}

/** CJK 统一表意文字 + 常用中文标点. */
const CJK = /[㐀-䶿一-鿿豈-﫿＀-￯]/

const errors = []
const fail = (msg) => errors.push(msg)

// ---------------------------------------------------------------- 1. 字面量
const literalFiles = literalScanFiles()

/** 允许硬编码中文的行:注释(含块注释中间行),调试输出. */
function lineExempt(line, inBlock) {
  const trimmed = line.trim()
  if (inBlock) return true // 块注释内部一律豁免
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return true
  if (/console\.(log|warn|error|debug|info)\b/.test(line)) return true
  return false
}

// 扫描并跟踪块注释状态:块注释里的中文是给人看的说明,不是界面文案
for (const file of literalFiles) {
  const src = fs.readFileSync(file, 'utf8')
  let inBlock = false
  src.split('\n').forEach((line, i) => {
    const wasInBlock = inBlock
    // 更新块注释状态(先于豁免判断,保证 /* 起始行也被覆盖)
    const openIdx = line.indexOf('/*')
    const closeIdx = line.indexOf('*/')
    if (openIdx !== -1 && (closeIdx === -1 || closeIdx < openIdx)) inBlock = true
    else if (closeIdx !== -1 && wasInBlock) inBlock = false

    if (!CJK.test(line)) return
    if (lineExempt(line, wasInBlock)) return
    // 去掉该行里的注释部分再判断,避免"代码是 t('x') 但行尾有中文注释"误报
    const codeOnly = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
    if (!CJK.test(codeOnly)) return
    fail(
      `${path.relative(ROOT, file)}:${i + 1} 含硬编码中文，必须改用 t('key') 并写入 i18n 字典\n` +
        `    ${line.trim().slice(0, 120)}`,
    )
  })
}

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

// 重复 key:JS 对象里后者静默覆盖前者,是一条看不见的数据丢失.
// 并行编辑极易引入,所以单独扫源文本(不靠运行时对象,否则查不出来).
{
  // 字典真源可能是单文件(i18n.js)或按域切出的多个文件(dashboard/locales/*.js).
  // 实测踩到: 只读 I18N 一个文件时, 词条搬进 locales/ 后一条 key 也读不到,
  // 于是"代码用到的 key 必须在字典里存在"这条判据把 453 个 key 全报成缺失 --
  // 判据没变, 是它读的位置过期了. 所以这里按"真源文件集合"读, 不写死单文件.
  const dictFiles = [I18N]
  const localesDir = path.join(ROOT, 'dashboard', 'locale', 'dict')
  if (fs.existsSync(localesDir)) {
    for (const f of fs.readdirSync(localesDir)) {
      if (f.endsWith('.js')) dictFiles.push(path.join(localesDir, f))
    }
  }
  const seen = new Map()
  const re = /^ {2}'([a-zA-Z0-9_.]+)':/gm
  for (const df of dictFiles) {
    const src = fs.readFileSync(df, 'utf8')
    let mm
    while ((mm = re.exec(src))) {
      const k = mm[1]
      seen.set(k, (seen.get(k) || 0) + 1)
    }
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
  if (dupes.length) {
    fail(`i18n 字典有重复 key（后者静默覆盖前者）：${dupes.join(', ')}`)
  }
  if (seen.size === 0) {
    fail(`i18n 字典里读到 0 条 key -- 判据读的位置可能已过期（当前读: ${dictFiles.map((f) => path.relative(ROOT, f)).join(', ')}）`)
  }
}

// 代码里实际用到的 key(覆盖 i18n.js 自身定义以外的所有文件)
const usedKeys = new Set()
const scanFiles = [...literalFiles, path.join(DASHBOARD, 'index.html')]
for (const f of scanFiles) {
  if (!fs.existsSync(f)) continue
  const src = fs.readFileSync(f, 'utf8')
  // 直接调用:t('key')
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) usedKeys.add(m[1])
  // 间接引用:映射表/常量里存 key 名(如 POOL_LABELS 的 premium: 'model.poolPremium'),
  // 由 t(POOL_LABELS[x]) 在运行时取出.不扫就会把这类判成死词条.
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
  console.error('\n  修复方式：文案写进 i18n 字典（先加 zh-CN，再补其它语种），')
  console.error('  代码里改用 t(\'key\')；禁止在 dashboard/ 下的 .js 里直接写中文字面量。\n')
  process.exit(1)
}

// 死词条(字典有,代码没引用):并行编辑常留下"两人各写一份,其中一份没人用".
// 只警告不失败 ---- 是冗余不是故障,但必须看得见,否则字典会一直膨胀.
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
