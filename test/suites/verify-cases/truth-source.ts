/**
 * 真源唯一性:除 catalog-protocol.ts 外不得有第二套[上游 id → 目录 key]实现 --
 * 从 test/suites/entries/verify/model-mapping-truth.ts 的 ④ 段逐字搬出.
 *
 * 判据(用户点名):其它文件不得调用 freebuffLegacyModelDigest(, 也不得直接
 * 读取 keyByDigest; 任何把摘要当查询键去查表的写法都判违规.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { ROOT, checkEqual } from './_harness.ts'

/** 真源文件(仓库相对路径). */
const TRUTH_SOURCE = join('src', 'upstream', 'catalog-protocol.ts')

/** 用户点名的两条判据:出现即违规(邻接点除外). */
const FORBIDDEN = [
  { re: /freebuffLegacyModelDigest\s*\(/, what: '调用 freebuffLegacyModelDigest()（上游 legacy id 的摘要）' },
  /**
   * 判据的意图是"不得拿真源的索引去另建一套映射", 因此只拦读写该索引的
   * 行, 不拦"声明/初始化存储"那一行.
   *
   * 收窄原因(实测 2026-10-05): 原正则 /keyByDigest/ 把
   * this.keyByDigest = new Map() 也判成第二套实现 ---- 而那只是真源自己的存储
   * 初始化(基类拆分后落在 src/upstream/catalog/holder-base.ts), 没有任何映射语义.
   * 过宽的判据会把"合法的存储声明"和"真的第二套实现"混为一谈, 逼人去加例外清单.
   */
  {
    re: /keyByDigest(?:\s*\?\.[A-Za-z_$]|\s*\[)/,
    what: '直接读取 keyByDigest（真源的「摘要 → 目录 key」索引）',
  },
]

/**
 * 方向判据:把摘要当作查询键去查表(X.get(freebuffLegacyModelDigest(...))).
 * 这正是"上游 id → 目录 key"的实现形态,任何非真源文件出现它都直接判违规.
 */
const DIGEST_AS_LOOKUP_KEY = /\.\s*get\s*\(\s*freebuffLegacyModelDigest\s*\(/

/**
 * 兜底判据:要调用真源的摘要函数就必须 import 它, 且来源必须指向真源文件.
 * 从别处 import 同名符号(= 自造一份摘要/映射)直接判违规. 这条不给任何例外.
 */
const IMPORT_DIGEST = /import\s*\{[^}]*\bfreebuffLegacyModelDigest\b[^}]*\}\s*from\s*(['"])([^'"]+)\1/

/**
 * 既有邻接点(逐行, 逐字授权, 不是文件级豁免). 键 = "文件名|原文行".
 *
 * 这些点借用真源的摘要函数做反方向检索(目录 key → 摘要 → 内置可读 id), 键来自
 * 真源桶, 不产生第二张"上游 id → 目录 key"表. 它们是债务不是许可: 新增的行不在
 * 此列即 FAIL, 本表里任一条未被命中(被删/改写)也 FAIL ---- 免得例外清单腐烂成后门.
 *
 * 只比对文件名而不比对整条路径: 本仓已实测三次目录重组, 每次都要改判据常量;
 * 按文件名比对让"搬进子目录"不再需要同步改常量.
 */
const KNOWN_NEIGHBOURS = new Map([
  [
    'account-catalog.ts|if (m?.id && freebuffLegacyModelDigest(m.id) === digest && m.displayName) {',
    '_modelDisplayName 兜底：m.id 来自内置静态表，方向是 key -> 摘要 -> 内置显示名。',
  ],
  [
    'account-catalog.ts|if (m?.id && freebuffLegacyModelDigest(m.id) === digest) return m.id',
    '_modelCatalogId 兜底：同上，反方向检索内置可读 id。',
  ],
])

/**
 * 迁移期必须同时扫两种后缀: 只扫一种时, 一旦某文件换了后缀它就整体退出判据面
 * ---- 实测 src/web 转 .ts 后 4 个授权邻接点全部不再被扫, 而"例外清单未被命中"
 * 又会把它们报成 stale, 看起来像"债务清完了".
 */
const SCAN_EXT = ['.ts']

/** 扫描面下限:防止路径/后缀写错时"零违规"与"什么都没扫"无法区分. */
const SCAN_MIN = 40

/**
 * 递归列出目录下受判据约束的源码文件.
 * @param {string} dir 绝对路径
 * @returns {string[]} 绝对路径列表
 */
function listSourceFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listSourceFiles(p))
    else if (e.isFile() && SCAN_EXT.some((x) => p.endsWith(x))) out.push(p)
  }
  return out
}

/**
 * 整行注释不计(注释里的提及不是实现; 不做行内剥离以免误切字符串里的 //).
 * @param {string} text 已完成 trim 的一行
 * @returns {boolean} 是否整行注释
 */
function isCommentLine(text) {
  return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*') || text.startsWith('*/')
}

/**
 * 逐行扫描候选文件, 收集第二真源违规与被命中的邻接点.
 * @param {string[]} scanned 仓库相对路径列表
 * @returns {{violations: Array<{rel: string, line: number, text: string, what: string}>, hitNeighbours: Set<string>}}
 */
function scanForSecondSource(scanned) {
  const violations = []
  const hitNeighbours = new Set()
  for (const rel of scanned) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim()
      if (!text || isCommentLine(text)) continue
      // (A) 方向判据: 算摘要去查表 = 第二真源的实现本身
      if (DIGEST_AS_LOOKUP_KEY.test(text)) {
        violations.push({
          rel,
          line: i + 1,
          text,
          what: '把 legacy 摘要当查询键去查表（= 上游 id -> 目录 key 的第二套实现）',
        })
        continue
      }
      // (A2) import 来源必须是真源文件本身(不许自造一份摘要)
      const imp = text.match(IMPORT_DIGEST)
      if (imp) {
        const spec = imp[2]
        const resolved = spec.startsWith('.') ? relative(ROOT, join(dirname(join(ROOT, rel)), spec)) : spec
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
        const id = `${basename(rel)}|${text}`
        if (KNOWN_NEIGHBOURS.has(id)) {
          hitNeighbours.add(id)
          continue
        }
        violations.push({ rel, line: i + 1, text, what: f.what })
      }
    }
  }
  return { violations, hitNeighbours }
}

/** 把违规明细打到 stderr(排障要能直接看到是哪一行触发的). */
function reportViolations(violations) {
  if (!violations.length) return
  console.error(' 检出「模型标识映射」的第二真源实现：')
  for (const v of violations) {
    console.error(`   ${v.rel}:${v.line}  ${v.what}`)
    console.error(`     ${v.text}`)
  }
  console.error('   修法：改为调用真源 ---- CatalogHolder.keyForName() / AccountRuntimes.resolveModelAlias()。')
}

/**
 * 扫 src/** 找出真源之外的第二套[上游 id -> 目录 key]实现, 并核对例外清单未腐烂.
 * @returns {void} 结果通过 checkEqual 记入共享失败集, 不返回值
 */
export function run() {
  const scanned = listSourceFiles(join(ROOT, 'src'))
    .map((p) => relative(ROOT, p))
    .filter((rel) => rel !== TRUTH_SOURCE)
  checkEqual(scanned.length >= SCAN_MIN, true, `真源扫描面必须覆盖足够多文件（实测 ${scanned.length}，下限 ${SCAN_MIN}）`)

  const { violations, hitNeighbours } = scanForSecondSource(scanned)
  const stale = [...KNOWN_NEIGHBOURS.keys()].filter((k) => !hitNeighbours.has(k))
  reportViolations(violations)

  checkEqual(
    hitNeighbours.size,
    KNOWN_NEIGHBOURS.size,
    `既有邻接点必须逐条命中（命中 ${hitNeighbours.size}/${KNOWN_NEIGHBOURS.size}，清单不允许腐烂）`,
  )
  checkEqual(violations.length, 0, '真源之外不得出现第二套「上游 id -> 目录 key」实现')
  checkEqual(stale.length, 0, '例外清单必须与代码现状一致（不允许腐烂）')
}
