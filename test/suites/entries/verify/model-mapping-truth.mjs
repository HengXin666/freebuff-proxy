/**
 - 模型标识映射:三种形式必须互相归一 + 真源唯一性.
 *
 - 为什么单独有此文件(用户原话,2026-10-04):
 - "所有的对下游都会映射,所有的对上游的也会映射,你每次都忘这个东西."
 *
 - 模型标识有三套形式,必须能互相归一:
 - ① 目录 key      m-096e75164d                 服务端标识,调度内部一律用它
 - ② 上游 legacy id deepseek/deepseek-v4-flash   上游会话清单 desktopPurchases[].model 用的
 - ③ 可读名         DeepSeek V4.1 Flash          前端 / /v1/models 展示用
 *
 - 历史故障(真实的,花过钱的):缺 ②→① 这条映射,于是上游会话清单里
 - model: 'deepseek/deepseek-v4-flash' 与调度内部的 m-096e75164d 严格相等
 - 永远匹配不上 → 面板能显示一条已付费会话,调度却看不见它 → 白花钱去别处
 - 买新的.
 *
 - 唯一真源 = src/upstream/catalog-protocol.js 的 CatalogHolder:
 - keyForName(name)           三种输入(可读名 / 上游 id / 已是 key)→ 目录 key
 - handleFor() / handleForModel()  标识 → 目录句柄(fbm1.xxx)
 - freebuffLegacyModelDigest()       上游 id 的 FNV-1a 摘要(官方算法)
 *
 - 用例已按域拆进 test/suites/verify-cases/**:
 - ① 三形式归一   -> ./verify-cases/normalize.mjs
 - ② 句柄路径     -> ./verify-cases/handle.mjs
 - ③ 返回值形态   -> ./verify-cases/key-shape.mjs
 - ④ 真源唯一性   -> 留在本文件(它扫的是整个 src/, 与用例数据无关)
 - ⑤ 构造接线     -> 留在本文件(需要真实 SessionManager)
 *
 - ── 可证伪(硬要求,本仓方法论)───────────────────────────────────────
 *
 - 破坏方式(实测过,见 Agent Note / 交付报告):
 - 把 catalog-protocol.js 的 keyForName() 里
 - const byDigest = this.keyByDigest?.get(freebuffLegacyModelDigest(k))
 - 这一行注释掉,重跑本文件 —— [上游 id → 目录 key]的断言必须变红.
 - 注意 handleFor() 那条路径用的是另一张表(legacyIndex),所以句柄断言
 - 不该红;红在哪几条本身就是"这条映射挂在哪个索引上"的证据.
 *
 - 用法:node test/verify-model-mapping-truth.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {
  CatalogHolder,
  freebuffLegacyModelDigest,
} from '../../../../src/upstream/catalog-protocol.js'
import { ROOT, checkEqual, failures } from '../../verify-cases/_harness.mjs'
import { run as runHandle } from '../../verify-cases/handle.mjs'
import { run as runKeyShape } from '../../verify-cases/key-shape.mjs'
import { run as runNormalize } from '../../verify-cases/normalize.mjs'

// ① ② ③ 三个用例(实现见 test/suites/verify-cases/**)
runNormalize()
runHandle()
runKeyShape()

// ═══ ④ 真源唯一性:除 catalog-protocol.js 外不得有第二套映射实现 ═════
{
  const TRUTH_SOURCE = join('src', 'upstream', 'catalog-protocol.js')

  /**
   - 判据(用户点名):其它文件不得调用 freebuffLegacyModelDigest(,
   - 也不得直接读取 keyByDigest.
   -
   - 额外加一条方向判据(不需要任何例外):把摘要当作查询键去查表
   - (X.get(freebuffLegacyModelDigest(...)))—— 这正是"上游 id → 目录 key"
   - 的实现形态,任何非真源文件出现它都直接判违规.
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
   - 兜底判据:要调用真源的摘要函数,就必须 import 它 —— 而 import 的来源
   - 必须指向真源文件.任何从别处 import 同名符号(= 自造一份摘要/映射)
   - 都直接判违规.这条不给任何例外,比"豁免 import 行"更紧.
   */
  const IMPORT_DIGEST = /import\s*\{[^}]*\bfreebuffLegacyModelDigest\b[^}]*\}\s*from\s*(['"])([^'"]+)\1/

  /**
   - 既有邻接点(逐行,逐字授权,不是文件级豁免).
   -
   - 这些点借用真源的摘要函数做反方向检索(目录 key → 摘要 → 内置可读
   - id),键来自真源桶,不产生第二张"上游 id → 目录 key"表.
   - 它们的存在是债务,不是许可:
   - - 任何新增的行都不在此列 → 立即 FAIL;
   - - 本表里任何一条未被命中(被删/改写了)→ 也 FAIL,逼着同步收拢,
   - 免得例外清单腐烂成后门.
   - 收拢进 AccountRuntimes.resolveModelAlias / displayNameFor 之后,
   - 本表应清空,判据即可升级为"零例外".
   */
  const KNOWN_NEIGHBOURS = new Map([
    [
      `account-catalog.ts|if (m?.id && freebuffLegacyModelDigest(m.id) === digest && m.displayName) {`,
      '_modelDisplayName 兜底：m.id 来自**内置静态表**，方向是 key → 摘要 → 内置显示名。',
    ],
    [
      `account-catalog.ts|if (m?.id && freebuffLegacyModelDigest(m.id) === digest) return m.id`,
      '_modelCatalogId 兜底：同上，反方向检索内置可读 id。',
    ],
    // 注：原两条 src/web/api.js 的邻接点（catalogIdForKey 自己读 keyByDigest
    // 并调 freebuffLegacyModelDigest）已在 2026-10-05 收拢进单一真源
    // （改为调 AccountRuntimes.modelAliases），因此从本表删除 —— 例外清单
    // 只许收拢，收拢后必须同步删条目，否则本文件的 stale 判据会 FAIL。
  ])

  // 迁移期必须同时扫两种后缀：只扫 .js 时，一旦某文件转成 .ts，它就整体
  // 退出判据面 —— 实测 src/web 转 .ts 后 4 个授权邻接点全部不再被扫，
  // 而"例外清单未被命中"这条又会把它们报成 stale，看起来像"债务清完了"。
  const SCAN_EXT = ['.js', '.mjs', '.ts']
  function listSourceFiles(dir) {
    const out = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...listSourceFiles(p))
      else if (e.isFile() && SCAN_EXT.some((x) => p.endsWith(x))) out.push(p)
    }
    return out
  }
  /** 扫描面下限：防止路径/后缀写错时"零违规"与"什么都没扫"无法区分。 */
  const SCAN_MIN = 40

  /** 整行注释不计(注释里的提及不是实现;不做行内剥离以免误切字符串里的 //). */
  function isCommentLine(text) {
    return (
      text.startsWith('//') ||
      text.startsWith('*') ||
      text.startsWith('/*') ||
      text.startsWith('*/')
    )
  }

  const scanned = listSourceFiles(join(ROOT, 'src'))
    .map((p) => relative(ROOT, p))
    .filter((rel) => rel !== TRUTH_SOURCE)
  checkEqual(scanned.length >= SCAN_MIN, true, `真源扫描面必须覆盖足够多文件（实测 ${scanned.length}，下限 ${SCAN_MIN}）`)

  const violations = []
  const hitNeighbours = new Set()

  for (const rel of scanned) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim()
      if (!text || isCommentLine(text)) continue

      // (A) 方向判据:算摘要去查表 = 这就是第二真源的实现本身
      if (DIGEST_AS_LOOKUP_KEY.test(text)) {
        violations.push({
          rel,
          line: i + 1,
          text,
          what: '把 legacy 摘要当查询键去查表（= 上游 id → 目录 key 的第二套实现）',
        })
        continue
      }
      // (A2) import 来源必须是真源文件本身(不许自造一份摘要)
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
        //  邻接点登记的是 "文件名|原文行": 只比对文件名与那一行原文,
        // 不比对整条路径 —— 本仓这几轮已实测三次目录重组
        // (src/app-context.js → src/context/account-catalog.ts →
        // src/context/catalog/account-catalog.ts), 每次都要改判据常量.
        // 按文件名比对让"搬进子目录"不再需要同步改常量, 而"那一行被删/改"
        // 仍会立刻暴露(原文行是逐字的).
        const id = `${basename(rel)}|${text}`
        if (KNOWN_NEIGHBOURS.has(id)) {
          hitNeighbours.add(id)
          continue
        }
        violations.push({ rel, line: i + 1, text, what: f.what })
      }
    }
  }

  const stale = [...KNOWN_NEIGHBOURS.keys()].filter((k) => !hitNeighbours.has(k))
  if (violations.length) {
    console.error(' 检出「模型标识映射」的第二真源实现：')
    for (const v of violations) {
      console.error(`   ${v.rel}:${v.line}  ${v.what}`)
      console.error(`     ${v.text}`)
    }
    console.error('   修法：改为调用真源 —— CatalogHolder.keyForName() / AccountRuntimes.resolveModelAlias()。')
  }
  checkEqual(
    hitNeighbours.size,
    KNOWN_NEIGHBOURS.size,
    `既有邻接点必须逐条命中（命中 ${hitNeighbours.size}/${KNOWN_NEIGHBOURS.size}，清单不允许腐烂）`,
  )
  checkEqual(violations.length, 0, '真源之外不得出现第二套「上游 id → 目录 key」实现')
  checkEqual(stale.length, 0, '例外清单必须与代码现状一致（不允许腐烂）')
}

// ═══ ⑤ 汇总 ═════════════════════════════════════════════════════════
{
  const { assertions } = await import('../../verify-cases/_harness.mjs')
  console.log('')
  if (failures.length || process.exitCode) {
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
}

// ── ⑥ SessionManager 必须真的接收并启用 resolveModelAlias ──────────────
//
//  实测缺陷(2026-10-05):SessionManager 的构造函数解构列表里漏了
// resolveModelAlias ---- 而 app-context 一直在传.JS 解构不会因为"多传了参数"
// 报错,于是 this.resolveModelAlias 恒为 undefined,
// holderFor() / freebucksFor() 的归一静默退化成严格相等.
//
// 后果正是要修的那个 bug:上游清单用上游 id,调度内部用目录 key →
// 永远匹配不上 → 面板能显示已付费会话,调度却看不见 → 白花钱重买.
// 而既有用例都用同形态标识,把这个缺陷掩盖了.
{
  const { SessionManager } = await import('../../../../src/session-manager.js')
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
  // 端到端:跨标识必须能命中同一条会话
  const { CatalogHolder: CH, freebuffLegacyModelDigest: digest } = await import(
    '../../../../src/upstream/catalog-protocol.js'
  )
  const holder = new CH({
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
        legacyDigests: [digest('deepseek/deepseek-v4-flash')],
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
