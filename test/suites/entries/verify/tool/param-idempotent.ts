/**
 * 参数翻译的幂等性与多 harness 等价名 ---- 从 restore-declared.ts 拆出.
 *
 * 拆出原因: 原文件补完这三组判据后 375 行, 撞了 300 行硬红线. 主题上这也是
 * 独立一类 ---- 那边管[回程还原的两条约束(声明集过滤 + 形态翻译)], 这里管
 * [翻译规则自身的性质]: 幂等, 不吞下游已有字段, 跨 harness 的等价名.
 *
 * 三组判据各自的实测来源见块内注释; 破坏任一实现都会让本文件变红(实测过).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CLIENT_TO_OFFICIAL_TOOL,
  unmapToolCallsInBody,
} from '../../../../../src/upstream/foreign-client-signals.ts'

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n += 1
}

const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..', '..')

/** dsh 真实声明的工具 schema 与名字集合(与 restore-declared 用同一份 fixture). */
const DSH_TOOLS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test/fixtures/dsh-tools.json'), 'utf8'),
)
const schemas = Object.fromEntries(DSH_TOOLS.map((t) => [t.name, t.parameters]))
const declared = new Set(Object.keys(schemas))

// ── ③g 翻译必须幂等 + 必须先按下游形态取字段(2026-10-06 修)──────
// 实测缺陷: write_file 的规则只认官方字段 path, 于是上游偶发直接回下游形态
// {"file_path":...} 时, file_path 落在 src 里没人接 -> 下游 required 缺字段.
// 判据: 同一份[已经是下游形态]的参数再翻一次, 必填字段必须原样还在.
{
  const writeSchema = schemas.write
  ok(!!writeSchema, 'dsh 声明里必须有 write(本判据的前提)')
  const asDownstream = '{"file_path":"a.txt","content":"hi"}'
  const r = unmapToolCallsInBody(
    { choices: [{ message: { tool_calls: [{ function: { name: 'write_file', arguments: asDownstream } }] } }] },
    declared,
    schemas,
  )
  const fn = r.choices[0].message.tool_calls[0].function
  const parsed = JSON.parse(fn.arguments)
  ok(parsed.file_path === 'a.txt', `已是下游形态时 file_path 不得被吞, got ${fn.arguments}`)
  ok(parsed.content === 'hi', `已是下游形态时 content 不得被吞, got ${fn.arguments}`)
  // 官方形态(paylaod 里是 path)仍要正确翻译, 两条路径都要成立.
  const r2 = unmapToolCallsInBody(
    {
      choices: [{
        message: {
          tool_calls: [{
            function: { name: 'write_file', arguments: '{"path":"b.txt","content":"yo"}' },
          }],
        },
      }],
    },
    declared,
    schemas,
  )
  const p2 = JSON.parse(r2.choices[0].message.tool_calls[0].function.arguments)
  ok(p2.file_path === 'b.txt' && p2.path === undefined, '官方形态必须翻成 file_path 且不残留 path')
}

// ── ③h todo_write: 官方 write_todos 的 todos[{task,completed}] ──────
// 旧实现没有这条规则, 官方形态原样回给下游 -> dsh 报
// missing required property "todos[0].content"(2026-10-05 会话实测两次).
{
  const r = unmapToolCallsInBody(
    {
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: 'write_todos',
              arguments: '{"todos":[{"task":"a","completed":true},{"task":"b","completed":false}]}',
            },
          }],
        },
      }],
    },
    declared,
    schemas,
  )
  const args = JSON.parse(r.choices[0].message.tool_calls[0].function.arguments)
  ok(Array.isArray(args.todos), 'todos 必须仍是数组')
  ok(args.todos[0].content === 'a', `todos[0].task 必须翻成下游的 content, got ${JSON.stringify(args.todos[0])}`)
  ok(args.todos[0].status === 'completed', 'completed=true 必须翻成 status=completed')
  ok(args.todos[1].status === 'pending', 'completed=false 必须翻成 status=pending')
  ok(args.todos[0].task === undefined, '不得残留下游不认识的 task 字段')
  // 幂等: 已是下游形态时原样保留(含 in_progress 这种三态值).
  const r2 = unmapToolCallsInBody(
    {
      choices: [{
        message: {
          tool_calls: [{
            function: { name: 'write_todos', arguments: '{"todos":[{"content":"a","status":"in_progress"}]}' },
          }],
        },
      }],
    },
    declared,
    schemas,
  )
  const a2 = JSON.parse(r2.choices[0].message.tool_calls[0].function.arguments)
  ok(a2.todos[0].status === 'in_progress', '已是下游形态时必须原样保留 status(不得覆盖成 pending)')
}

// ── ③i 其它 harness 的等价名(Claude Code / Codex / Cursor)────────
// 本代理要同时服务多个下游; 这些名字上游按[外来客户端]识别, 必须映射到官方等价物.
// 真值形态取自 src/upstream/foreign-client-signals.ts 的外来名清单.
{
  const perHarness = [
    ['claude-code', new Set([
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'TodoWrite', 'WebFetch', 'WebSearch', 'LS',
    ])],
    ['codex', new Set(['shell', 'apply_patch', 'exec_command'])],
    ['cursor', new Set(['StrReplace', 'Shell'])],
    ['opencode', new Set(['todowrite', 'webfetch'])],
  ]
  const expected = {
    Bash: 'run_terminal_command', Read: 'read_files', Write: 'write_file', Edit: 'str_replace',
    Glob: 'glob', Grep: 'code_search', TodoWrite: 'write_todos', WebFetch: 'read_url',
    WebSearch: 'web_search', LS: 'list_directory',
    shell: 'run_terminal_command', apply_patch: 'str_replace', exec_command: 'run_terminal_command',
    StrReplace: 'str_replace', Shell: 'run_terminal_command',
    todowrite: 'write_todos', webfetch: 'read_url',
  }
  for (const [harness, names] of perHarness) {
    for (const client of names) {
      const officialName = CLIENT_TO_OFFICIAL_TOOL[client]
      ok(officialName === expected[client], `${harness}: ${client} 必须映射到 ${expected[client]}, got ${officialName}`)
      // 回程必须还原回该 harness 自己声明的那个名字.
      const r = unmapToolCallsInBody(
        { choices: [{ message: { tool_calls: [{ function: { name: officialName, arguments: '{}' } }] } }] },
        new Set([client]),
      )
      ok(
        r.choices[0].message.tool_calls[0].function.name === client,
        `${harness}: ${officialName} 必须还原成 ${client}`,
      )
    }
  }
}

console.log(`参数翻译幂等性与多 harness 等价名验证通过(断言 ${n} 条)`)
