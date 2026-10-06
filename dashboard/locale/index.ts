/* Freebuff Proxy 控制台 -- 多语言支持(零依赖)
 *
 - 设计约束(项目铁律:轻量优先):
 - - 无构建步骤,无第三方库:字典是普通对象,t() 是普通函数.
 - - 后端零改动:语言是纯前端偏好,存 localStorage,不进 /data,不进 API.
 - - 新增文案必须走 t('key'),禁止直接写中文字面量 ----
 - 由 scripts/check-i18n.ts 在 CI 里强制(见 .github/workflows/docker-image.yml
 - 的 i18n job).红线内容:
 - 1) dashboard/app.ts 里出现硬编码 CJK 字面量 → 失败
 - 2) 各语言词条 key 与 zh-CN 不一致(缺/多) → 失败
 - 3) 代码里用到但字典里没有的 key → 失败
 *
 - 语种:zh-CN(基准)/ en.
 - 词条按域切分与目录收敛见 .agents/notes/implemented/architecture/2026-10-05-dashboard-split-locale-and-css.md.
 - 语言切换机制与 CI 红线见 .agents/notes/implemented/feature/2026-10-02-dashboard-i18n.md.
 - 基准语言是 zh-CN:新增 key 先写进 zh-CN,其它语种缺失会被红线拦下.
 */

export const LOCALES = ['zh-CN', 'en']
export const DEFAULT_LOCALE = 'zh-CN'
const STORAGE_KEY = 'fb_locale'

/**
 - 语种自己的名字(语言切换器里显示).
 *
 - 故意不翻译:切换器必须让每个人都能认出自己的语言
 - (中文用户看 "简体中文",英文用户看 "English"),把 "English" 翻成
 - "英文" 反而害了不懂当前界面语言的用户.这是语言列表的通行做法.
 - 放在 i18n.js 而非 app.js:它是字典元数据,且红线只扫 app.js 的界面文案.
 */
export const LOCALE_LABELS = {
  'zh-CN': '简体中文',
  en: 'English',
}

/** 字典:key → { 'zh-CN': ..., en: ... } */
import core from "./dict/core.ts"
import accounts from "./dict/accounts.ts"
import models from "./dict/models.ts"
import system from "./dict/system.ts"
import views from "./dict/views.ts"

/** 词条总表: 按域合并(见 dashboard/locales/ 各文件的文件头). */
const DICT: Record<string, Record<string, string>> = {
  ...core,
  ...accounts,
  ...models,
  ...system,
  ...views,
}

/** 当前语种(模块级缓存,避免每次读 localStorage). */
let current = DEFAULT_LOCALE

function normalize(locale: any) {
  if (typeof locale !== 'string') return null
  const lower = locale.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en'
  return null
}

/** 初始化语种:localStorage > 浏览器语言 > 默认. */
export function initLocale() {
  let saved = null
  try {
    saved = localStorage.getItem(STORAGE_KEY)
  } catch {
    // 隐私模式下 localStorage 可能不可用
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : null
  current = normalize(saved) || normalize(nav) || DEFAULT_LOCALE
  return current
}

/** 返回当前语种. */
export function getLocale() {
  return current
}

/** 切换语种并持久化;返回新语种. */
export function setLocale(locale: any) {
  const next = normalize(locale) || DEFAULT_LOCALE
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 存不下也要能切（本次会话内有效）
  }
  return next
}

/**
 - 取文案.支持 {name} 占位符替换.
 - 缺 key 时返回 key 本身 ---- 界面上会露出一个可读的 key,
 - 而不是空白(红线脚本会在 CI 里拦下真正缺失的 key).
 - @param {string} key
 - @param {Record<string, string | number>} [vars]
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = DICT[key]
  if (!entry) return key
  let text = entry[current] ?? entry[DEFAULT_LOCALE] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(String(v))
    }
  }
  return text
}

/** 暴露字典给红线脚本(CI 校验各语种 key 一致性). */
export function dictKeys() {
  return Object.keys(DICT)
}

export function localeKeys(locale: any) {
  return Object.keys(DICT).filter((k) => typeof DICT[k]?.[locale] === 'string')
}
