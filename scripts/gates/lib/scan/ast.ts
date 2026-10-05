/**
 - AST 薄封装 ---- 用 TypeScript 编译器 API 解析 JS/TS.
 *
 *
 - 解析器从本仓 devDependency 取(版本与 npm run typecheck 完全一致),
 - 不引入新依赖 ---- 本仓的"超级轻量"铁律不允许为一个门禁加运行时依赖.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { ROOT } from '../../rules.ts'

const require = createRequire(import.meta.url)

/** 解析 TypeScript 模块;找不到依赖时以 usage 退出(静默跳过文件等于没检查). */
function loadTs() {
  try {
    return require('typescript')
  } catch (err) {
    console.error(`usage: 找不到 typescript 依赖（先 npm ci）: ${err.message}`)
    process.exit(2)
  }
}

const ts = loadTs()

/**
 - 脚本种类:.mjs/.js 走 JS,.ts 走 TS.
 - @param {string} rel 仓库相对路径
 - @returns {number} TypeScript 的 ScriptKind 枚举值
 */
export function scriptKind(rel) {
  if (rel.endsWith('.ts') || rel.endsWith('.tsx')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

/**
 - 解析一个文件;返回 SourceFile(带 parent 指针,便于取名字).
 - @param {string} rel 仓库相对路径
 - @param {string} [root] 扫描根(探针通过 CHECK_ROOT 指到夹具)
 - @returns {import('typescript').SourceFile} 解析结果
 */
export function parseFile(rel, root = ROOT) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  return ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, scriptKind(rel))
}

/**
 - 是否是可命名的函数节点(函数声明/表达式/箭头/方法/构造/存取器).
 - @param {import('typescript').Node} node 待判断节点
 - @returns {boolean} 是函数类节点则为真
 */
export function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

/**
 - 节点起止行(1-based,含末行).
 - @param {import('typescript').SourceFile} sf 源文件
 - @param {import('typescript').Node} node 目标节点
 - @returns {{start: number, end: number, lines: number}} 行号区间与行数
 */
export function spanOf(sf, node) {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  return { start, end, lines: end - start + 1 }
}

/**
 - 取函数名.匿名函数回落到它被赋给的名字(变量声明 / 属性赋值),
 - 这样报错信息里不会出现一堆 (anonymous) 而无法定位.
 - @param {import('typescript').SourceFile} sf 源文件
 - @param {import('typescript').Node} node 函数节点
 - @returns {string} 名字,取不到时为 (anonymous)
 */
export function nameOf(sf, node) {
  if (node.name && typeof node.name.getText === 'function') return node.name.getText(sf)
  const p = node.parent
  if (p && ts.isVariableDeclaration(p) && p.name) return p.name.getText(sf)
  if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf)
  if (p && ts.isPropertyDeclaration(p) && p.name) return p.name.getText(sf)
  return '(anonymous)'
}

/**
 - 遍历所有节点(深度优先,含根).
 - @param {import('typescript').Node} node 起始节点
 - @param {(n: import('typescript').Node) => void} visit 访问回调
 - @returns {void}
 */
export function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

/**
 - 取节点紧邻的前导 JSDoc(允许中间有空行).
 *
 - TypeScript 只在 node.jsDoc 上挂"紧贴"的文档注释;这里额外接受相隔空行的
 - 写法 ---- 本仓大量使用[大段落 JSDoc + 空行 + export]的风格,那是刻意的
 - (注释讲为什么,代码讲怎么做),不该被判违规.
 - @param {import('typescript').SourceFile} sf 源文件
 - @param {import('typescript').Node} node 目标节点
 - @returns {{text: string, endLine: number} | null} 文档注释与结束行
 */
export function jsdocOf(sf, node) {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.pos) ?? []
  const docs = ranges.filter(
    (r) => r.kind === ts.SyntaxKind.MultiLineCommentTrivia && sf.text.startsWith('/**', r.pos),
  )
  if (docs.length === 0) return null
  const last = docs[docs.length - 1]
  return {
    text: sf.text.slice(last.pos, last.end),
    endLine: sf.getLineAndCharacterOfPosition(last.end).line + 1,
  }
}

/**
 * 去掉注释行的前导装饰, 留下正文.
 *
 *
 * @param {string} line 注释原文的一行
 * @returns {string} 去掉前导装饰后的正文
 */
function stripCommentLead(line) {
  return line.replace(/^\s*\/?\*+\s?/, '').replace(/^\s*-\s+/, '')
}

/**
 - 从 text[start] 处的 { 开始,找与之配对的 } 下标(支持嵌套).
 - @param {string} text 待扫描文本
 - @param {number} start { 的下标
 - @returns {number} 配对 } 的下标;不配对时返回 -1
 */
function matchBrace(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 - 提取 JSDoc 里的标签.
 *
 - 三条必须遵守的规则,都是被误报/漏报逼出来的:
 - 1. 标签只在行首(去掉  *  前缀后紧跟 @).否则注释正文里举例写的
 - @param {string} opts  会被当成真标签 ---- 门禁于是对着正确的注释报错,
 - 而误报比漏报更能杀掉一条门禁(人被烦到之后会整条关掉它).
 - 2. 类型可以跨行:本仓大量使用 @param {{\n  a: string,\n  b?: number,\n}} [opts]
 - 这种多行对象字面量类型.只按单行解析会把它切成 @param {{,于是
 - "参数 opts 缺 @param"这种误报会稳定出现.
 - 3. 类型用括号配对扫描而不是正则,嵌套的 {{...}} 与可选参数方括号
 - ([timeoutMs=1000])都要能正确切出来.
 *
 - @param {string} docText JSDoc 原文(含开头定界符与结尾)
 - @returns {Array<{tag: string, type: string|null, rest: string}>} 标签列表
 */
export function tagsOf(docText) {
  const lines = docText.split('\n').map(stripCommentLead)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^@(\w+)[ \t]*/.exec(lines[i])
    if (!m) continue
    // 标签体 = 本行剩余 + 后续非标签行(跨行类型靠这一条支撑)
    let body = lines[i].slice(m[0].length)
    for (let j = i + 1; j < lines.length; j++) {
      if (/^@\w+/.test(lines[j])) break
      body += `\n${lines[j]}`
    }
    let rest = body
    let type = null
    if (body.startsWith('{')) {
      const end = matchBrace(body, 0)
      if (end !== -1) {
        type = body.slice(1, end)
        rest = body.slice(end + 1)
      }
    }
    out.push({ tag: m[1], type, rest: rest.replace(/\s+/g, ' ').trim() })
  }
  return out
}

/**
 - 取一条 @param 描述的参数名(去掉 [...] 方括号与 =默认值).
 - @param {string} rest @param 标签类型之后的剩余文本
 - @returns {string} 参数名(取不到时为空串)
 */
export function paramTagName(rest) {
  const first = (rest.split(/\s+/)[0] ?? '').replace(/^\[/, '').replace(/\]$/, '')
  // 保留点号路径: 解构参数的文档写法是 opts.retries, 去掉 .retries 就会
  // opts.name / opts 三条标签的 paramTagName 都返回 opts), 比对必然错乱.
  // 只剥方括号,默认值与剩余参数省略号, 不动点号.
  return first.split('=')[0].replace(/^\.\.\./, '').replace(/\?$/, '').trim()
}

/**
 - 参数名列表(解构参数取其文本).
 - @param {import('typescript').SourceFile} sf 源文件
 - @param {import('typescript').SignatureDeclaration} node 函数节点
 - @returns {string[]} 参数名或参数模式文本
 */
/**
 * 参数名列表.
 *
 * 解构参数取它的键名, 不取整段模式文本. 门禁
 * 返回 { retries = 0, name = '' } 这样一整段, 于是 @param 永远对不上 --
 * 因为文档里不可能写 @param {number} { retries = 0, name = '' }, 只会写
 * @param {number} opts.retries. 结果是"解构参数根本无法用 @param 覆盖",
 * 只能把签名改成普通参数 opts = {} 才能过门禁 -- 那是判据倒逼代码变形,
 *
 * 现在: 解构参数展开成它绑定的键名(retries / name), 与 @param opts.retries
 * 的末段比对得上; 其余(标识符/带默认值)照旧.
 * @param {import('typescript').SourceFile} sf 源文件
 * @param {import('typescript').SignatureDeclaration} node 函数节点
 * @returns {string[]} 参数名(解构参数已展开为键名)
 */
export function paramNamesOf(sf, node) {
  const out = []
  /** 展开一个 binding pattern 到它的叶子名字. */
  const collect = (name, into) => {
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) collect(el.name, into)
      }
      return
    }
    if (ts.isIdentifier(name)) into.push(name.getText(sf))
  }
  for (const p of node.parameters) collect(p.name, out)
  return out
}

/**
 - 是否导出的声明.
 - @param {import('typescript').Node} node 声明节点
 - @returns {boolean} 带 export 修饰符则为真
 */
export function isExported(node) {
  const mods = ts.getModifiers?.(node) ?? node.modifiers ?? []
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

/**
 - 函数体内是否存在带表达式的 return(用于判断"是否必须写 @returns").
 - @param {import('typescript').SignatureDeclaration} node 函数节点
 - @returns {boolean} 有值返回则为真
 */
export function hasValueReturn(node) {
  if (!node.body) return false
  let found = false
  const visit = (n) => {
    if (found) return
    if (ts.isReturnStatement(n) && n.expression) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node.body)
  return found
}

export { ts }
