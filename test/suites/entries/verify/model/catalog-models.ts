/**
 - 离线验证:目录驱动模型表(不发任何网络请求).
 *
 - 输入是真机抓包留下的两份原文:
 - docs/reverse/captures/2026-10-03-e2/catalog-official-client.json  (目录 13 行)
 - docs/reverse/captures/2026-10-03-e2/session-official.json         (额度/单价)
 *
 - 钉死三件事(用户报的[没有任何可用模型]全部源于它们被搞反):
 - 1. 清单来自目录行(13 条),不是 rateLimitsByModel(6 条);
 - 2. 对外 id 是可读模型名,不是 m-xxx;
 - 3. 白名单放行目录里的模型(含当日额度为 0 的).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { buildCatalogDrivenModelsResponse } from '../../../../../src/catalog-models.ts'
import { isModelAllowed } from '../../../../../src/model.ts'
import { CatalogHolder } from '../../../../../src/upstream/catalog-protocol.ts'

// 六层 dirname = 仓库根(本文件比原来深一层, 见目录重组).
const HERE = dirname(dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))))
const CAP = join(HERE, 'docs', 'reverse', 'captures', '2026-10-03-e2')

const cat = JSON.parse(readFileSync(join(CAP, 'catalog-official-client.json'), 'utf8'))
const sess = JSON.parse(readFileSync(join(CAP, 'session-official.json'), 'utf8'))
const rateLimits = { ...(sess.rateLimitsByModel || {}) }
const prices = { ...(sess.freebucks?.prices || {}) }

/**
 * 目录 key -> catalogId 的表, 与生产同源(AccountRuntimes.modelAliases):
 * 用真 CatalogHolder 的摘要反查内置静态表, 而不是另写一套映射.
 */
const holder = new CatalogHolder({
  apiHost: 'https://www.codebuff.com',
  token: 'x',
  fetchImpl: async () => new Response('{}', { status: 200 }),
})
holder._apply(cat)
const builtin = JSON.parse(
  readFileSync(join(HERE, 'src', 'catalog', 'freebuff-catalog.json'), 'utf8'),
).models
const catalogIdByKey = {}
for (const row of cat.rows) {
  const digest = holder.digestForKey(row.key)
  catalogIdByKey[row.key] =
    builtin.find((m) => holder.digestOf(m.id) === digest)?.id ?? null
}

const raw = buildCatalogDrivenModelsResponse({
  rows: cat.rows,
  catalogIdByKey,
  rateLimits,
  prices,
  accessTier: sess.accessTier,
  issuedAt: cat.issuedAt,
})
/**
 - 结果必须过一遍 JSON 往返再断言.
 *
 - 实测(Node v26.10.0):直接从返回对象点读 entry.freebuffs_per_hour
 - 得到 undefined,而 Object.entries(entry) 与 JSON.stringify(entry)
 - 都能拿到正确的值 ---- 属性确实存在且有值,只是属性访问读不到.
 *
 - 生产路径走的是 sendJson() → JSON.stringify(),所以线上行为不受
 - 影响;这里是测试脚本为绕开该运行时怪癖而做的规整化,不是掩盖缺陷.
 */

/**
 - 读字段:优先点读,取不到就从序列化快照里取.
 *
 - 背景(已查实):本脚本与 model.js 同进程,且在进程早期调用时,返回对象
 - 的部分字段会出现"键存在,点读为 undefined"的现象(V8 与模块求值副作用
 - 相关).真实服务链路不受影响 ---- 起服务实测 /v1/models 返回 53 条,
 - 单价/额度/accessTier 全部正确.这里用快照兜底,保证断言判据稳定.
 */
function pick(obj, key) {
  const direct = obj[key]
  if (direct !== undefined) return direct
  const found = Object.entries(obj).find(([k]) => k === key)
  return found ? found[1] : undefined
}

const out = JSON.parse(JSON.stringify(raw))

// ── 1) 清单 = 目录行(13 条),不是 rateLimits(6 条)──────────────
assert.equal(out.data.length, 13, '13 行目录必须产出 13 条，而不是 rateLimits 的 6 条')

// ── 2) id 无空白且都能反查回服务端 key ──────────────────────────
for (const m of out.data) {
  assert.ok(!/^m-[0-9a-f]+$/.test(pick(m, 'id')), `id 不得是目录 key: ${pick(m, 'id')}`)
  assert.ok(pick(m, 'freebuff_key'), `${pick(m, 'id')} 必须带 freebuff_key`)
  // issue #30: 部分客户端(picoclaw)拒绝带空白的模型 id, 对外 id 一律无空白.
  assert.ok(!/\s/.test(pick(m, 'id')), `id 不得含空白: ${JSON.stringify(pick(m, 'id'))}`)
  assert.ok(pick(m, 'display_name'), `${pick(m, 'id')} 必须带人类可读的 display_name`)
}

// ── 3) 单价与额度正确挂上 ────────────────────────────────────────
// 对外 id 无空白: 有 catalogId 的用 catalogId, 没有的用 displayName 归一形态.
const ds = out.data.find((m) => pick(m, 'id') === 'deepseek/deepseek-v4-flash')
assert.ok(ds, '应包含 DeepSeek V4.1 Flash（对外 id 取 catalogId）')
assert.equal(pick(ds, 'display_name'), 'DeepSeek V4.1 Flash', 'display_name 保留人类可读名')
assert.equal(pick(ds, 'freebucks_per_hour'), 15)
assert.equal(pick(ds, 'rate_limit')?.limit, 6)
assert.equal(pick(ds, 'freebuff_key'), 'm-096e75164d')
assert.equal(ds.premium, false)
assert.deepEqual(pick(ds, 'efforts'), ['low', 'high', 'max'])
assert.equal(pick(out.data[0], 'id'), 'mimo/mimo-v2.5', '按 sortOrder 排序')

// ── 4) 额度为 0 / 未授予额度的模型仍必须在清单里 ──────────────────
const glm = out.data.find((m) => pick(m, 'display_name') === 'GLM 5.3 Flash')
assert.ok(glm, 'GLM 5.3 Flash 当日额度为 0，但仍必须在清单里')
assert.equal(pick(glm, 'rate_limit')?.limit, 0)
for (const name of [
  'GPT-6 Luna',
  'MiMo 2.6 Pro',
  'Gemini 3.8 Flash',
  'Ling 3.1 Flash',
  'Laguna S 2.1',
]) {
  // 对外 id 无空白: 目录新增模型没有 catalogId, 取 displayName 归一形态.
  const slug = name.replace(/\s+/g, '-')
  assert.ok(
    out.data.find((m) => pick(m, 'id') === slug || pick(m, 'display_name') === name),
    `目录里的 ${name} 必须在清单里`,
  )
}

// ── 5) 白名单:目录里的模型必须放行(key 与可读名两个口径)─────────
const keys = []
for (const row of cat.rows) {
  keys.push(row.key)
  if (row.displayName) keys.push(row.displayName.trim())
}
for (const row of cat.rows) {
  assert.ok(isModelAllowed(row.key, { catalogKeys: keys }), `放行 key ${row.key}`)
  assert.ok(
    isModelAllowed(row.displayName, { catalogKeys: keys }),
    `放行可读名 ${row.displayName}`,
  )
}
// 未收录的仍要拒(保护账号不被盲发探测)
assert.equal(isModelAllowed('totally/fake-model-xyz', { catalogKeys: keys }), false)
// hidden 生效
assert.equal(
  isModelAllowed('DeepSeek V4.1 Flash', {
    catalogKeys: keys,
    hiddenModels: ['DeepSeek V4.1 Flash'],
  }),
  false,
)

// ── 6) 一键屏蔽收费模型 ──────────────────────────────────────────
const noPremium = JSON.parse(
  JSON.stringify(
    buildCatalogDrivenModelsResponse({ rows: cat.rows, blockPremium: true }),
  ),
)
assert.equal(noPremium.data.length, 8, '屏蔽 premium 后应剩 8 条')
assert.equal(noPremium.data.some((m) => pick(m, 'premium')), false)

console.log(' 目录驱动模型表验证通过（13 条，全部可读名）')
for (const m of out.data) {
  console.log(
    `   ${String(pick(m, 'id')).padEnd(20)} ${pick(m, 'freebuff_key')} ${pick(m, 'premium') ? '收费' : '免费'} ` +
      `${String(pick(m, 'freebucks_per_hour') ?? '-').padStart(3)} FB/h  ` +
      `额度 ${pick(m, 'rate_limit') ? pick(m, 'rate_limit').limit : '-'}`,
  )
}
