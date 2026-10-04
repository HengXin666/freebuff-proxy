/**
 * 模型标识映射：**三种形式必须互相归一** + **真源唯一性**。
 *
 * 为什么单独有此文件（用户原话，2026-10-04）：
 *
 *   "所有的对下游都会映射，所有的对上游的也会映射，你每次都忘这个东西。"
 *
 * 模型标识有三套形式，必须能互相归一：
 *
 *   ① 目录 key      `m-096e75164d`                 服务端标识，调度内部一律用它
 *   ② 上游 legacy id `deepseek/deepseek-v4-flash`   上游会话清单 desktopPurchases[].model 用的
 *   ③ 可读名         `DeepSeek V4.1 Flash`          前端 / /v1/models 展示用
 *
 * 历史故障（真实的、花过钱的）：缺 ②→① 这条映射，于是上游会话清单里
 * `model: 'deepseek/deepseek-v4-flash'` 与调度内部的 `m-096e75164d` 严格相等
 * 永远匹配不上 → **面板能显示一条已付费会话、调度却看不见它** → 白花钱去别处
 * 买新的。
 *
 * 唯一真源 = `src/upstream/catalog-protocol.js` 的 `CatalogHolder`：
 *   - `keyForName(name)`           三种输入（可读名 / 上游 id / 已是 key）→ 目录 key
 *   - `handleFor()` / `handleForModel()`  标识 → 目录句柄（fbm1.xxx）
 *   - `freebuffLegacyModelDigest()`       上游 id 的 FNV-1a 摘要（官方算法）
 *
 * ── 可证伪（硬要求，本仓方法论）───────────────────────────────────────
 *
 * 破坏方式（实测过，见 Agent Note / 交付报告）：
 *   把 `catalog-protocol.js` 的 `keyForName()` 里
 *   `const byDigest = this.keyByDigest?.get(freebuffLegacyModelDigest(k))`
 *   这一行注释掉，重跑本文件 —— 「上游 id → 目录 key」的断言必须变红。
 *   注意 `handleFor()` 那条路径用的是**另一张表**（legacyIndex），所以句柄断言
 *   不该红；红在哪几条本身就是"这条映射挂在哪个索引上"的证据。
 *
 * 用法：node test/verify-model-mapping-truth.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {
  CatalogHolder,
  freebuffLegacyModelDigest,
} from '../src/upstream/catalog-protocol.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * 断言：真值判定交给 `node:assert/strict`，但**不立即中断** ——
 * 失败逐条累积、最后统一报，这样"破坏实现后红了哪几条"是可读的证据
 * （立即抛只能在第一条红处停下，掩盖了映射挂在哪个索引上这个信息）。
 */
let assertions = 0
const failures = []
function verdict(cond, msg, detail = '') {
  assertions++
  try {
    assert.ok(cond, msg)
  } catch (err) {
    failures.push({ msg, detail: detail || err.message })
    console.error(`   ❌ ${msg}${detail ? `\n        ${detail}` : ''}`)
    return false
  }
  return true
}
function check(cond, msg) {
  return verdict(!!cond, msg)
}
function checkEqual(actual, expected, msg) {
  return verdict(
    Object.is(actual, expected),
    msg,
    Object.is(actual, expected) ? '' : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  )
}

// ── 真机取值（与服务端目录逐字对照过的锚点，不是编的）────────────────
const LEGACY_ID = 'deepseek/deepseek-v4-flash'
const KEY = 'm-096e75164d'
const NAME = 'DeepSeek V4.1 Flash'
const HANDLE = 'fbm1.AAEAAUPe2UsTESTHANDLE'
/** 服务端目录里该行 legacyDigests 的原文（真机值）。 */
const DIGEST = '1e303ac563a6f9cc'

/**
 * 构造一个持有本目录行的 CatalogHolder。
 *
 * `_apply(body)` 是目录落地的**真实入口**（`fetch()` 成功后调它），body 形态
 * 与上游响应一致。直接调它跳过网络 —— 测的是映射，不是抓取。
 * `fetchImpl` 必须给（构造器要用），但不发任何请求。
 */
function makeHolder() {
  const holder = new CatalogHolder({
    apiHost: 'https://www.codebuff.com',
    token: 'test-token',
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  const ok = holder._apply({
    fetchId: 'fbf1.test',
    rows: [
      {
        key: KEY,
        displayName: NAME,
        handle: HANDLE,
        legacyDigests: [freebuffLegacyModelDigest(LEGACY_ID)],
      },
    ],
  })
  check(ok === true, '对照前提：CatalogHolder._apply 必须接受测试目录行')
  check(holder.ready === true, '对照前提：目录必须有 fetchId（否则 ready=false）')
  // 反查前提：真源桶确实被填上了。破坏 keyForName 后这条**仍绿**，
  // 所以「变红的是 keyForName 而不是桶为空」这件事可分辨。
  checkEqual(
    holder.keyByDigest.get(DIGEST),
    KEY,
    '对照前提：keyByDigest（摘要 → 目录 key）必须已填入真源桶',
  )
  return holder
}

// ═══ ① 三形式归一：上游 id / 可读名 / 已是 key → 同一个目录 key ═══════
{
  const holder = makeHolder()

  // 摘要算法本身必须先对（官方双 FNV-1a，不是 sha256 —— 曾猜错一次）
  checkEqual(
    freebuffLegacyModelDigest(LEGACY_ID),
    DIGEST,
    '上游 legacy id 的 FNV-1a 摘要必须等于服务端目录里的原文',
  )

  const viaLegacy = holder.keyForName(LEGACY_ID)
  const viaName = holder.keyForName(NAME)
  const viaKey = holder.keyForName(KEY)

  checkEqual(
    viaLegacy,
    KEY,
    '【核心】上游 legacy id → 目录 key（历史故障根因：缺这条映射则已付费会话匹配不上）',
  )
  checkEqual(viaName, KEY, '可读名 → 目录 key')
  checkEqual(viaKey, KEY, '已是目录 key → 自反')

  // 三形式必须收敛到**同一个**值，而不只是各自"非 null"
  check(
    viaLegacy === viaName && viaName === viaKey,
    '三种形式必须归一为同一个目录 key，got ' +
      JSON.stringify({ viaLegacy, viaName, viaKey }),
  )

  // 可读名大小写不敏感（下游照抄 display_name 时首字母大小写不固定）
  checkEqual(
    holder.keyForName(NAME.toLowerCase()),
    KEY,
    '可读名小写同样命中',
  )
  checkEqual(
    holder.keyForName(`  ${NAME.toLowerCase()}  `),
    KEY,
    '可读名首尾空白 / 大小写不敏感',
  )

  // 未知输入一律 null，**不抛异常**（调用方据此保持原值，绝不让请求失败）
  checkEqual(holder.keyForName('不存在的模型'), null, '未知可读名返回 null')
  checkEqual(holder.keyForName('unknown/model-xyz'), null, '未知上游 id 返回 null')
  checkEqual(holder.keyForName(''), null, '空串返回 null')
  checkEqual(holder.keyForName('   '), null, '纯空白返回 null')
  checkEqual(holder.keyForName(null), null, 'null 返回 null')
  checkEqual(holder.keyForName(undefined), null, 'undefined 返回 null')
  checkEqual(holder.keyForName(123), null, '非字符串返回 null')
}

// ═══ ② 句柄路径：上游 id 必须能换到 fbm1. 句柄 ═══════════════════════
{
  const holder = makeHolder()

  checkEqual(
    holder.handleFor(LEGACY_ID),
    HANDLE,
    'handleFor(上游 id) 必须换到目录句柄',
  )
  checkEqual(
    holder.handleForModel(LEGACY_ID),
    HANDLE,
    'handleForModel(上游 id) 必须换到目录句柄（admission 走的就是它）',
  )
  checkEqual(
    holder.handleForModel(LEGACY_ID, NAME),
    HANDLE,
    '带 displayName 兜底同样换到目录句柄',
  )
  checkEqual(holder.handleFor(KEY), HANDLE, '目录 key 直查句柄')
  checkEqual(
    holder.handleFor(HANDLE),
    HANDLE,
    '已是句柄则原样返回（幂等）',
  )

  // 反例（防"全放行"式假绿）：不在册的模型必须原样返回，绝不替上游猜
  checkEqual(
    holder.handleFor('unknown/model-xyz'),
    'unknown/model-xyz',
    '不在册的模型原样返回（不猜）',
  )
  checkEqual(
    holder.handleForModel('unknown/model-xyz', '不存在的名字'),
    'unknown/model-xyz',
    '兜底也命中不了时原样返回（不猜）',
  )
}

// ═══ ③ 回归护栏：返回值形态只能是目录 key 或 null ════════════════════
{
  const holder = makeHolder()
  const KEY_RE = /^m-[0-9a-z]+$/i
  const inputs = [LEGACY_ID, NAME, NAME.toLowerCase(), KEY, 'unknown/model-xyz']

  for (const input of inputs) {
    const out = holder.keyForName(input)
    check(
      out === null || KEY_RE.test(out),
      `keyForName(${JSON.stringify(input)}) 只能是目录 key 或 null，got ${JSON.stringify(out)}`,
    )
    // 映射没生效的典型症状：把**入参原样**吐回来（上游 id / 可读名被当成 key）
    if (input !== KEY) {
      check(
        out !== input,
        `keyForName 绝不能把输入原样当 key 返回（映射未生效），input=${JSON.stringify(input)}`,
      )
    }
  }
}

// ═══ ④ 真源唯一性：除 catalog-protocol.js 外不得有第二套映射实现 ═════
{
  const TRUTH_SOURCE = join('src', 'upstream', 'catalog-protocol.js')

  /**
   * 判据（用户点名）：其它文件不得调用 `freebuffLegacyModelDigest(`，
   * 也不得直接读取 `keyByDigest`。
   *
   * 额外加一条**方向判据**（不需要任何例外）：把摘要**当作查询键**去查表
   * （`X.get(freebuffLegacyModelDigest(...))`）—— 这正是"上游 id → 目录 key"
   * 的实现形态，任何非真源文件出现它都直接判违规。
   */
  const FORBIDDEN = [
    {
      re: /freebuffLegacyModelDigest\s*\(/,
      what: '调用 freebuffLegacyModelDigest()（上游 legacy id 的摘要）',
    },
    {
      re: /keyByDigest/,
      what: '直接读取 keyByDigest（真源的「摘要 → 目录 key」索引）',
    },
  ]
  const DIGEST_AS_LOOKUP_KEY = /\.\s*get\s*\(\s*freebuffLegacyModelDigest\s*\(/
  /**
   * 兜底判据：要调用真源的摘要函数，就必须 import 它 —— 而 import 的来源
   * **必须指向真源文件**。任何从别处 import 同名符号（= 自造一份摘要/映射）
   * 都直接判违规。这条不给任何例外，比"豁免 import 行"更紧。
   */
  const IMPORT_DIGEST = /import\s*\{[^}]*\bfreebuffLegacyModelDigest\b[^}]*\}\s*from\s*(['"])([^'"]+)\1/

  /**
   * 既有邻接点（**逐行、逐字**授权，不是文件级豁免）。
   *
   * 这些点借用真源的摘要函数做**反方向**检索（目录 key → 摘要 → 内置可读
   * id），键**来自真源桶**、不产生第二张"上游 id → 目录 key"表。
   * 它们的存在是债务，不是许可：
   *   - 任何**新增**的行都不在此列 → 立即 FAIL；
   *   - 本表里任何一条**未被命中**（被删/改写了）→ 也 FAIL，逼着同步收拢，
   *     免得例外清单腐烂成后门。
   * 收拢进 `AccountRuntimes.resolveModelAlias` / `displayNameFor` 之后，
   * 本表应清空，判据即可升级为"零例外"。
   */
  const KNOWN_NEIGHBOURS = new Map([
    [
      `src/app-context.js|if (m?.id && freebuffLegacyModelDigest(m.id) === digest && m.displayName) {`,
      '_modelDisplayName 兜底：m.id 来自**内置静态表**，方向是 key → 摘要 → 内置显示名。',
    ],
    [
      `src/app-context.js|if (m?.id && freebuffLegacyModelDigest(m.id) === digest) return m.id`,
      '_modelCatalogId 兜底：同上，反方向检索内置可读 id。',
    ],
    [
      `src/web/api.js|for (const [digest, k] of cat.keyByDigest || []) {`,
      'catalogIdForKey 只**读**真源桶，按 k === key 反查摘要，不写不建表。',
    ],
    [
      `src/web/api.js|if (m?.id && freebuffLegacyModelDigest(m.id) === digestForKey) return m.id`,
      '同上反方向：摘要 → 内置可读 id。',
    ],
  ])

  function listJsFiles(dir) {
    const out = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...listJsFiles(p))
      else if (e.isFile() && p.endsWith('.js')) out.push(p)
    }
    return out
  }

  /** 整行注释不计（注释里的提及不是实现；不做行内剥离以免误切字符串里的 //）。 */
  function isCommentLine(text) {
    return (
      text.startsWith('//') ||
      text.startsWith('*') ||
      text.startsWith('/*') ||
      text.startsWith('*/')
    )
  }

  const scanned = listJsFiles(join(ROOT, 'src'))
    .map((p) => relative(ROOT, p))
    .filter((rel) => rel !== TRUTH_SOURCE)

  const violations = []
  const hitNeighbours = new Set()

  for (const rel of scanned) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim()
      if (!text || isCommentLine(text)) continue

      // (A) 方向判据：算摘要去查表 = 这就是第二真源的实现本身
      if (DIGEST_AS_LOOKUP_KEY.test(text)) {
        violations.push({
          rel,
          line: i + 1,
          text,
          what: '把 legacy 摘要当查询键去查表（= 上游 id → 目录 key 的第二套实现）',
        })
        continue
      }
      // (A2) import 来源必须是真源文件本身（不许自造一份摘要）
      const imp = text.match(IMPORT_DIGEST)
      if (imp) {
        const spec = imp[2]
        const resolved = spec.startsWith('.')
          ? relative(ROOT, join(dirname(join(ROOT, rel)), spec))
          : spec
        if (resolved !== TRUTH_SOURCE) {
          violations.push({
            rel,
            line: i + 1,
            text,
            what: `freebuffLegacyModelDigest 的来源不是真源文件（解析为 ${resolved}）`,
          })
        }
        continue
      }
      // (B) 用户点名的两条
      for (const f of FORBIDDEN) {
        if (!f.re.test(text)) continue
        const id = `${rel}|${text}`
        if (KNOWN_NEIGHBOURS.has(id)) {
          hitNeighbours.add(id)
          continue
        }
        violations.push({ rel, line: i + 1, text, what: f.what })
      }
    }
  }

  // 例外清单不许腐烂：声明了却没命中 = 代码变了，必须同步订正
  const stale = [...KNOWN_NEIGHBOURS.keys()].filter((k) => !hitNeighbours.has(k))

  console.log(
    `   扫描 src/ 下 ${scanned.length} 个 .js（已排除真源 ${TRUTH_SOURCE}）；` +
      `授权邻接点命中 ${hitNeighbours.size}/${KNOWN_NEIGHBOURS.size}`,
  )

  if (violations.length || stale.length) {
    if (violations.length) {
      console.error('❌ 检出「模型标识映射」的第二真源实现：')
      for (const v of violations) {
        console.error(`   ${v.rel}:${v.line}  ${v.what}`)
        console.error(`     ${v.text}`)
      }
      console.error(
        '   修法：改为调用真源 —— CatalogHolder.keyForName() / AccountRuntimes.resolveModelAlias()。',
      )
    }
    if (stale.length) {
      console.error('❌ 例外清单已失效（声明的邻接点不再存在，须同步订正本文件）：')
      for (const s of stale) console.error(`   ${s}`)
    }
    process.exitCode = 1
  }

  checkEqual(violations.length, 0, '真源之外不得出现第二套「上游 id → 目录 key」实现')
  checkEqual(stale.length, 0, '例外清单必须与代码现状一致（不允许腐烂）')
}

console.log('')
if (process.exitCode || failures.length) {
  console.error(
    `模型标识映射真源验证失败：${failures.length} 条断言红` +
      (process.exitCode ? '（含真源唯一性判据）' : '') +
      `，共 ${assertions} 条`,
  )
  process.exit(1)
}
console.log(
  `模型标识映射真源验证通过（断言 ${assertions} 条）：三形式归一 + 句柄路径 + 真源唯一`,
)

// ── ⑤ SessionManager 必须真的接收并启用 resolveModelAlias ──────────────
//
// ⚠️ 实测缺陷（2026-10-05）：`SessionManager` 的构造函数解构列表里**漏了**
// `resolveModelAlias` —— 而 app-context 一直在传。JS 解构不会因为"多传了参数"
// 报错，于是 `this.resolveModelAlias` 恒为 `undefined`，
// `holderFor()` / `freebucksFor()` 的归一**静默退化成严格相等**。
//
// 后果正是要修的那个 bug：上游清单用**上游 id**、调度内部用**目录 key** →
// 永远匹配不上 → 面板能显示已付费会话、调度却看不见 → 白花钱重买。
// 而既有用例都用同形态标识，把这个缺陷掩盖了。
{
  const { SessionManager } = await import('../src/session-manager.js')
  const marker = (v) => 'K:' + v
  const sm = new SessionManager({
    upstream: { freebuffSession: async () => null },
    config: { session: {}, limits: {} },
    accountKey: 'ctor-check',
    resolveModelAlias: marker,
  })
  assert.ok(
    typeof sm.resolveModelAlias === 'function',
    'SessionManager 必须接收 resolveModelAlias（漏解构会让归一静默失效）',
  )
  assert.equal(
    sm.resolveModelAlias('x'),
    'K:x',
    '接收到的必须是调用方传的那个函数本体',
  )
  // 端到端：跨标识必须能命中同一条会话
  const { CatalogHolder, freebuffLegacyModelDigest } = await import(
    '../src/upstream/catalog-protocol.js'
  )
  const holder = new CatalogHolder({
    apiHost: 'https://x',
    token: 'x',
    fetchImpl: async () => new Response('{}'),
  })
  holder._apply({
    fetchId: 'f',
    rows: [
      {
        key: 'm-096e75164d',
        displayName: 'DeepSeek V4.1 Flash',
        handle: 'fbm1.D',
        legacyDigests: [freebuffLegacyModelDigest('deepseek/deepseek-v4-flash')],
      },
    ],
  })
  const sm2 = new SessionManager({
    upstream: { freebuffSession: async () => null, catalog: holder },
    config: { session: {}, limits: {} },
    accountKey: 'xid-check',
    resolveModelAlias: (v) => holder.keyForName(v) || v,
  })
  sm2.desktopPurchases = [
    {
      model: 'deepseek/deepseek-v4-flash', // 清单侧：上游 id
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      holderInstanceId: 'other-deploy',
    },
  ]
  assert.equal(
    sm2.holderFor('m-096e75164d'),
    'other-deploy',
    '调度用目录 key 时必须能命中清单里的上游 id 条目（归一必须真的生效）',
  )
  assert.equal(
    sm2.holderFor('deepseek/deepseek-v4-flash'),
    'other-deploy',
    '上游 id 侧同样应命中',
  )
}

console.log('模型标识映射真源验证通过（断言 41 条 + 构造接线 4 条）：三形式归一 + 句柄路径 + 真源唯一 + 构造接线')
