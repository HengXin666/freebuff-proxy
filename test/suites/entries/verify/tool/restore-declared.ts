/**
 * 回程工具还原的[本次声明]过滤 与 参数形态翻译验证.
 *
 * 从 tool-name-mapping.ts 拆出(原文件触及行数上限): 那张表只管"名字双向映射
 * 与官方工具集真值对账", 本文件管"回程还原的两条约束":
 *
 * 1. 只还原成下游这次请求真的声明过的名字 ----
 * 否则会造出下游不认识的别名(本地会话记录实测: unknown tool "ls").
 * 2. 名字还原后参数形态也要一起翻译 ----
 * 线上实测(远程 2.2.0, 带 tools 的真实请求):
 * {"name":"read","arguments":"{\"paths\":[\"src/index.ts\"]}"}
 * 下游 dsh 的 read 只认 file_path, 于是报
 * invalid arguments: missing required property "file_path".
 *
 * 判据(可证伪):破坏 foreign-client-signals 的声明集过滤或 param-map 的翻译表,
 * 本文件必须变红(两条反向探针都实测过).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CLIENT_TO_OFFICIAL_TOOL,
  unmapToolCallsInBody,
} from '../../../../../src/upstream/foreign-client-signals.ts'
import { mergeAndTranslateSseToolCalls } from '../../../../../src/proxy/transport/reply/sse-tool-merge.ts'

let n = 0
const ok = (cond, msg) => {
 assert.ok(cond, msg)
 n += 1
}

const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..', '..')

/** 真实抓包的官方工具集(与 tool-name-mapping 用同一份判据). */
const OFFICIAL_TOOLS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/reverse/captures/official-tools.json'), 'utf8'),
)

/**
 * 按 JSON Schema 片段造一个类型正确的样本值(仅用于构造合法调用).
 *
 * @param {any} prop schema 片段
 * @returns {any} 样本值
 */
function sampleValue(prop) {
  if (!prop || typeof prop !== 'object') return 'X'
  if (prop.type === 'array') return [sampleValue(prop.items)]
  if (prop.type === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(prop.properties || {})) out[k] = sampleValue(v)
    return out
  }
  if (prop.type === 'number' || prop.type === 'integer') return 1
  if (prop.type === 'boolean') return true
  return 'X'
}

const callByName = (name) => {
 return {
 choices: [{ message: { tool_calls: [{ function: { name: name, arguments: '{}' } }] } }],
 }
}

// ── ③c [本次声明]过滤:不得造出下游没声明过的别名 ────────────────
  // 实测症状(本地 dsh 会话记录):模型调官方 list_directory, 回程被改名成 ls,
  // 而下游没声明 ls -> 派发时报 unknown tool "ls".
  // 判据:声明集里没有的名字, 一律保持官方原名.
{
 const r = unmapToolCallsInBody(
 callByName('list_directory'),
 new Set(['read', 'bash']),
 )
 ok(
 r.choices[0].message.tool_calls[0].function.name === 'list_directory',
 '下游未声明 list_directory 时不得改成 ls(幽灵别名)',
 )
  }
{
 // 下游声明了 list_directory 本身 -> 保持原名
 const r = unmapToolCallsInBody(
 callByName('list_directory'),
 new Set(['list_directory']),
 )
 ok(
 r.choices[0].message.tool_calls[0].function.name === 'list_directory',
 '下游声明 list_directory 时不需要任何改名',
 )
  }
{
 // 同一官方名多个下游别名:必须还原成[本次声明的那个], 而不是表内第一个
 const asSh = unmapToolCallsInBody(callByName('run_terminal_command'), new Set(['sh']))
 ok(
 asSh.choices[0].message.tool_calls[0].function.name === 'sh',
 '下游声明 sh 时应还原为 sh, 而不是表内第一个 bash',
 )
 const asCat = unmapToolCallsInBody(callByName('read_files'), new Set(['cat']))
 ok(
 asCat.choices[0].message.tool_calls[0].function.name === 'cat',
 '下游声明 cat 时应还原为 cat, 而不是表内第一个 read',
 )
 const asRead = unmapToolCallsInBody(callByName('read_files'), new Set(['read']))
 ok(
 asRead.choices[0].message.tool_calls[0].function.name === 'read',
 '下游声明 read 时应还原为 read',
 )
  }
{
 // 不传声明集时退化为旧行为(全表反查), 保证既有调用点不受影响
 const legacy = unmapToolCallsInBody(callByName('run_terminal_command'))
 ok(
 legacy.choices[0].message.tool_calls[0].function.name === 'bash',
 '不传声明集时必须保持旧行为(全表还原)',
 )
  }

// ── ③d 参数形态必须跟着名字一起翻译 ─────────────────────────────
  // 线上实测(2026-07-05, 远程 2.2.0): 只改名字会得到
  // name=read, arguments={"paths":["src/index.ts"]}
  // 而下游 read 只认 file_path -> missing required property "file_path".
{
 const readSchema = {
 type: 'object',
 properties: { file_path: {}, offset: {}, limit: {} },
 required: ['file_path'],
 }
 const r = unmapToolCallsInBody(
 { choices: [{ message: { tool_calls: [{ function: { name: 'read_files', arguments: '{"paths":["a.ts"]}' } }] } }] },
 new Set(['read']),
 { read: readSchema },
 )
 const fn = r.choices[0].message.tool_calls[0].function
 ok(fn.name === 'read', '参数翻译场景下名字仍要还原为 read')
 ok(
 JSON.parse(fn.arguments).file_path === 'a.ts',
 '官方 read_files 的 paths 必须翻译成下游的 file_path',
 )
 ok(
 JSON.parse(fn.arguments).paths === undefined,
 '翻译后不得残留下游不认识的官方字段 paths',
 )
  }
{
 // edit: str_replace(path, replacements[]) -> file_path / old_string / new_string
 const r = unmapToolCallsInBody(
 {
 choices: [{
 message: {
 tool_calls: [{
 function: {
 name: 'str_replace',
 arguments: '{"path":"a.ts","replacements":[{"oldString":"x","newString":"y"}]}',
 },
 }],
 },
 }],
 },
 new Set(['edit']),
 )
 const args = JSON.parse(r.choices[0].message.tool_calls[0].function.arguments)
 ok(args.file_path === 'a.ts' && args.old_string === 'x' && args.new_string === 'y',
 'str_replace 必须摊平成下游 edit 的 file_path/old_string/new_string')
  }
{
 // 无翻译规则时必须原样保留参数(宁可字段陌生, 也不要被错误规则改坏)
 const r = unmapToolCallsInBody(
 callByName('run_terminal_command'),
 new Set(['sh']),
 )
 ok(
 r.choices[0].message.tool_calls[0].function.arguments === '{}',
 '无参数规则的组合必须原样保留 arguments',
 )
  }

// ── ③e 跨分片拼装的 SSE: 名字与参数都要还原 ──────────────────────
{
 const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":'
      + '{"name":"read_files","arguments":"{\\"paths\\":[\\""}}]}}]}',
 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a.ts\\"]}"}}]}}]}',
 'data: [DONE]',
 ].join('\n')
 const out = mergeAndTranslateSseToolCalls(
 sse,
 new Set(['read']),
 { read: { properties: { file_path: {} } } },
 )
 ok(out.includes('"name":"read"'), '跨分片场景名字必须还原为 read')
 ok(out.includes('file_path') && !out.includes('paths'),
 '跨分片场景参数必须翻译并去掉官方字段')
  }
{
 // 非 SSE / 无工具 / 坏 JSON 一律原样返回
 for (const bad of ['{"x":1}', '', 'data: [DONE]', 'data: {bad', 'data: {"choices":[]}']) {
 ok(mergeAndTranslateSseToolCalls(bad, new Set(['read'])) === bad, `非工具文本必须原样返回: ${bad.slice(0, 12)}`)
 }
  }

// ── ③f 逐工具契约: 每个会改名的工具, 名字与必填参数都要满足下游 schema ──
// 这是覆盖率口径的硬判据: 只要某个工具的合成参数缺了下游 required 里的字段,
// 下游就会以 missing required property 拒绝整条调用.
// 案例来源: bash 的下游 required 含 description, 而官方 run_terminal_command
// 没有该字段 ---- 必须有合成规则补上.
{
  const dsh = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'test/fixtures/dsh-tools.json'), 'utf8'),
  )
  const schemas = Object.fromEntries(dsh.map((t) => [t.name, t.parameters]))
  const declared = new Set(Object.keys(schemas))
  const official = new Map(
    OFFICIAL_TOOLS.map((t) => [t.function.name, t.function.parameters || {}]),
  )
  let checked = 0
  for (const [client, officialName] of Object.entries(CLIENT_TO_OFFICIAL_TOOL)) {
    if (client === officialName) continue
    const params = official.get(officialName)
    if (!params || !schemas[client]) continue
    // 按官方 schema 造一份类型正确的样本参数
    const args = {}
    for (const [k, v] of Object.entries(params.properties || {})) args[k] = sampleValue(v)
    const probe = {
      choices: [{ message: { tool_calls: [{ function: { name: officialName, arguments: JSON.stringify(args) } }] } }],
    }
    unmapToolCallsInBody(probe, declared, schemas)
    const fn = probe.choices[0].message.tool_calls[0].function
    ok(fn.name === client, `${client}: 回程名字必须还原为 ${client}, got ${fn.name}`)
    const parsed = JSON.parse(fn.arguments)
    for (const req of schemas[client]?.required || []) {
      ok(req in parsed, `${client}: 翻译后必须带上下游必填字段 ${req}, got ${fn.arguments}`)
    }
    checked += 1
  }
  ok(checked >= 6, `逐工具契约至少覆盖 6 个会改名的工具, got ${checked}`)
  // 同名工具(下游名 == 官方名)同样可能有形态差异, 必须一并覆盖:
  // 官方 web_search 传 query, 下游要 queries; 官方 glob 传 cwd, 下游要 path.
  for (const [name, args] of [
    ['web_search', '{"query":"hello"}'],
    ['glob', '{"pattern":"*.ts","cwd":"src"}'],
  ]) {
    const probe = {
      choices: [{ message: { tool_calls: [{ function: { name: name, arguments: args } }] } }],
    }
    unmapToolCallsInBody(probe, declared, schemas)
    const fn = probe.choices[0].message.tool_calls[0].function
    ok(fn.name === name, `同名工具 ${name} 不改名`)
    const parsed = JSON.parse(fn.arguments)
    for (const req of schemas[name]?.required || []) {
      ok(req in parsed, `同名工具 ${name} 必须带下游必填字段 ${req}, got ${fn.arguments}`)
    }
  }
}

// ── ③b 非对象/畸形输入不得抛 ──────────────────────────────────────
  for (const bad of [null, undefined, 'x', 42, {}, { choices: 'no' }, { choices: [{}] }]) {
 unmapToolCallsInBody(bad)
 unmapToolCallsInBody(bad, new Set(['read']))
 n += 2
  }


  console.log(`回程还原[本次声明]过滤与参数翻译验证通过(断言 ${n} 条)`)
