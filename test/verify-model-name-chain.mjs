/**
 * 模型名三层链路的**可证伪**验证。
 *
 * 三层定义（用户裁决，2026-10-04）：
 *   ① 对外：只出现**模型名称**（"DeepSeek V4.1 Flash"），绝不出现 m-xxx
 *   ② 内部：只把**名称映射成目录 id**（m-xxx）后使用
 *   ③ 对上游：只传**映射后**的合法内容（key / fbm1. 句柄）
 *
 * ⚠️ 设计原则（2026-10-04 首版被盲审判假的教训）：
 *
 * 第一版里有 4 条"往返闭合"断言是**重言式** —— 它用同一个表达式构造正向与
 * 反向两张 Map 再互查，恒等于 `f(f⁻¹(x)) === x` 的平凡形式。实测把实现改成
 * 大写破坏 1:1 后，这 4 条**全绿**（而其它断言红了），坐实是假绿。
 *
 * 所以本版**只调用生产代码的真实映射**，不自己搭 Map：
 *   - 名称 → key：`CatalogHolder.keyForName()`（生产用的就是它）
 *   - 对上游寻址：`CatalogHolder.handleForModel()` / `handleFor()`
 *   - 对外名称：`catalogDisplayName()` + `buildCatalogDrivenModelsResponse()`
 *
 * 每条断言都必须**能被实现侧的改动证伪**。取样自真机抓包形态的目录行。
 *
 * 用法：node test/verify-model-name-chain.mjs
 */
import { catalogDisplayName } from '../src/model.js'
import { buildCatalogDrivenModelsResponse } from '../src/catalog-models.js'
import { CatalogHolder } from '../src/upstream/catalog-protocol.js'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

// ── 真机目录形态：key 是不透明 id，displayName 是人读名 ──────────────────
const ROWS = [
  { key: 'm-096e75164d', displayName: 'DeepSeek V4.1 Flash', premium: false, sortOrder: 3 },
  { key: 'm-9a7e098cc1', displayName: 'Solar Pro 4', premium: false, sortOrder: 9 },
  { key: 'm-69307952f8', displayName: 'Solar Mini 4', premium: false, sortOrder: 6 },
  { key: 'm-00032eaeec', displayName: 'MiMo 2.6 Flash', premium: false, sortOrder: 1 },
]

/**
 * 用真实 CatalogHolder 建一个持有本目录的实例（**调生产代码**，不自己搭表）。
 *
 * `_apply(body)` 是目录落地的真实入口（`fetch()` 成功后调它），body 形态
 * 与上游响应一致：`{ fetchId, rows: [{ key, handle, displayName, ... }] }`。
 * 这里直接调它，跳过网络 —— 测的是映射，不是抓取。
 */
function makeHolder(rows) {
  const holder = new CatalogHolder({
    apiHost: 'https://www.codebuff.com',
    token: 'x',
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  const ok = holder._apply({
    fetchId: 'fbf1.test',
    // handle 是服务端签名的句柄（fbm1.<opaque>）；测试用可辨识的假句柄
    rows: rows.map((r) => ({ ...r, handle: `fbm1.TEST_${r.key}` })),
  })
  if (!ok) throw new Error('CatalogHolder._apply 未接受测试目录（对照前提失败）')
  return holder
}

console.log('\n① 对外：只出模型名称，绝不出 m-xxx')
{
  const out = buildCatalogDrivenModelsResponse({ rows: ROWS })
  const ids = out.data.map((m) => m.id)
  const wantNames = ROWS.map((r) => r.displayName).sort()
  check(
    'id 集合 == 目录行的 displayName 集合（1:1）',
    JSON.stringify([...ids].sort()) === JSON.stringify(wantNames),
    JSON.stringify([...ids].sort()),
  )
  check(
    '清单里没有任何 id 长得像 m-xxx',
    !ids.some((id) => /^m-[0-9a-z]+$/i.test(id)),
    JSON.stringify(ids.filter((id) => /^m-/.test(id))),
  )
  check('条数与目录行数一致（不多不少）', out.data.length === ROWS.length)
  const keyByName = new Map(out.data.map((m) => [m.id, m.freebuff_key]))
  check(
    '每条的 freebuff_key 与同名目录行的 key 一一对应',
    ROWS.every((r) => keyByName.get(r.displayName) === r.key),
    JSON.stringify([...keyByName]),
  )
  check(
    'id 与 freebuff_key 是**两个不同字段**（key 不能顶替名称）',
    out.data.every((m) => m.id !== m.freebuff_key),
  )
  // 清单顺序必须遵循 sortOrder（对外可见顺序也是契约的一部分）
  check(
    '清单按 sortOrder 升序',
    JSON.stringify(out.data.map((m) => m.freebuff_key)) ===
      JSON.stringify([...ROWS].sort((a, b) => a.sortOrder - b.sortOrder).map((r) => r.key)),
    JSON.stringify(out.data.map((m) => m.freebuff_key)),
  )
}

console.log('\n② 内部：名称 → 目录 id（走**生产**映射，不是自己搭表）')
{
  check('catalogDisplayName 对每行给出稳定名称', ROWS.every((r) => catalogDisplayName(r) === r.displayName))
  check('displayName 缺失时回退到 key（不凭空编名字）', catalogDisplayName({ key: 'm-abc123' }) === 'm-abc123')
  check('空行返回空串（调用方据此过滤）', catalogDisplayName(null) === '')

  const holder = makeHolder(ROWS)
  check('CatalogHolder 已就绪（对照前提）', holder.ready === true, String(holder.ready))

  /**
   * ⚠️ 这里**必须**走生产映射：`keyForName()` 是 proxy.js 解析 chat 请求时
   * 用的同一个函数。若把实现改成大写/加前缀，下面会红 —— 可证伪。
   */
  for (const r of ROWS) {
    const name = catalogDisplayName(r)
    check(`生产映射：${name} → ${r.key}`, holder.keyForName(name) === r.key, String(holder.keyForName(name)))
  }
  // 反向：key → 句柄（对上游寻址的唯一途径）
  for (const r of ROWS) {
    check(`对上游可寻址：${r.key} → 句柄`, holder.handleForModel(r.key) === `fbm1.TEST_${r.key}`, String(holder.handleForModel(r.key)))
  }
  // 显示名也要能直接换到句柄（客户端照清单填了名称时走这条路）
  for (const r of ROWS) {
    check(`显示名直达句柄：${r.displayName} → 句柄`, holder.handleForModel(r.displayName, r.displayName) === `fbm1.TEST_${r.key}`)
  }
}

console.log('\n③ 对上游：只有映射后的内容可寻址')
{
  const holder = makeHolder(ROWS)
  // 名称 → key → 句柄 的**完整链路**必须闭合（这才是"1:1 对应"的真判据）
  for (const r of ROWS) {
    const viaName = holder.handleForModel(catalogDisplayName(r), r.displayName)
    const viaKey = holder.handleForModel(r.key)
    check(`名称与 key 抵达同一句柄：${r.displayName}`, viaName === viaKey && viaName === `fbm1.TEST_${r.key}`, `${viaName} vs ${viaKey}`)
  }
  check('未映射的名称换不到句柄（不猜）', holder.handleForModel('NoSuchModel-xyz') === 'NoSuchModel-xyz')
}

console.log('\n④ 反例（防止"全放行"的假绿）')
{
  const holder = makeHolder(ROWS)
  check('不存在的名字 keyForName 返回 null', holder.keyForName('NoSuchModel-xyz') === null)
  check('不存在的 key 换不到句柄', holder.handleForModel('m-ffffffffffff') === 'm-ffffffffffff')

  const withPremium = buildCatalogDrivenModelsResponse({
    rows: [...ROWS, { key: 'm-cb71f819fe', displayName: 'MiMo 2.6 Pro', premium: true }],
    blockPremium: true,
  })
  check('blockPremium 生效', !withPremium.data.some((m) => m.id === 'MiMo 2.6 Pro'))
  const hidByName = buildCatalogDrivenModelsResponse({ rows: ROWS, hiddenModels: ['Solar Pro 4'] })
  check('hidden 按名称命中', !hidByName.data.some((m) => m.id === 'Solar Pro 4'))
  const hidByKey = buildCatalogDrivenModelsResponse({ rows: ROWS, hiddenModels: ['m-9a7e098cc1'] })
  check('hidden 按 key 命中', !hidByKey.data.some((m) => m.id === 'Solar Pro 4'))
}

console.log('')
if (failed) {
  console.error(`模型名链路验证失败：${failed} 条`)
  process.exit(1)
}
console.log('模型名三层链路验证通过（对外名称 / 内部映射 / 上游 key）')
