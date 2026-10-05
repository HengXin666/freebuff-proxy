/**
 * check-docs ---- 文档与代码对账(判据全部机器可判).
 *
 * 判据:
 *   1. 文档声称的本仓端点必须在代码里真实注册; 反向也查: 代码注册的对外端点
 *      必须在 docs/design/api.md 里有登记.
 *   2. 文档里引用的本仓文件路径必须存在.
 *   3. 同一主题不得有两份文档同时声称自己是真源(扫 真源 标记行).
 *   4. 索引 docs/README.md 必须存在, 且它登记的文档链接必须真实存在.
 *
 * 扫描集合是白名单(docs/** 去掉两个排除目录 + 仓库根 README.md).
 * 下列三类不扫:
 *   - docs/reverse/: 描述的是 Freebuff 上游的端点与文件, 不是本仓注册的对象.
 *   - docs/quality/docs-audit.md: 审计报告会故意引用错误端点与已删文件作反例.
 *   - .agents/notes/** 与 AGENTS.md: 决策记录与开发约定, 各有自己的门禁.
 *
 * 扫描根: CHECK_ROOT. 退出码: 0 PASS / 1 FAIL / 2 用法错.
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.ts'
import { trackedFiles } from '../../lib/scan/files.ts'
import { Report } from '../../lib/text/report.ts'
import { hasRoute, registeredRoutes } from './lib/routes.ts'

const report = new Report('docs')

/** 参与判据的文档前缀(白名单;见文件头). */
const DOC_INCLUDE = ['docs/', 'README.md']

/**
 * 白名单内部再排除的路径(见文件头[刻意不扫]).
 *
 * 2026-10-05 文档分类后,审计报告与工程质量全景同处 docs/quality/,但两者命运不同:
 * 全景描述现状,该参与全部判据;审计报告会故意引用错误端点与已删文件作反例,
 * 参与判据必然自噬.所以排除粒度从"docs/code-quality/ 目录"收窄到审计报告本身.
 */
const DOC_EXCLUDE = ['docs/reverse/', 'docs/quality/docs-audit']

/**
 * 允许"引用却不存在"的路径 ---- 只登记构建产物/外部资产,每条都要有理由.
 * 不做成通配符:豁免一旦能写 *,它就会变成"什么都豁免".
 */
const MISSING_OK = new Map([
  ['dashboard/version.json', '发版流水线注入的构建产物，.gitignore 已忽略（本地不存在是正确的）'],
  ['docs/images/01-overview.webp', '仓库内有；此处仅为防探针夹具缺资源时误报'],
])

/** 索引真源(判据 4 的检查对象). */
const INDEX = 'docs/README.md'

/**
 * 索引链接数下限 ---- 判据的下界断言,防"静默通过".
 *
 */
const MIN_INDEX_LINKS = 24

/** 真源声明的标记行:> 真源: <key>(key 是主题名,不是文件路径). */
const SOLE_SOURCE_RE = /^>\s*真源:\s*(\S+)\s*$/

/** 文档里的端点写法: GET /v1/models .只认反引号包裹 + 方法 + 路径的形态. */
const ENDPOINT_RE = /`(GET|POST|DELETE|PATCH|PUT|HEAD|OPTIONS|\*)\s+(\/[A-Za-z0-9_/:.*<>{}-]+)`/g

/** 文档里的本仓路径:只认这些前缀 + 带扩展名,避免把上游相对路径(common/src/x.ts)误判. */
const LOCAL_PREFIXES = ['src/', 'bin/', 'scripts/', 'test/', 'dashboard/', 'cli-bridge/', 'docs/']
const PATH_RE = new RegExp('`((?:' + LOCAL_PREFIXES.join('|') + ')[A-Za-z0-9_./-]+\\.[A-Za-z0-9]+)`', 'g')

/** 参与判据的文档清单(受控文件 → 白名单过滤). */
function docFiles() {
  return trackedFiles(ROOT).filter(
    (f) =>
      f.endsWith('.md') &&
      DOC_INCLUDE.some((p) => f === p || f.startsWith(p)) &&
      !DOC_EXCLUDE.some((p) => f.startsWith(p)),
  )
}

/** 读一个仓库内文件;读不到返回空串(存在性由判据 2 单独负责). */
function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return ''
  }
}

/** 上游面端点(判据 1 不适用):/api/v1/* 与上游 agent-runs 面. */
function isUpstreamEndpoint(p) {
  return p.startsWith('/api/v1') || p.startsWith('/api/agent-runs') || p.startsWith('/api/chat/')
}

/** 模板/通配形态(/v1/*,/api/accounts/<key>):模板不参与双向对账. */
function isTemplate(p) {
  return p.includes('*') || p.includes('<') || p.includes('{')
}

/**
 * 归一化:把模板里的变量段折成 :p,让文档写法与代码写法可逐段比对.
 *
 * @param {string} p 路径
 * @returns {string} 归一化后的路径
 */
function normalize(p) {
  return p.replace(/<[^>]*>/g, ':p').replace(/\{[^}]*\}/g, ':p')
}

/** 判据 1:文档端点 ↔ 代码注册,双向对账. */
function checkEndpoints() {
  const all = registeredRoutes()
  const proxyRoutes = new Set([...all].filter((p) => p.startsWith('/v1/') || p.startsWith('/health')))
  const apiRoutes = new Set([...all].filter((p) => p.startsWith('/api/')))
  const inApiDoc = new Set()

  for (const f of docFiles()) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(ENDPOINT_RE)) {
          const p = normalize(m[2])
          if (isUpstreamEndpoint(p) || isTemplate(p)) continue
          const known = p.startsWith('/api/') ? apiRoutes : proxyRoutes
          if (!hasRoute(known, p)) {
            report.add(f, i + 1, `文档写到的端点 \`${m[1]} ${m[2]}\` 在代码里没有注册`, '核对 src/ 里的路由注册，或改正文档')
          }
          if (f === 'docs/design/api.md' && !p.startsWith('/api/')) inApiDoc.add(p)
        }
      })
  }

  // 反向:代码注册的对外端点必须在 docs/design/api.md 登记(/health 是 /healthz 的别名,一并认).
  const alias = { '/health': '/healthz' }
  for (const p of proxyRoutes) {
    if (!p.startsWith('/v1/') && !p.startsWith('/health')) continue
    if (isTemplate(p) || p === '/v1/') continue
    const bare = p.endsWith(':p') ? p.slice(0, -2) : p
    if (!inApiDoc.has(bare) && !inApiDoc.has(alias[bare])) {
      report.add('docs/design/api.md', 0, `代码注册了对外端点 ${p}，但 docs/design/api.md 未登记`, `在路由表里补一行 ${p}`)
    }
  }
  report.note(
    `端点：对外 ${proxyRoutes.size} 条 · 控制台 ${apiRoutes.size} 条 · ` +
      `docs/design/api.md 声明 ${inApiDoc.size} 条（扫 src/ 全域）`,
  )
}

/** 判据 2:文档引用的本仓路径必须存在. */
function checkLocalPaths() {
  let checked = 0
  for (const f of docFiles()) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(PATH_RE)) {
          checked++
          if (MISSING_OK.has(m[1])) continue
          if (fs.existsSync(path.join(ROOT, m[1]))) continue
          report.add(f, i + 1, `引用的本仓文件不存在: ${m[1]}`, '删除该引用，或改指真实文件（上游路径别写成仓库相对路径）')
        }
      })
  }
  report.note(`文件引用：核对 ${checked} 处本仓路径（豁免 ${MISSING_OK.size} 条构建产物）`)
}

/** 判据 3:同一主题不得有两份文档声称自己才是真源. */
function checkSoleSource() {
  const claims = new Map()
  for (const f of docFiles()) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        const m = line.match(SOLE_SOURCE_RE)
        if (!m) return
        claims.set(m[1], [...(claims.get(m[1]) ?? []), `${f}:${i + 1}`])
      })
  }
  for (const [topic, where] of claims) {
    if (where.length > 1) {
      const msg = `主题「${topic}」有 ${where.length} 份文档同时声称自己是真源: ${where.join(' , ')}`
      report.add(where[0].split(':')[0], 0, msg, '只保留一份，其余改为指向它')
    }
  }
  report.note(`真源声明：${claims.size} 个主题${claims.size ? `（${[...claims.keys()].join(' / ')}）` : ''}`)
}

/** 判据 4:索引存在,且登记的本仓链接不悬空. */
function checkIndex() {
  if (!fs.existsSync(path.join(ROOT, INDEX))) {
    report.add(INDEX, 0, '索引文件不存在（没有一份能回答「哪个主题看哪个文件」的真源）', `新建 ${INDEX}`)
    return
  }
  const links = new Set()
  for (const m of read(INDEX).matchAll(/\]\(([^)#\s]+\.md)[^)]*\)/g)) links.add(m[1])
  const linked = new Set()
  for (const rel of links) {
    if (/^https?:/.test(rel)) continue
    const target = path.posix.normalize(path.posix.join('docs', rel))
    linked.add(target)
    if (!fs.existsSync(path.join(ROOT, target))) {
      report.add(INDEX, 0, `索引登记的 ${rel} 不存在（指向 ${target}）`, '修好链接或从索引里删除该行')
    }
  }
  // 下界断言:防止"把 markdown 链接整批吃掉"的后处理让本判据数到 0 条链接而静默通过.
  if (links.size < MIN_INDEX_LINKS) {
    const msg = `索引只解析出 ${links.size} 个文档链接（下限 ${MIN_INDEX_LINKS}）—— 链接语法可能被整批破坏`
    report.add(INDEX, 0, msg, '检查是否有格式化/清洗脚本吃掉了 markdown 链接语法')
  }
  // 反向覆盖:docs/ 下每份 .md 都必须被索引链接.
  // 双向判据:只判"登记的链接指向不存在的文件"(正向)挡不住"索引漏登记";
  // 而漏登记的后果与"链接被整批吃掉"一样(读者找不到那份文档),正向判据却完全不响.
  for (const f of docs) {
    if (f === INDEX) continue
    if (!linked.has(f)) {
      report.add(INDEX, 0, `${f} 存在但索引未登记（读者找不到它）`, `在索引里补一行链接到 ${f}`)
    }
  }
  report.note(`索引：登记 ${links.size} 个链接 / 覆盖 ${docs.length - 1} 份文档`)
}

const docs = docFiles()
if (docs.length < 5) {
  console.error(`usage: 参与判据的文档过少（${docs.length} 份），扫描根可能不对: ${ROOT}`)
  process.exit(2)
}

checkEndpoints()
checkLocalPaths()
checkSoleSource()
checkIndex()
report.note(`扫描 ${docs.length} 份文档（白名单 ${DOC_INCLUDE.join(' / ')}，排除 ${DOC_EXCLUDE.join(' / ')}）`)

process.exit(report.finish())
