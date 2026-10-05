/**
 - check-notes ---- 注释规范(JSDoc 必须与签名一致).
 *
 - 拦什么(四条,只针对跨模块可见的契约):
 - 1. 导出函数/类缺 JSDoc ---- 对外契约没有文字,下游只能读实现猜;
 - 2. JSDoc 里的 @param 声明了签名里不存在的参数 ---- 这种注释比没有注释更
 - 危险,它会让人按错的名字去调用;
 - 3. 真实参数没有被 @param 覆盖;
 - 4. 导出函数有值返回却没有 @returns.
 *
 - 为什么不强制内部函数:那只会产出 // 设置 x 那类复述代码的注释,而本仓
 - 明确反对这种注释("注释讲为什么,代码讲怎么做").一条规范若与它自身的
 - 价值主张冲突,它就会被绕开.
 *
 - 存量:写于本门禁之前的导出符号按 文件::符号名 → 未清问题数 登记在
 - .gates/jsdoc-baseline.json,只许降不许涨;基线外的新符号一律必须合规.
 *
 - 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { loadWhitelist } from '../../rules.ts'
import { astFiles } from '../../lib/scan/files.ts'
import { Report } from '../../lib/text/report.ts'
import { readBaseline, reconcile, writeBaseline } from '../../lib/text/ratchet.ts'
import {
  hasValueReturn,
  isExported,
  isFunctionLike,
  jsdocOf,
  nameOf,
  paramNamesOf,
  paramTagName,
  parseFile,
  spanOf,
  tagsOf,
  ts,
  walk,
} from '../../lib/scan/ast.ts'

const BASELINE = 'jsdoc-baseline.json'
const report = new Report('notes')
const wl = loadWhitelist()

/** 收集一个文件里所有导出函数 / 类(类方法不单独要求,否则大类会刷屏). */
function exportsOf(rel) {
  const sf = parseFile(rel)
  const list = []
  walk(sf, (node) => {
    const isClass = ts.isClassDeclaration(node)
    if (!isFunctionLike(node) && !isClass) return
    if (!isExported(node) && !(node.parent && isExported(node.parent))) return
    list.push({ node, sf, name: nameOf(sf, node), line: spanOf(sf, node).start, isClass })
  })
  return list
}

/** 校验一个导出符号的四条判据,返回问题描述数组. */
function problemsOf(item) {
  const out = []
  const doc = jsdocOf(item.sf, item.node)
  if (!doc) {
    out.push('缺 JSDoc')
    return out
  }
  const tags = tagsOf(doc.text)
  const params = item.isClass ? [] : paramNamesOf(item.sf, item.node)
  const declared = tags.filter((t) => t.tag === 'param').map((t) => paramTagName(t.rest))
  for (const d of declared) {
    // 解构参数的文档写法是 @param {type} opts.key, 而 paramNamesOf 给的是键名
    // (key). 比对时把文档标签按 . 取末段, 两种写法都能对上.
    const dLeaf = d.includes('.') ? d.slice(d.lastIndexOf('.') + 1) : d
    // 三向都能对上: 完整名(d) / 末段(dLeaf) / 或者 d 是解构容器名(有参数以 d. 开头)
    const hit =
      !d ||
      params.some((real) => real === d || real.includes(d) || real === dLeaf) ||
      // d 是解构容器名(如 opts)时, 文档里会有 opts.key 这样的同级标签, 也算覆盖.
      declared.some((other) => other.startsWith(`${d}.`))
    if (!hit) {
      out.push(`@param ${d} 在签名里不存在（真实参数: ${params.join(', ') || '无'}）`)
    }
  }
  if (!item.isClass) {
    for (const p of params) {
      const simple = p.replace(/^\.\.\./, '')
      // 反向: 真实参数是解构键名时, 文档可能写 opts.key, 按末段比对.
      const covered = declared.some((d) => d === simple || d.endsWith(`.${simple}`))
      if (!covered) out.push(`参数 ${p} 缺 @param`)
    }
    if (hasValueReturn(item.node) && !tags.some((t) => t.tag === 'returns' || t.tag === 'return')) {
      out.push('有返回值但缺 @returns')
    }
  }
  return out
}

/** 逐符号统计:key → 问题数(棘轮观测值),details → 逐条明细. */
function survey() {
  const observed = {}
  const details = new Map()
  for (const rel of astFiles()) {
    let list
    try {
      list = exportsOf(rel)
    } catch (err) {
      report.add(rel, 1, `解析失败: ${err.message}`, '修语法后重跑（解析失败不许静默跳过）')
      continue
    }
    for (const item of list) {
      if (item.name === '(anonymous)') continue
      const key = `${rel}::${item.name}`
      if (wl.funcs.has(key)) continue
      const problems = problemsOf(item)
      if (problems.length === 0) continue
      observed[key] = problems.length
      details.set(key, { line: item.line, problems, name: item.name, rel })
    }
  }
  return { observed, details }
}

const { observed, details } = survey()
const { entries } = readBaseline(BASELINE)
const { grown, shrunk, fresh } = reconcile(observed, entries)

// 判定只有一条:这个符号的问题数比基线多了,或者它根本不在基线里.
// 基线内数量不变的存量带债通过(明细折叠成一条 note,不逐条刷屏).
const failing = new Set([...grown.map(([k]) => k), ...fresh])
for (const key of failing) {
  const d = details.get(key)
  const was = key in entries ? entries[key] : 0
  for (const p of d.problems) {
    report.add(
      d.rel,
      d.line,
      `导出符号 ${d.name}: ${p}（基线 ${was} 条 → 现 ${d.problems.length} 条）`,
      '补齐 JSDoc 的 @param/@returns，或改成真实参数名',
    )
  }
}

const stale = Object.keys(entries).filter((k) => !(k in observed))
if (process.argv.includes('--update')) {
  const file = writeBaseline(BASELINE, observed, { note: '导出符号的 JSDoc 债务：只许降不许涨；清掉后必须重录' })
  report.note(`已重录基线: ${file}`)
} else if (stale.length > 0 || shrunk.length > 0) {
  report.note(`${stale.length + shrunk.length} 个符号的注释债已清，请跑 --update 重录基线`)
}
report.note(`基线 ${Object.keys(entries).length} 个符号 / 本次 ${Object.keys(observed).length} 个带债 / 新增或恶化 ${failing.size} 个`)
report.note(`扫描 ${astFiles().length} 个文件`)

process.exit(report.finish())
