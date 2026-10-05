/**
 - 门禁总线 ---- 唯一注册表 + 唯一入口,被 pre-commit / pre-push / CI / 手动命令共用.
 *
 - 为什么要有总线:同一组判据若在 hook 里写一遍,CI 里再写一遍,两份命令迟早
 - 不一致,而"本地过了 CI 挂了"这种不一致比没有门禁更耗人.这里只注册一次.
 *
 - 五条防"跑错"的机制(门禁最危险的失败形态是"它看起来跑了"):
 - 1. 合法参数是闭集,其余 exit 2 ---- 否则新写的 flag 会被静默当成组名,
 - "我明明传了开关"变成"跑的是别的东西";
 - 2. preflight:门禁脚本不存在 → 立刻报错,不是当成通过;
 - 3. fail-fast:第一条红就停,并打印可复现的命令;
 - 4. --dry-run:只打印会跑哪些门禁与真实参数,不执行(写文档/排查时要用);
 - 5. 每条打印耗时,全绿打印 ALL PASS.
 *
 - 用法:
 - node scripts/gates/run.mjs                 # 跑全部
 - node scripts/gates/run.mjs backend         # 只跑某组
 - node scripts/gates/run.mjs --dry-run       # 看会跑什么
 - node scripts/gates/run.mjs --list          # 列出组名
 *
 - 决策记录:.agents/notes/implemented/process/2026-10-05-code-quality-redlines.md
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from './rules.mjs'

/** 全部门禁.group 是检查点账单的单位,由命令行开关选. */
export const GATES = [
  {
    group: 'syntax',
    label: '所有受控 JS/MJS 可被 node --check 解析（tsc 的早退会让类型棘轮假绿）',
    args: ['scripts/gates/checks/code/syntax.mjs'],
  },
  {
    group: 'sizes',
    label: '单文件行数不超过档位上限（后端 300 / 前端 500）',
    args: ['scripts/gates/checks/size/sizes.mjs'],
  },
  {
    group: 'dirs',
    label: '同一目录的受控文件数不超过 5',
    args: ['scripts/gates/checks/size/dirs.mjs'],
  },
  {
    group: 'functions',
    label: '单个函数不超过 80 行',
    args: ['scripts/gates/checks/code/functions.mjs'],
  },
  {
    group: 'notes',
    label: '导出符号必须有 JSDoc 且 @param/@returns 与签名一致',
    args: ['scripts/gates/checks/code/notes.mjs'],
  },
  {
    group: 'style',
    label: '注释与文档的文本规范（中文标点棘轮 + 表情零容忍）',
    args: ['scripts/gates/checks/style/style.mjs'],
  },
  {
    group: 'md-in-comment',
    label: '注释里禁止 markdown 语法 + JSDoc 定界符完整 + 加粗标记成对',
    args: ['scripts/gates/checks/style/md-in-comment.mjs'],
  },
  {
    group: 'format',
    label: '格式六条（缩进/行尾/末尾换行/BOM/CRLF/行宽棘轮）',
    args: ['scripts/gates/checks/code/format.mjs'],
  },
  {
    group: 'route-table',
    label: 'HTTP 面分流表存在、边界正确、且装配层真的在用它',
    args: ['scripts/gates/checks/guard/route-table.mjs'],
  },
  {
    group: 'declared',
    label: '未声明标识符零新增（TS2304：能编译但运行必抛 ReferenceError）',
    args: ['scripts/gates/checks/guard/declared.mjs'],
  },
  {
    group: 'types',
    label: 'checkJs 类型错误只许降不许涨',
    args: ['scripts/gates/checks/code/types.mjs'],
  },
  {
    group: 'lanes',
    label: '每个顶层条目都被某条 lane 或豁免名单认领',
    args: ['scripts/gates/checks/guard/lanes.mjs'],
  },
  {
    group: 'fingerprint',
    label: '门禁自己的门禁：阈值/白名单/棘轮水位/总线接线未被静默放松',
    args: ['scripts/gates/meta/fingerprint.mjs'],
  },
  {
    group: 'response-contract',
    label: '上游响应字段/判据码的裸读只许降不许涨 + 快照与真源双向对账',
    args: ['scripts/gates/checks/guard/response-contract.mjs'],
  },
  {
    group: 'contract',
    label: '上游契约快照与真源对账（端点/头名不漂移）',
    args: ['scripts/check-upstream-contract.mjs'],
  },
  {
    group: 'docs',
    label: '文档真源与端点对账（文档提到的端点必须在代码里真实注册）',
    args: ['scripts/gates/checks/doc/check-docs.mjs'],
  },
  {
    group: 'i18n',
    label: '多语言三条红线（硬编码 CJK / key 对齐 / t() 必须存在）',
    args: ['scripts/check-i18n.mjs'],
  },
]

/** 组名 → 检查点跑哪些组. */
export const CHECKPOINTS = {
  'pre-commit': [
    'syntax',
    'sizes',
    'dirs',
    'functions',
    'format',
    'style',
    'md-in-comment',
    'notes',
    'route-table',
    'declared',
    'lanes',
    'fingerprint',
  ],
  'pre-push': [
    'syntax',
    'sizes',
    'dirs',
    'functions',
    'notes',
    'format',
    'route-table',
    'declared',
    'types',
    'lanes',
    'fingerprint',
    'contract',
    'response-contract',
    'docs',
    'i18n',
  ],
  ci: 'all',
}

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('-'))
const names = argv.filter((a) => !a.startsWith('-'))

for (const f of flags) {
  if (!['--dry-run', '--list', '--fast'].includes(f)) {
    console.error(`usage: 未知参数 ${f}（合法: --dry-run / --list / --fast + 组名）`)
    process.exit(2)
  }
}

if (flags.includes('--list')) {
  for (const g of GATES) console.log(`${g.group.padEnd(10)} ${g.label}`)
  process.exit(0)
}

const selected = resolveSelection(names)
const dry = flags.includes('--dry-run')
const started = Date.now()
let failed = 0

console.log(`门禁总线：${selected.length}/${GATES.length} 条${dry ? '（dry-run）' : ''}`)

for (let i = 0; i < selected.length; i++) {
  const gate = selected[i]
  const script = path.join(ROOT, gate.args[0])
  if (!fs.existsSync(script)) {
    console.error(`FAIL ${i + 1} ${gate.group}: 门禁脚本不存在 ${gate.args[0]}（不许当成通过）`)
    process.exit(1)
  }
  const cmd = `cd ${ROOT} && node ${gate.args.join(' ')}`
  if (dry) {
    console.log(`  [${i + 1}] ${gate.group.padEnd(10)} ${cmd}`)
    continue
  }
  const t0 = Date.now()
  const res = spawnSync(process.execPath, gate.args, { cwd: ROOT, stdio: 'inherit' })
  const ms = Date.now() - t0
  if (res.status !== 0) {
    failed = res.status ?? 1
    console.error(`FAIL ${i + 1} ${gate.group} (exit ${failed}, ${(ms / 1000).toFixed(1)}s)`)
    console.error(`  复现: ${cmd}`)
    break
  }
  console.log(`ok  ${i + 1} ${gate.group.padEnd(10)} ${(ms / 1000).toFixed(1)}s`)
}

if (dry) process.exit(0)
if (failed !== 0) process.exit(failed)
console.log(`ALL PASS (${((Date.now() - started) / 1000).toFixed(1)}s)`)

/** 把命令行组名 / 检查点名解析成要跑的门禁列表. */
function resolveSelection(input) {
  if (input.length === 0) return GATES
  const wanted = new Set()
  for (const name of input) {
    if (CHECKPOINTS[name]) {
      const list = CHECKPOINTS[name] === 'all' ? GATES.map((g) => g.group) : CHECKPOINTS[name]
      for (const g of list) wanted.add(g)
      continue
    }
    if (!GATES.some((g) => g.group === name)) {
      const groups = GATES.map((g) => g.group).join(' / ')
      const marks = Object.keys(CHECKPOINTS).join(' / ')
      console.error(`usage: 未知组名 ${name}（合法: ${groups} / ${marks}）`)
      process.exit(2)
    }
    wanted.add(name)
  }
  return GATES.filter((g) => wanted.has(g.group))
}
