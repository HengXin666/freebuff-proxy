/**
 * check-egress ---- 上游出网必须经统一出口(裸 fetch 零容忍).
 *
 * 拦什么(都是"改了看不出来,但出口 IP 变了"的形态):
 *
 *   1. 生产源码里直接调 fetch / globalThis.fetch / undiciFetch:
 *      绕过代理解析 -> 上游拿到宿主真实出口 IP -> 账号被按地区判定,
 *      报 session_model_mismatch / limited(issue #5 的根因).
 *   2. 直接 new ProxyAgent / new EnvHttpProxyAgent:
 *      出口判据必须只有一处真源(src/upstream/client/egress/resolve.ts),
 *      别处再造一个 agent 就是"两个真相".
 *
 * 为什么用源码级扫描而不是运行时断言: 绕过若发生在很少走的分支上, 运行时断言
 * 要等那条分支被走到才报 --- 而那正是"线上才发现出口 IP 泄露"的场景.
 *
 * 判据只作用于真正的调用: 先剥注释, 再排除方法定义(async fetch(opts) 这种
 * 名字叫 fetch 的方法)与字符串里的路径.
 *
 * 扫描范围: src/ 与 cli-bridge/(生产的出网面). test/ 与 scripts/ 是夹具与
 * 工具链, 它们直连本地 mock 属于设计如此, 不入本门禁.
 *
 * 豁免(逐条登记, 多一条都要在这里说明理由):
 *   - src/upstream/client/egress/        出口实现自身(它就是那个唯一入口)
 *   - src/upstream/client/transport.ts   执行 dispatcher 的最后一跳
 *   - cli-bridge/lib/wire/egress.ts      bun 侧出口实现自身
 *   - src/web/routes/inventory/proxy.ts  出口连通性测试:它必须能 new 一个用户
 *                                        当场填的代理地址, 这本身就是被测对象
 *
 * 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.ts'
import { Report } from '../../lib/text/report.ts'
import { trackedFiles } from '../../lib/scan/files.ts'

const report = new Report('egress')

/** 出网实现自身与豁免文件:这些地方出现裸出网是设计如此. */
const ALLOWED = [
  'src/upstream/client/egress/',
  'src/upstream/client/transport.ts',
  'cli-bridge/lib/wire/egress.ts',
  'src/web/routes/inventory/proxy.ts',
]

/** 扫描面:生产出网只看这两处. */
const SCOPES = ['src/', 'cli-bridge/']

/** 出口真源:它必须存在,且真的做代理解析与 dispatcher 构造. */
const EGRESS_ENTRY = 'src/upstream/client/egress/index.ts'
const EGRESS_RESOLVE = 'src/upstream/client/egress/resolve.ts'

/**
 * 裸出网调用:一个叫 fetch 的标识符被调用.
 *
 * 三条排除(每条都对应本仓真实存在的写法):
 *   - 前面是 . : holder.fetch(...) / cat.fetch(...) 是对象方法, 不是全局 fetch;
 *   - 显式写了 globalThis.fetch( 或 undiciFetch( : 一律算裸出网(要拦的正是这个);
 *   - 本行是方法/函数定义(async fetch(opts) { ... }):名字叫 fetch 的方法.
 */
const BARE_FETCH = /(?<![\w.])fetch\s*\(/

/**
 * 显式写出来的全局 fetch:globalThis.fetch( / undiciFetch( .
 *
 * 必须单独判:上一条因 "前面是点号则排除"(为了放过 holder.fetch 这类对象方法)
 * 而漏掉 globalThis.fetch ---- 而它正是最常被写出来的绕过形态.
 * 本仓的例外是 _disposeRuntime 之后 close() 里那句代理资源释放, 不在扫描面上.
 */
const EXPLICIT_GLOBAL_FETCH = /(?:globalThis\.fetch|undiciFetch)\s*\(/

/** fetch 的方法/函数定义形态(名字叫 fetch 的定义, 不是调用). */
const FETCH_DECL = /(?:^|\s)(?:async\s+)?fetch\s*\([^)]*\)\s*[:{]/

/** 出口 agent 的直接构造. */
const BARE_AGENT = /new\s+(?:ProxyAgent|EnvHttpProxyAgent)\s*\(/

/**
 * 剥掉块注释与行注释, 保留行结构(便于报行号).
 * @param {string} text 源码
 * @returns {string[]} 逐行(已剥注释)
 */
function stripComments(text) {
  const out = []
  let inBlock = false
  for (const raw of text.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) { out.push(''); continue }
      line = line.slice(end + 2)
      inBlock = false
    }
    // 去掉本行内的块注释与行注释(不处理字符串里出现注释符的极端情形:
    // 那种写法在本仓不存在, 误报由豁免表兜住).
    line = line.replace(/\/\*[\s\S]*?\*\//g, ' ')
    const slash = line.indexOf('//')
    if (slash !== -1) line = line.slice(0, slash)
    const open = line.indexOf('/*')
    if (open !== -1) { line = line.slice(0, open); inBlock = true }
    out.push(line)
  }
  return out
}

const files = trackedFiles().filter(
  (f) => /\.ts$/.test(f) && SCOPES.some((s) => f.startsWith(s)),
)

/** 该路径是否允许出现裸出网. */
function allowed(rel) {
  return ALLOWED.some((p) => rel === p || rel.startsWith(p))
}

for (const rel of files) {
  if (allowed(rel)) continue
  const lines = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  lines.forEach((line, i) => {
    const isDecl = FETCH_DECL.test(line) && !/=>|await\s+fetch|=\s*fetch/.test(line)
    if ((BARE_FETCH.test(line) && !isDecl) || EXPLICIT_GLOBAL_FETCH.test(line)) {
      report.add(rel, i + 1, '裸 fetch 绕过统一出口（上游会拿到宿主真实出口 IP）', '改用 createEgress({ config }).fetch')
    }
    if (BARE_AGENT.test(line)) {
      report.add(rel, i + 1, '直接构造出网 agent（出口判据出现第二处真源）', '出口只由 src/upstream/client/egress/resolve.ts 解析')
    }
  })
}

// 真源必须存在且真的做代理解析(反向断言:删掉实现也让门禁红).
for (const rel of [EGRESS_ENTRY, EGRESS_RESOLVE]) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) {
    report.add(rel, 0, '统一出口真源缺失', '恢复该文件')
    continue
  }
  const src = fs.readFileSync(full, 'utf8')
  if (!/resolveProxy\s*\(/.test(src)) {
    report.add(rel, 0, '统一出口里没有代理解析（出口会退化成直连）', '恢复 resolveProxy 的调用')
  }
  if (!/ProxyAgent|EnvHttpProxyAgent/.test(src)) {
    report.add(rel, 0, '统一出口里没有任何代理 dispatcher 构造（配了代理也不会走）', '恢复 ProxyAgent / EnvHttpProxyAgent')
  }
}

report.note(`扫描 ${files.length} 个源文件(仅 src/ 与 cli-bridge/)；豁免 ${ALLOWED.length} 处`)
process.exit(report.finish())
