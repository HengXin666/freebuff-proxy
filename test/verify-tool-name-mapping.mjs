/**
 * 工具名双向映射验证。
 *
 * 背景（2026-10-04 实测定性）：上游官方工具集是**固定 37 个**，里面没有
 * `bash`/`edit`/`read`/`write`/`skill` 这些下游 harness 的常用名。
 * 实测把 55 个第三方工具**原样追加**后上游回 503；同会话同模型不带工具则是 200 ——
 * 唯一变量就是工具集。
 *
 * 所以必须有双向映射：
 *   下行（发请求）：客户端名 → 官方等价名；映射不到的**丢弃**
 *   上行（回响应）：官方名 → 客户端名
 *
 * 判据（可证伪）：
 *   ① 两侧映射表（bun 侧 MAP_TOOLS / Node 侧 CLIENT_TO_OFFICIAL_TOOL）**逐条一致**
 *   ② 每个映射目标都必须是**真实存在的官方工具名**
 *   ③ 上行还原能把官方名变回客户端名；未映射的官方名原样保留
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CLIENT_TO_OFFICIAL_TOOL,
  unmapToolCallsInBody,
} from '../src/upstream/foreign-client-signals.js'

const ROOT = path.join(import.meta.dirname, '..')

/**
 * ⚠️ 判据用**真实抓包**（`docs/reverse/captures/official-tools.json`），
 * **不是** `src/upstream/foreign-client-signals.js` 里那份手写的
 * `OFFICIAL_TOOL_PARAMETER_KEYS`。
 *
 * 为什么：那份手写表与真实抓包**只有约 12/37 重叠** —— 它含 `ask_user`
 * 而真实是 `ask_questions`，含 28 个抓包里根本没有的名字（CLI 世代残留）。
 * 实测把它当判据，映射目标会落在上游不认识的名字上（2026-10-04 就是
 * 这样把 `ask_user_question` 映射成 `ask_user` → 上游 503）。
 * 真实抓包才是 desktop 世代的服务端真值。
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
const bunSrc = fs.readFileSync(path.join(ROOT, 'cli-bridge/upstream.mjs'), 'utf8')
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
// 幂等性：还原过的再还原不应再变
unmapToolCallsInBody(body)
ok(body.choices[0].message.tool_calls[0].function.name === 'bash', '还原必须幂等')

// ── ③b 非对象/畸形输入不得抛 ──────────────────────────────────────
for (const bad of [null, undefined, 'x', 42, {}, { choices: 'no' }, { choices: [{}] }]) {
  unmapToolCallsInBody(bad)
  n += 1
}

// ── ④ 关键回归：官方里确实没有这些下游名 ──────────────────────────
// ⚠️ `skill` **不在**此列 —— 实测它在官方清单里（40 个），是官方工具，
// 不属于"需要映射的下游名"。此处只列真正缺失的那些（测试自己抓到过这个错误）。
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

console.log(`工具名双向映射验证通过（断言 ${n} 条）`)
