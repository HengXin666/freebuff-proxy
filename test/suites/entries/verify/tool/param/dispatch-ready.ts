/**
 * 官方工具 -> 下游 dsh 的[一次调用可用性]对账.
 *
 * 与相邻两套的分工:
 *   - tool-name-mapping / restore-declared: 名字能不能还原;
 *   - param-idempotent: 翻译规则自身的性质(幂等 / 不吞字段).
 *   - 本套件: 一个官方工具被模型选中后, 下游能不能[一次就成功派发] ----
 *     包含名字还原, 参数翻译, 以及[下游 schema 是否真的收得下]这三段串联.
 *
 * 为什么必须串联而不是各测各的: 名字对了但参数形态不对, 对使用者是同一个
 * 失败(unknown tool 与 invalid arguments 在体感上没有区别). 本文档把这两段
 * 拼成一次真实调用, 结果只有[过]与[不过].
 *
 * 判据来自 2026-10-06 实测(参数翻译缺陷普查), 三处硬缺陷已修:
 *   ask_questions 缺规则 / bash timeout_seconds=-1 / process_type 被丢弃.
 * 破坏任一修复都会让本文件变红(逐条可证伪).
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
const DSH_TOOLS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test/fixtures/dsh-tools.json'), 'utf8'),
)
const schemas: Record<string, any> = Object.fromEntries(
  DSH_TOOLS.map((t: any) => [t.name, t.parameters]),
)
const declared = new Set(Object.keys(schemas))
const back = buildOfficialToClientMap(declared)

/**
 * 模拟一次真实派发: 官方名 + 官方参数 -> 下游名 + 下游能否收下.
 *
 * 判据用[下游自己声明的 required], 不引入 dsh 内部校验器 ----
 * 测试不该依赖宿主包的私有导出(升级即碎).
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

// ── ① 自动规则的输出必须全部可派发 ─────────────────────────────
// 2.5.1 起注入名单由[下游本次声明]推出, 所以 55 工具形态下注入的每个名字
// 都必须在下游声明集里, 否则回程还原不出下游认识的名字.
{
  const inject = injectableOfficialTools(declared)
  ok(inject.length > 0, 'dsh 55 工具形态下必须至少注入一个官方工具')
  for (const name of inject) {
    const client = back[name]
    ok(!!client, `${name} 必须能还原成下游名(否则必报 unknown tool)`)
    ok(declared.has(client), `${name} 还原出的 ${client} 必须在下游声明集里`)
  }
}

// ── ② 每个注入项的参数翻译后, 下游 required 必须齐全 ──────────
// 官方形态样本按官方 schema 构造; 参数翻译缺席的项(只换名字不换形态)
// 会在这里暴露成 missing.
{
  const samples: Record<string, string> = {
    read_files: '{"paths":["src/a.ts"]}',
    str_replace: '{"path":"a.ts","replacements":[{"oldString":"x","newString":"y"}]}',
    write_file: '{"path":"a.ts","instructions":"i","content":"c"}',
    run_terminal_command: '{"command":"ls"}',
    code_search: '{"pattern":"foo"}',
    glob: '{"pattern":"**/*.ts"}',
    write_todos: '{"todos":[{"task":"a","completed":true}]}',
    web_search: '{"query":"q"}',
    read_url: '{"url":"https://x.com"}',
    ask_questions: '{"questions":[{"question":"?","header":"H","multiSelect":false}]}',
    suggest_prompts: '{"prompts":[{"prompt":"next step","label":"Next"}]}',
  }
  for (const name of injectableOfficialTools(declared)) {
    const sample = samples[name]
    ok(!!sample, `${name} 必须在本文件的官方参数样本表里(新增注入项要补样本)`)
    const r = dispatch(name, sample)
    ok(r.missing.length === 0, `${name} 翻译后下游 required 缺字段: ${r.missing.join(',')} (got ${r.out})`)
  }
}

// ── ③ ask_questions: 官方没有 id, 下游必填 id ─────────────────
// 2026-10-06 实测缺陷: 规则表缺这条 -> 官方参数原样下发 ->
// missing required property "arguments.questions[0].id" (dsh 侧必失败).
{
  const askArgs = '{"questions":[{"question":"Continue?","header":"Confirm",'
    + '"options":[{"label":"Yes"}],"multiSelect":true}]}'
  const r = dispatch('ask_questions', askArgs)
  ok(r.client === 'ask_user_question', 'ask_questions 必须还原成下游名 ask_user_question')
  const args = JSON.parse(r.out as string)
  ok(typeof args.questions[0].id === 'string' && args.questions[0].id, 'id 必须被合成(官方 schema 里没有这个字段)')
  ok(args.questions[0].multi_select === true, 'multiSelect 必须翻成下游的 multi_select')
  ok(args.questions[0].multiSelect === undefined, '不得残留官方驼峰字段')
  // 多问题: id 必须互不相同(下游 validateQuestionIds 会因重复 id 抛错).
  const many = dispatch('ask_questions', '{"questions":[{"question":"a"},{"question":"b"}]}')
  const qs = JSON.parse(many.out as string).questions
  ok(qs.length === 2 && qs[0].id !== qs[1].id, '多问题的合成 id 必须互不相同')
  // 幂等: 已带 id 的输入不得被重新编号.
  const keep = dispatch('ask_questions', '{"questions":[{"id":"keep","question":"q"}]}')
  ok(JSON.parse(keep.out as string).questions[0].id === 'keep', '已是下游形态时 id 必须原样保留')
}

// ── ④ bash timeout_seconds: -1 是官方合法值, 下游只收正数 ──────
// 2026-10-06 实测缺陷: 直接乘 1000 得 -1000 -> 下游抛 invalid timeoutMs.
{
  for (const [raw, expectMs] of [['-1', undefined], ['0', undefined], ['1', 1000], ['30', 30000]]) {
    const r = dispatch('run_terminal_command', `{"command":"x","timeout_seconds":${raw}}`)
    const parsed = JSON.parse(r.out as string)
    ok(parsed.timeoutMs === expectMs, `timeout_seconds=${raw} 必须翻成 ${expectMs}, got ${parsed.timeoutMs}`)
    ok(parsed.command === 'x', 'command 不得在换算里丢失')
    ok(typeof parsed.description === 'string' && parsed.description, 'description 必须由 command 合成(下游必填)')
  }
}

// ── ⑤ bash process_type: BACKGROUND 必须落到 run_in_background ─
// 2026-10-06 实测缺陷: 该字段被整条丢弃 -> 模型以为丢到后台, 实际前台跑.
{
  const bg = dispatch('run_terminal_command', '{"command":"x","process_type":"BACKGROUND"}')
  ok(JSON.parse(bg.out as string).run_in_background === true, 'BACKGROUND 必须翻成 run_in_background=true')
  const sync = dispatch('run_terminal_command', '{"command":"x","process_type":"SYNC"}')
  ok(JSON.parse(sync.out as string).run_in_background === undefined, 'SYNC 不得产出 run_in_background')
}

// ── ⑥ 其余已支持工具的形状翻译(防回退)────────────────────────
{
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['read_files', '{"paths":[{"path":"a.ts","offset":3,"limit":9}]}', { file_path: 'a.ts', offset: 3, limit: 9 }],
    ['str_replace', '{"path":"a.ts","replacements":'
      + '[{"oldString":"x","newString":"y","allowMultiple":true}]}',
      { file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true }],
    ['write_file', '{"path":"a.ts","instructions":"i","content":"c"}', { file_path: 'a.ts', content: 'c' }],
    ['code_search', '{"pattern":"foo","cwd":"src"}', { pattern: 'foo', path: 'src' }],
    ['glob', '{"pattern":"**/*.ts","cwd":"src"}', { pattern: '**/*.ts', path: 'src' }],
    ['read_url', '{"url":"https://x.com","max_chars":100}', { url: 'https://x.com' }],
    ['web_search', '{"query":"q"}', { queries: ['q'] }],
    ['write_todos', '{"todos":[{"task":"a","completed":true}]}', { todos: [{ content: 'a', status: 'completed' }] }],
  ]
  for (const [official, args, expect] of cases) {
    const r = dispatch(official, args)
    const parsed = JSON.parse(r.out as string)
    for (const [k, v] of Object.entries(expect)) {
      const got = JSON.stringify(parsed[k])
      const want = JSON.stringify(v)
      ok(got === want, `${official}: ${k} 期望 ${want}, got ${got}`)
    }
  }
  // 官方有而下游没有的字段一律不得泄漏(下游 additionalProperties 多为 false).
  const leak = dispatch('read_url', '{"url":"https://x.com","max_chars":100}')
  ok(JSON.parse(leak.out as string).max_chars === undefined, 'max_chars 不得泄漏给下游')
}

// ── ⑦ suggest_prompts: 官方提示词点名要调, 落到下游问答工具 ─────────
// 官方 worker system 模板明文要求[几乎每轮都调用它], 而它在下游没有同名工具.
// 2026-10-06 裁决: 映射到 ask_user_question 的选项卡片(官方载荷本就是一组
// {prompt,label} 可点击项, 与 questions[].options[] 同构).
{
  const r = dispatch('suggest_prompts', '{"prompts":[{"prompt":"继续读那个文件","label":"继续读"},{"prompt":"把清单导出来"}]}')
  ok(r.client === 'ask_user_question', `suggest_prompts 必须落到 ask_user_question, got ${r.client}`)
  const qs = JSON.parse(r.out as string).questions
  ok(Array.isArray(qs) && qs.length === 1, 'N 个建议应合成[一题多选], 不是 N 个问题')
  ok(qs[0].id === 'q1', '合成的问题必须带下游要求的 id')
  ok(qs[0].options.length === 2, `两个建议必须变成两个选项, got ${qs[0].options.length}`)
  ok(qs[0].options[0].label === '继续读', 'label 存在时直接用 label')
  ok(qs[0].options[0].description === '继续读那个文件', 'prompt 原文进 description(点选后仍能看到完整意图)')
  // label 官方可选而下游必填: 缺失时必须用 prompt 兜底, 否则下游 required 失败.
  const noLabel = dispatch('suggest_prompts', '{"prompts":[{"prompt":"没有 label 的建议"}]}')
  ok(
    JSON.parse(noLabel.out as string).questions[0].options[0].label === '没有 label 的建议',
    'label 缺失时必须用 prompt 兜底',
  )
  // 未声明该下游工具时不得造出别名.
  const backBare = buildOfficialToClientMap(new Set(['read', 'bash']))
  ok(backBare.suggest_prompts === undefined, '下游没声明 ask_user_question 时不得把 suggest_prompts 翻过去')
}

console.log(`官方工具一次调用可用性验证通过(断言 ${n} 条)`)
