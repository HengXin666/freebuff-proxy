/**
 * 路由来源解析 -- 本仓注册了哪些 HTTP 路由,供文档端点对账用.
 *
 * 为什么单独一个文件:这段逻辑与"判据"是两件事,且它踩过两个独立的坑(见下),
 * 值得有自己的注释与测试面.主脚本 check-docs.mjs 只负责判据与输出.
 *
 * 坑 1(取文件方式):不能用 git ls-files 单独取源码.路由注册文件可能是
 *   刚写好,还没 git add 的新文件 -- 2026-10-05 实测:src/web/routes/
 *   是拆分中新建的未跟踪文件,git ls-files 看不到,导致 5 个文档端点被误判
 *   "代码里没有注册",真凶是取文件方式而非代码.这里用 文件系统遍历 ∪ 已跟踪 的并集,
 *   让 CI(全部已跟踪)与本地开发(部分未跟踪)都正确.
 *
 * 坑 2(真源位置会移动):不能写死读某个文件.同一次拆分把 src/web/api.ts
 *   从 1847 行单体变成 13 行 re-export 门面,实现移入 src/web/routes/;
 *   写死读 api.js 的版本会让 24 条 /api/* 路由全部判成不存在.扫 src/ 全域后,
 *   拆分不再需要动门禁 -- 这正是拆分方想要的.
 *
 * 覆盖两种注册写法:字面量比较(route === '/api/me')与模式匹配(route.match(/^\/api\/x\/([^/]+)$/)).
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../../rules.ts'
import { trackedFiles } from '../../../lib/scan/files.ts'

/**
 * 参与路由抽取的后缀 -- 必须同时收 .js 与 .ts.
 *
 * 实测踩到:路由实现从 src/web/api.ts 迁到 src/web/routes/.ts 之后,
 * 这个函数只收 .js,于是控制台端点从 24 条掉到 0 条,判据把 5 个真实存在
 * 的端点全判成[代码里没有注册].门禁的取文件口径必须跟着迁移走,
 * 否则它会从[保护]变成[误报源].
 */
const ROUTE_EXT = ['.ts']

/**
 * src/ 下的候选源文件集合 -- 文件系统遍历 ∪ 已跟踪(理由见文件头坑 1).
 *
 * @returns {string[]} 仓库相对路径(正斜杠)
 */
export function srcFiles() {
  const has = (f) => ROUTE_EXT.some((e) => f.endsWith(e))
  const out = new Set(trackedFiles(ROOT).filter((f) => f.startsWith('src/') && has(f)))
  /** 递归收集(跳过 node_modules;不跟随 symlink). */
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (has(e.name)) out.add(rel)
    }
  }
  walk('src')
  return [...out].filter((f) => fs.existsSync(path.join(ROOT, f)))
}

/**
 * 把路由正则源转回可读路径模板:^\/api\/accounts\/([^/]+)\/probe$ → /api/accounts/:p/probe.
 *
 * @param {string} escaped 正则源(已去掉首尾斜杠)
 * @returns {string} 路径模板
 */
export function patternToPath(escaped) {
  return escaped
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .split('\\/')
    .join('/')
    .replace(/\(\[\^\/\]\+\)/g, ':p')
    .replace(/\(\[\^\/\]\*\)/g, ':p')
    .replace(/\\(.)/g, '$1')
}

/**
 * 从 src/ 全域抽取注册的路由(理由见文件头坑 2).
 *
 * @returns {Set<string>} 路由路径(模式里的变量段归一化为 :p)
 */
export function registeredRoutes() {
  const out = new Set()
  for (const f of srcFiles()) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    for (const m of src.matchAll(/route === '(\/[^']*)'/g)) out.add(m[1])
    for (const m of src.matchAll(/route\.match\(\/([^/]+)\//g)) out.add(patternToPath(m[1]))
  }
  return out
}

/**
 * 模板与具体路径同形?段数相同,且每段要么相等要么是 :p 占位.
 *
 * @param {string} template 模板路径
 * @param {string} concrete 具体路径
 * @returns {boolean} 是否同形
 */
export function sameShape(template, concrete) {
  const a = template.split('/')
  const b = concrete.split('/')
  if (a.length !== b.length) return false
  return a.every((seg, i) => seg === ':p' || seg === b[i])
}

/**
 * 已注册集合里是否存在该路径(精确,或与某个模板同形).
 *
 * @param {Set<string>} known 已注册路由集合
 * @param {string} p 待查路径
 * @returns {boolean} 是否存在
 */
export function hasRoute(known, p) {
  if (known.has(p)) return true
  for (const k of known) if (k.includes(':p') && sameShape(k, p)) return true
  return false
}
