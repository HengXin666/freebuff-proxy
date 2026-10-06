/**
 - 工具名双向映射验证.
 *
 - 背景(2026-10-04 实测定性):上游官方工具集是固定 37 个,里面没有
 - bash/edit/read/write/skill 这些下游 harness 的常用名.
 - 实测把 55 个第三方工具原样追加后上游回 503;同会话同模型不带工具则是 200 ----
 - 唯一变量就是工具集.
 *
 - 所以必须有双向映射:
 - 下行(发请求):有官方等价物的 → 映射过去;没有的 → 原样保留(不丢)
 - 上行(回响应):官方名 → 客户端名
 *
 - [映射不到就丢弃]是错的(2026-10-05 单变量实测证伪):
 - 声明 8 个官方完全不存在的工具名(memory_save / git_status / subagent /
 - send_message / job_list / list_agents / git_diff / memory_search),
 - 出站 45 个工具,上游回 HTTP 200 ---- 上游并不因"名字官方没有"而拒绝.
 - 丢弃会让 dsh 的 44 个工具里 30 个(68%)静默消失.
 *
 - 判据(可证伪):
 - ① 两侧映射表(bun 侧 MAP_TOOLS / Node 侧 CLIENT_TO_OFFICIAL_TOOL)逐条一致
 - ② 每个映射目标都必须是真实存在的官方工具名
 - ③ 上行还原能把官方名变回客户端名;未映射的官方名原样保留
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CLIENT_TO_OFFICIAL_TOOL,
  unmapToolCallsInBody,
} from '../../../../../src/upstream/foreign-client-signals.ts'
import { mergeAndTranslateSseToolCalls } from '../../../../../src/proxy/transport/reply/sse-tool-merge.ts'

const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..', '..')

/**
 - 判据用真实抓包(docs/reverse/captures/official-tools.json),
 - 不是 src/upstream/foreign-client-signals.ts 里那份手写的
 - OFFICIAL_TOOL_PARAMETER_KEYS.
 *
 - 为什么:那份手写表与真实抓包只有约 12/37 重叠 ---- 它含 ask_user
 - 而真实是 ask_questions,含 28 个抓包里根本没有的名字(CLI 世代残留).
 - 实测把它当判据,映射目标会落在上游不认识的名字上(2026-10-04 就是
 - 这样把 ask_user_question 映射成 ask_user → 上游 503).
 - 真实抓包才是 desktop 世代的服务端真值.
 */
const OFFICIAL_TOOL_NAMES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/reverse/captures/official-tools.json'), 'utf8'),
).map((t) => t?.function?.name).filter(Boolean)
let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n += 1
}

// ── ① 两侧映射表一致 ──────────────────────────────────────────────
// MAP_TOOLS / UNMAP_TOOLS 的实现位于
// cli-bridge/lib/tool-map.ts ----
// 判据必须指向真正持有那张表的那一层, 指向别处读到的文件里没有它, 正则不匹配.
const bunSrc = fs.readFileSync(path.join(ROOT, 'cli-bridge/lib/tool-map.ts'), 'utf8')
const m = bunSrc.match(/const MAP_TOOLS = Object\.freeze\(\{([\s\S]*?)\}\)/m)
ok(m, 'bun 侧必须有 MAP_TOOLS 表')
const bunMap = {}
for (const line of m[1].split('\n')) {
  const mm = line.match(/^\s*([A-Za-z_][\w]*):\s*'([^']+)',/)
  if (mm) bunMap[mm[1]] = mm[2]
}
ok(Object.keys(bunMap).length > 20, `bun 侧映射表应有 >20 条，got ${Object.keys(bunMap).length}`)

const nodeMap = { ...CLIENT_TO_OFFICIAL_TOOL }
const bunKeys = Object.keys(bunMap).sort()
const nodeKeys = Object.keys(nodeMap).sort()
ok(
  JSON.stringify(bunKeys) === JSON.stringify(nodeKeys),
  `两侧映射表的键必须一致：bun=${bunKeys.length} node=${nodeKeys.length}`,
)
for (const k of bunKeys) {
  ok(
    bunMap[k] === nodeMap[k],
    `映射目标必须一致：${k} bun->${bunMap[k]} node->${nodeMap[k]}`,
  )
}

// ── ② 映射目标必须真实存在 ────────────────────────────────────────
const official = new Set(OFFICIAL_TOOL_NAMES)
for (const [client, target] of Object.entries(nodeMap)) {
  ok(
    official.has(target),
    `映射目标必须是真实官方工具名：${client} -> ${target} 不在官方清单里`,
  )
}

// ── ③ 上行还原 ────────────────────────────────────────────────────
const body = {
  choices: [
    {
      message: {
        tool_calls: [
          { function: { name: 'run_terminal_command', arguments: '{}' } },
          { function: { name: 'write_file', arguments: '{}' } },
          { function: { name: 'preview_click', arguments: '{}' } }, // 官方原生名，下游没声明
        ],
      },
    },
  ],
}
unmapToolCallsInBody(body)
const names = body.choices[0].message.tool_calls.map((c) => c.function.name)
ok(names[0] === 'bash', `run_terminal_command 应还原为 bash，got ${names[0]}`)
ok(names[1] === 'write', `write_file 应还原为 write，got ${names[1]}`)
ok(
  names[2] === 'preview_click',
  `未映射的官方原生名必须原样保留（不猜不丢），got ${names[2]}`,
)
// 幂等性:还原过的再还原不应再变
unmapToolCallsInBody(body)
ok(body.choices[0].message.tool_calls[0].function.name === 'bash', '还原必须幂等')

// ── ④ 关键回归:官方里确实没有这些下游名 ──────────────────────────
//  skill 不在此列 ---- 它在官方清单里(40 个),是官方工具,
// 不属于"需要映射的下游名".此处只列真正缺失的那些.
for (const name of ['bash', 'edit', 'read', 'write']) {
  ok(
    !official.has(name),
    `官方工具集里不应有 ${name}（这正是需要映射的原因）`,
  )
}
// 但官方有它们的等价物
for (const name of [
  'run_terminal_command',
  'str_replace',
  'read_files',
  'write_file',
]) {
  ok(official.has(name), `官方工具集里必须有等价物 ${name}`)
}


// ── ⑥ 映射不到的客户端工具必须原样保留(不得丢弃)────────────────
//
// 丢弃策略会使 dsh 的 44 个工具里 30 个(68%)静默消失 ---- 用户以为声明了能调,
// 模型永远看不到.8 个官方不存在的工具名(memory_save / git_status / subagent /
// send_message / job_list / list_agents / git_diff / memory_search)出站后
// 上游回 HTTP 200, 支持原样保留.
//
// 判据用源码级检查(cli-bridge 是 bun 的 CLI 入口, 不是可导入模块,
// 用正则抽函数再 _compile 会在抽取处炸).检查的是
// if (!mapped) 分支里不得出现 continue 丢弃,且必须 list.push.
{
  const src = fs.readFileSync(path.join(ROOT, 'cli-bridge/lib/tool-map.ts'), 'utf8')
  const fn = src.match(/function mergeOfficialTools\([\s\S]*?\n\}/m)
  assert.ok(fn, '必须能定位 mergeOfficialTools 源码')
  const body = fn[0]
  const branch = body.match(/if \(!mapped\) \{([\s\S]*?)\n    \}/)
  assert.ok(branch, '必须存在 `if (!mapped)` 分支')
  const inner = branch[1]
  assert.ok(
    inner.includes('list.push'),
    '映射不到的客户端工具必须 list.push 原样保留（不得丢弃）',
  )
  assert.ok(
    !/dropped\s*\[/.test(inner),
    '该分支不得再把工具记入 dropped（"丢弃"策略已被实测证伪）',
  )
  // 对照:有等价物时仍须改名(list.push 里带 mapped)
  assert.ok(
    /function: \{ \.\.\.t\.function, name: mapped \}/.test(body),
    '有官方等价物时必须改名为 mapped',
  )
  // 且整段不得再有 dropped 出参(已清理)
  assert.ok(!/dropped/.test(src), 'cli-bridge 里不应再残留丢弃逻辑（dropped）')
}

// ── ⑦ mergeOfficialTools 必须可执行(不得再出现未声明变量)────────
//
// 回归:882de20 重写 if (!mapped) 分支时把
// const mapped = MAP_TOOLS[n] || null; 整行删掉了 ---- 分支代码却还在用
// mapped.node --check 只做语法检查,抓不到 ReferenceError,
// 于是这个错误一路进了远程镜像, mergeOfficialTools 在第一轮循环就抛
//   ReferenceError: mapped is not defined
//
// 上面的 ⑥ 只是源码正则检查(能过),所以它漏掉了这个错误.这里补一条
// 真执行断言:把 MAP_TOOLS + mergeOfficialTools 抽出来跑,任何未声明变量
// 都会立刻抛 ReferenceError.
{
  const src = fs.readFileSync(path.join(ROOT, 'cli-bridge/lib/tool-map.ts'), 'utf8')
  const mapStart = src.indexOf('const MAP_TOOLS = Object.freeze({')
  const mapEnd = src.indexOf('})', mapStart) + 2
  const fnStart = src.indexOf('function mergeOfficialTools')
  const fnEnd = src.indexOf('\n}\n', fnStart) + 3
  assert.ok(mapStart > 0 && mapEnd > mapStart, '必须能定位 MAP_TOOLS')
  assert.ok(fnStart > 0 && fnEnd > fnStart, '必须能定位 mergeOfficialTools')

  let merge
  assert.doesNotThrow(() => {
    merge = new Function(
      `${src.slice(mapStart, mapEnd)}\n${src.slice(fnStart, fnEnd)}\nreturn mergeOfficialTools;`,
    )()
  }, 'mergeOfficialTools 必须可构造（与 MAP_TOOLS 同作用域）')

  // 有官方等价物:改名
  const renamed = merge([], [{ function: { name: 'bash' } }])
  assert.deepEqual(
    renamed.map((t) => t.function.name),
    ['run_terminal_command'],
    'bash 必须映射为官方名 run_terminal_command',
  )
  // 无官方等价物:原样保留(这是 882de20 的意图,也是它引入 bug 的那条分支)
  const kept = merge([], [{ function: { name: 'memory_save' } }])
  assert.deepEqual(
    kept.map((t) => t.function.name),
    ['memory_save'],
    '官方没有等价物时必须原样保留',
  )
  // 官方已有同名:不重复追加
  const dedup = merge(
    [{ function: { name: 'run_terminal_command' } }],
    [{ function: { name: 'bash' } }],
  )
  assert.equal(dedup.length, 1, '官方优先，重复不追加')
  // 空工具集:不进入循环(提前 return 会掩盖该分支)
  assert.equal(merge([{ function: { name: 'x' } }], []).length, 1, '空客户端工具直接返回官方集')
  console.log('mergeOfficialTools 真执行验证通过（4 条）')
}

console.log(`工具名双向映射验证通过（断言 ${n} 条）`)
