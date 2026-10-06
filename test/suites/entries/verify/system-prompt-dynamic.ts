/**
 * 官方 system 模板的动态段渲染.
 *
 * 判据: 模板里被抓包[冻住]的值必须在运行时重新生成, 且形态与官方一致 ----
 * 抓包快照里 Current date 是抓包那天, repository_stats 是当时的统计数字,
 * 直接发等于每次都向上游声明一个过期事实, 而形态不符本身就是第三方客户端信号.
 *
 * 可证伪: 把 renderWorkerSystem 里任一处替换去掉, 本套件立刻变红.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// test/suites/entries/verify/ -> 仓库根: 往上 4 级(verify/model 才是 5 级).
const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..')
const { renderWorkerSystem, applyPlaceholders, PLACEHOLDER_NAMES } = await import(
  path.join(ROOT, 'cli-bridge/lib/system.ts')
)

const tpl = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/reverse/captures/official-system-prompts.json'), 'utf8'),
).worker

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

// ── 1 日期必须按运行时重算 ────────────────────────────────────────
{
  const out = renderWorkerSystem(tpl, { date: 'January 2, 2030' })
  ok(out.includes('Current date: January 2, 2030.'), '注入的日期必须原样出现在模板里')
  ok(!out.includes('October 3, 2026'), '抓包那天的日期不得残留')
  // 不注入时用今天 ---- 判据是[不是抓包那天]
  const auto = renderWorkerSystem(tpl)
  ok(!auto.includes('October 3, 2026'), '默认也必须重算, 不能回落到抓包值')
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
  ok(auto.includes(`Current date: ${today}.`), `默认日期应是今天, got: ${today}`)
}

// ── 2 repository_stats 的形态必须是 [换行分隔的 key: value 行] ────
// 官方逐行拼, 不是 JSON. 我们曾发 JSON.stringify 的结果 ---- 形态完全不同.
{
  const out = renderWorkerSystem(tpl)
  const i = out.indexOf('<repository_stats>')
  const j = out.indexOf('</repository_stats>')
  ok(i >= 0 && j > i, '必须是成对的 repository_stats 标签')
  const body = out.slice(i + '<repository_stats>'.length, j).trim()
  ok(!body.startsWith('{'), '内容不得是 JSON 对象')
  ok(/^repository_visibility: /m.test(body), '必须是 key: value 行')
  ok(!out.includes('indexed_project_files: 69'), '不得残留抓包时的统计数字')
  ok(!out.includes('detected_test_files: 5'), '不得残留抓包时的测试文件数')
}

// ── 3 changed_file_paths: 那行标注与块内容都要动态 ────────────────
{
  const none = renderWorkerSystem(tpl)
  ok(none.includes('Changed file paths (unavailable):'), '无 git 时标注必须是 unavailable')
  ok(
    none.includes('(Git metadata unavailable to this host)'),
    '无 git 时块内必须是官方的固定文案(不能是空块)',
  )
  // 空块是官方从不发的形态
  ok(!/<changed_file_paths>\s*<\/changed_file_paths>/.test(none), '不得发空块')

  const some = renderWorkerSystem(tpl, { changedFilePaths: ['src/a.ts', 'src/b.ts'] })
  ok(some.includes('Changed file paths (2):'), '有文件时标注要带数量')
  ok(some.includes('src/a.ts') && some.includes('src/b.ts'), '文件列表要进块内')
  ok(!some.includes('(Git metadata unavailable'), '有文件时不得再出现 unavailable 文案')
}

// ── 4 模板的固定部分不得被改动 ────────────────────────────────────
{
  const out = renderWorkerSystem(tpl)
  // 官方文案段落必须逐字保留(它本身是客户端形态的一部分)
  ok(
    out.includes('You are Buffy, the coding agent behind Codebuff.'),
    '首句必须原样保留',
  )
  ok(out.includes('# Freebuff Desktop'), '后续段落必须原样保留')
  ok(out.includes('Merge'), '模板尾部内容不得丢失')
}

// ── 5 占位符: 语法与官方一致({CODEBUFF_*}), 取不到的替换成空串 ──────
{
  ok(PLACEHOLDER_NAMES.length === 13, `官方占位符应有 13 个, got ${PLACEHOLDER_NAMES.length}`)
  ok(PLACEHOLDER_NAMES.includes('CURRENT_DATE'), '名单必须含 CURRENT_DATE')
  ok(PLACEHOLDER_NAMES.includes('USER_INPUT_PROMPT'), '名单必须含 USER_INPUT_PROMPT')

  const out = applyPlaceholders(
    'D={CODEBUFF_CURRENT_DATE} N={CODEBUFF_AGENT_NAME} U={CODEBUFF_USER_INPUT_PROMPT}',
    { date: 'January 2, 2030', userInput: 'hello' },
  )
  ok(out.includes('D=January 2, 2030'), 'CURRENT_DATE 要替换成注入值, got ' + out)
  ok(out.includes('N=Buffy'), 'AGENT_NAME 默认应是 Buffy')
  ok(out.includes('U=hello'), 'USER_INPUT_PROMPT 要替换成本次用户消息')

  // 取不到的占位符: 替换成空串(与官方一致), 而不是留着原样发出去
  const empty = applyPlaceholders('[{CODEBUFF_PROJECT_ROOT}]', {})
  ok(empty === '[]', `取不到的占位符必须替换成空串, got ${JSON.stringify(empty)}`)
  ok(!empty.includes('undefined'), '取不到时不得替换成字符串 undefined')

  // 自定义正文里的占位符也要生效(这是本次改动的核心目的)
  const custom = applyPlaceholders('Root={CODEBUFF_PROJECT_ROOT}; Date={CODEBUFF_CURRENT_DATE}', {
    date: 'January 2, 2030',
  })
  ok(custom.startsWith('Root=; Date=January 2, 2030'), '自定义正文同样要替换, got ' + custom)
}

console.log(`官方 system 动态段渲染验证通过(断言 ${n} 条)`)
