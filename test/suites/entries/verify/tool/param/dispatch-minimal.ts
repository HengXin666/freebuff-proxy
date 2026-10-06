/**
 * 极简模式(dsh agentPreset=minimal)下的工具一次调用可用性.
 *
 * 与相邻的 dispatch-ready 的分工: 那一套验的是[dsh 原生 55 工具]形态;
 * 本套验的是[极简模式 27 工具]形态 ---- 两者声明的工具集不同, 还原结果也不同.
 *
 * 实测背景(2026-10-06, 本机 dsh 会话记录, session-2dbfca91):
 *   - 极简模式声明 27 个工具, 其中含一个同名工具 code_search
 *     (由 dsh-devin-search 注册, 参数是 search_term + search_folder_absolute_uri);
 *   - injectableOfficialTools(这 27 个) 只回两个官方工具:
 *     run_terminal_command 与 code_search;
 *   - 该会话里 code_search 被真实调用过两次:
 *       入参 {"pattern":"TODO","maxResults":3}
 *       -> Error: invalid arguments: missing required property "search_term";
 *          missing required property "search_folder_absolute_uri"
 *       入参 {"search_term":"TODO","search_folder_absolute_uri":"<会话 cwd>"}
 *       -> 成功返回真实搜索结果
 *   第一组入参正是官方 code_search 的形态 ---- 参数没翻译时下游收到的就是它.
 *
 * 判据(可证伪): 把 PARAM_RULES 里的 code_search 规则删掉, 第 2 组立刻变红.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { translateParamsForDownstream } from '../../../../../../src/upstream/signals/param-map.ts'
import { buildOfficialToClientMap } from '../../../../../../src/upstream/signals/tool-name-map.ts'
import { injectableOfficialTools } from '../../../../../../src/upstream/signals/tools/official-tool-select.ts'

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..', '..', '..')
const TOOLS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test/fixtures/dsh-minimal-tools.json'), 'utf8'),
)
const schemas: Record<string, any> = Object.fromEntries(
  TOOLS.map((t: any) => [t.name, t.parameters]),
)
const declared = new Set(Object.keys(schemas))
const back = buildOfficialToClientMap(declared)

/**
 * 模拟一次真实派发: 官方名 + 官方参数 -> 下游名 + 下游能否收下.
 *
 * @param {string} officialName 官方工具名
 * @param {string} args 官方形态参数 JSON 文本
 * @returns {{client: string|null, out: string|null, missing: string[]}} 还原结果与缺字段
 */
function dispatch(officialName: string, args: string) {
  const client = back[officialName] || null
  if (!client) return { client: null, out: null, missing: [] }
  const out = translateParamsForDownstream(client, args, schemas[client])
  const parsed = out ? JSON.parse(out) : {}
  const required: string[] = schemas[client]?.required || []
  const missing = required.filter((k) => parsed[k] === undefined)
  return { client, out, missing }
}

// ── 1 夹具必须真的含那个同名工具(判据的前提) ─────────────────────
{
  ok(schemas.code_search !== undefined, '极简模式夹具必须含同名 code_search')
  const req: string[] = schemas.code_search.required || []
  ok(
    req.includes('search_term') && req.includes('search_folder_absolute_uri'),
    '下游 code_search 的必填项必须是 search_term + search_folder_absolute_uri, got ' + req.join(','),
  )
  ok(schemas.grep === undefined, '极简模式没有 grep: 同名工具的存在改变了注入集')
}

// ── 2 官方 code_search 优先落到 bash(命令执行), 不是同名工具 ─────
// 判据: 命令在会话工作目录里跑, 所以[搜索根]是相对语义, 不需要按机器配绝对路径.
{
  ok(back.code_search === 'bash', '官方 code_search 应优先还原成 bash, got ' + back.code_search)
  const r = dispatch('code_search', '{"pattern":"TODO","maxResults":3}')
  ok(r.client === 'bash', 'code_search 必须落到下游声明过的 bash')
  ok(r.missing.length === 0, '翻译后下游 required 必须齐全, 缺: ' + r.missing.join(','))
  const args = JSON.parse(r.out as string)
  ok(typeof args.command === 'string' && args.command.includes('rg'), 'command 必须是 rg 命令')
  ok(args.command.includes("'TODO'"), "pattern 必须进命令文本, got " + args.command)
  ok(args.command.includes('-m 3'), 'maxResults 必须翻成 rg 的行数上限, got ' + args.command)
  ok(args.command.includes("'." + "'"), '未给 cwd 时搜索根必须是 .(会话工作目录)')
  // 官方字段一律不得作为独立字段泄给下游(下游 additionalProperties 是收紧的).
  ok(args.pattern === undefined, '官方字段 pattern 不得残留')
  ok(args.maxResults === undefined, 'maxResults 不得残留')
  ok(args.flags === undefined, 'flags 不得残留')
  ok(args.cwd === undefined, 'cwd 不得残留')
  // description 只在[下游 schema 真的要求]时才补: 极简形态的 bash 只必填 command,
  // 所以这里不该凭空多出一个字段(下游 additionalProperties 是收紧的).
  ok(args.description === undefined, '下游不要求 description 时不得多产出')
}

// ── 3 官方 flags 必须原样进命令(rg 方言), cwd 必须进搜索根 ─────────
{
  const r = dispatch('code_search', '{"pattern":"foo","cwd":"src","flags":"-i -g *.ts"}')
  const args = JSON.parse(r.out as string)
  ok(args.command.includes("'-i'"), 'flags 的 -i 必须原样透传')
  // 通配符必须被引号挡住, 否则 shell 会先展开成文件名列表.
  ok(args.command.includes("'*.ts'"), "通配符必须被引号包住, got " + args.command)
  ok(args.command.includes("'src'"), 'cwd 必须进搜索根')
  ok(!args.command.includes("-- '.'"), '给了 cwd 时不得再退回 .')
}

// ── 4 注入集必须随这 27 个声明收敛, 且每个名字都能落回下游 ─────────
// 这是本套最关键的一条: 官方 37 工具里只有两个能在这套客户端形态下派发.
{
  const inject = injectableOfficialTools(declared)
  ok(
    JSON.stringify(inject) === JSON.stringify(['run_terminal_command', 'code_search']),
    '极简形态的注入集必须是 run_terminal_command + code_search, got ' + JSON.stringify(inject),
  )
  // 两个官方工具都落到 bash: 一个是 bash 本身, 一个是 code_search 的命令形态.
  ok(back.run_terminal_command === 'bash', 'run_terminal_command 必须落到 bash')
  ok(back.code_search === 'bash', 'code_search 也必须落到 bash(命令执行)')
  for (const name of inject) {
    const client = back[name]
    ok(!!client, name + ' 必须能还原成下游名')
    ok(declared.has(client), name + ' 还原出的 ' + client + ' 必须在下游声明集里')
  }
  ok(!inject.includes('glob'), '没有下游对应物的官方工具不得被注入')
}

console.log('极简模式工具可用性验证通过(断言 ' + n + ' 条)')
