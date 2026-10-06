/**
 * 官方工具注入选择: 分类真值与三态语义.
 *
 * 为什么要单独测: 分类错一个, 控制台就会把一个不可派发的工具列为[可派发],
 * 用户勾上它, 模型选中, 下游报 unknown tool ---- 而故障现场看不出是分类表的锅.
 *
 * 判据(可证伪): 把 official-tool-select.ts 里任一工具的 group 从 orphan 改成
 * common, 第 2 组断言立刻变红(实测过).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ALL_OFFICIAL_TOOL_NAMES,
  DEFAULT_INJECTED_TOOLS,
  OFFICIAL_TOOL_META,
  injectableOfficialTools,
  selectOfficialTools,
} from '../../../../../src/upstream/signals/tools/official-tool-select.ts'
import {
  CLIENT_TO_OFFICIAL_TOOL, OFFICIAL_NATIVE_TO_CLIENT,
} from '../../../../../src/upstream/foreign-client-signals.ts'

let n = 0
const ok = (cond: any, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..', '..')
/** 真实抓包的官方工具集(与双向映射表用同一份判据). */
const REAL: string[] = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/reverse/captures/official-tools.json'), 'utf8'),
).map((t: any) => t.function ? t.function.name : t.name)

// ── 1 分类表必须与抓包真值逐条同序 ───────────────────────────────
{
  ok(REAL.length === ALL_OFFICIAL_TOOL_NAMES.length, '工具数与抓包一致, got ' + ALL_OFFICIAL_TOOL_NAMES.length)
  const miss = REAL.filter((x) => !ALL_OFFICIAL_TOOL_NAMES.includes(x))
  const extra = ALL_OFFICIAL_TOOL_NAMES.filter((x) => !REAL.includes(x))
  ok(miss.length === 0, '抓包里有的本表必须有: ' + miss.join(','))
  ok(extra.length === 0, '本表不能有抓包里没有的: ' + extra.join(','))
  ok(JSON.stringify([...ALL_OFFICIAL_TOOL_NAMES]) === JSON.stringify(REAL), '顺序与抓包一致')
}

/**
 * 参考下游(dsh)真实声明的工具名.
 *
 * 判据必须是[下游真的声明了这个名字], 不能只看映射表里有没有别名:
 * 表里给 list_directory 写了 ls / list_dir, 但没有任何真实下游声明过它们,
 * 所以它仍然是不可派发的(第 2 组曾因判据太弱而变红).
 */
const REF_DOWNSTREAM: string[] = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test/fixtures/dsh-tools.json'), 'utf8'),
).map((t: any) => t.name)

// ── 2 common 的判据是[下游真的声明过], 不是主观印象 ─────────────
{
  const reachableTo = (official: string) =>
    REF_DOWNSTREAM.some((c) => (CLIENT_TO_OFFICIAL_TOOL as Record<string, string>)[c] === official)
  const common = OFFICIAL_TOOL_META.filter((t) => t.group === 'common').map((t) => t.name)
  const orphan = OFFICIAL_TOOL_META.filter((t) => t.group === 'orphan').map((t) => t.name)
  ok(common.length + orphan.length === REAL.length, '两组必须覆盖全集')
  for (const name of common) {
    ok(reachableTo(name), 'common 必须能落到下游真的声明过的名字: ' + name)
  }
  for (const name of orphan) {
    ok(!reachableTo(name), 'orphan 不该落到下游声明过的名字: ' + name)
  }
  ok(DEFAULT_INJECTED_TOOLS.length === common.length, '默认注入集 = common 集')
}

// ── 3 每个工具都得有说明(控制台要显示, 空说明等于没写) ────────────
{
  for (const t of OFFICIAL_TOOL_META) {
    ok(typeof t.desc === 'string' && t.desc.length > 0, '缺说明: ' + t.name)
  }
}

// ── 4 selectOfficialTools 的三态必须分开 ─────────────────────────
{
  // 未配置 = 全注入(旧行为), 与显式[全不选]语义不同.
  const all = selectOfficialTools(null)
  ok(all.mode === 'all', '未配置必须是 all')
  ok(all.names.length === REAL.length, '未配置要注入全部')
  const none = selectOfficialTools([])
  ok(none.mode === 'none', '空数组必须是 none')
  ok(none.names.length === 0, '空数组一个都不注入')
  const sub = selectOfficialTools(['read_files', 'web_search', 'no_such_tool'])
  ok(sub.mode === 'subset', '给了名单是 subset')
  ok(sub.names.length === 2, '名单外的名字要丢掉, got ' + sub.names.length)
  ok(sub.names[0] === 'read_files' && sub.names[1] === 'web_search', '顺序按真源而不是入参')
}

// ── 5 自动规则: 注入集必须随客户端实际声明而变 ────────────────────
// 这是本模块最关键的一条: 静态分类表对不上客户端形态(实测同一台机器两种形态),
// 只声明 run_code 的会话里 37 个官方工具全部派发不了.
// 判据(可证伪): 让 injectableOfficialTools 忽略 declared 参数直接返回全表, 本组变红.
{
  const ptc = injectableOfficialTools(['run_code'])
  ok(ptc.length === 0, '只声明 run_code 时必须注入 0 个, got ' + ptc.length)

  const native = injectableOfficialTools(REF_DOWNSTREAM)
  ok(native.length > 0, '原生客户端形态不该被裁成空集')
  for (const name of native) ok(REAL.includes(name), '注入的必须是官方真源里的名字: ' + name)

  // 注入集与[能落回下游]必须等价 ---- 少一个就是漏裁(仍会 unknown tool),
  // 多一个就是过裁(把可用的工具也砍掉).
  // [能落回下游]有两条来源, 缺一条本判据就会与实现漂移:
  //   1. 大表 CLIENT_TO_OFFICIAL_TOOL(下游名 -> 官方名, 一对一);
  //   2. 补充表 OFFICIAL_NATIVE_TO_CLIENT(官方原生名 -> 下游名, 反向一对多).
  // 只按第 1 条算会在 suggest_prompts 落进 ask_user_question 之后凭空少一个.
  const reachable = REAL.filter((off) =>
    REF_DOWNSTREAM.some((c) => (CLIENT_TO_OFFICIAL_TOOL as Record<string, string>)[c] === off)
    || (OFFICIAL_NATIVE_TO_CLIENT[off] !== undefined
      && REF_DOWNSTREAM.includes(OFFICIAL_NATIVE_TO_CLIENT[off])),
  )
  ok(
    JSON.stringify(native) === JSON.stringify(reachable),
    '注入集必须恰好等于[能落回下游]的那些: ' + native.length + ' vs ' + reachable.length,
  )

  // 空声明 -> 空注入(不能退化成全表).
  ok(injectableOfficialTools([]).length === 0, '空声明集必须注入 0 个')
  ok(injectableOfficialTools(null).length === 0, 'null 声明必须注入 0 个')
}

console.log('官方工具注入选择验证通过(断言 ' + n + ' 条)')
