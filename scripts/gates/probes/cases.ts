/**
 * 负向探针用例表 ---- 每条探针证一个门禁真的会红.
 *
 * 断言口径与夹具规模要求见 .agents/notes/implemented/process/2026-10-05-probe-drift-after-gate-evolution.md
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, copyFingerprintInputs, fixture, lines, runGate } from '../lib/probe.ts'

void ROOT

export const probes = [
  {
    name: '后端文件超 300 行 → FAIL',
    gate: 'sizes',
    expect: 1,
    reason: '档位上限被调大后（300→3000），这条会跟着变绿',
    expectIn: ['301 行 > 上限 300'],
    run: () => {
      const dir = fixture({ 'src/big.ts': lines(301) })
      return { ...runGate('scripts/gates/checks/size/sizes.ts', dir), dir }
    },
  },
  {
    name: '控制组：后端文件 300 行整 → PASS',
    gate: 'sizes',
    expect: 0,
    reason: '防止"边界差一行"被误判，也防止门禁对任何输入都报红',
    run: () => {
      const dir = fixture({ 'src/ok.ts': lines(300) })
      return { ...runGate('scripts/gates/checks/size/sizes.ts', dir), dir }
    },
  },
  {
    name: '前端档位真的是 500（501 行 → FAIL 且文案说 500）',
    gate: 'sizes',
    expect: 1,
    reason: '前后端档位写反时，前端会用后端阈值静默判红',
    expectIn: ['501 行 > 上限 500'],
    run: () => {
      const dir = fixture({ 'dashboard/big.ts': lines(501) })
      return { ...runGate('scripts/gates/checks/size/sizes.ts', dir), dir }
    },
  },
  {
    name: '目录挂 6 个文件 → FAIL',
    gate: 'dirs',
    expect: 1,
    reason: '上限被调成 8 之后这条会变绿',
    expectIn: ['6 个文件 > 上限 5'],
    run: () => {
      const files = {}
      for (let i = 0; i < 6; i++) files[`src/a/f${i}.ts`] = 'export const x = 1\n'
      const dir = fixture(files)
      return { ...runGate('scripts/gates/checks/size/dirs.ts', dir), dir }
    },
  },
  {
    name: '控制组：目录挂 5 个文件 → PASS',
    gate: 'dirs',
    expect: 0,
    reason: '防止边界被误判',
    run: () => {
      const files = {}
      for (let i = 0; i < 5; i++) files[`src/a/f${i}.ts`] = 'export const x = 1\n'
      const dir = fixture(files)
      return { ...runGate('scripts/gates/checks/size/dirs.ts', dir), dir }
    },
  },
  {
    name: '函数超 80 行 → FAIL',
    gate: 'functions',
    expect: 1,
    reason: '函数上限被调大后这条会变绿',
    expectIn: ['> 上限 80'],
    run: () => {
      const body = Array.from({ length: 90 }, (_, i) => `  const v${i} = ${i}`).join('\n')
      const dir = fixture({ 'src/f.ts': `export function big() {\n${body}\n  return 1\n}\n` })
      return { ...runGate('scripts/gates/checks/code/functions.ts', dir), dir }
    },
  },
  {
    name: '控制组：刚好 80 行函数 → PASS',
    gate: 'functions',
    expect: 0,
    reason: '防边界误判：判据是"超过 80"而不是"达到 80"',
    run: () => {
      const body = Array.from({ length: 77 }, (_, i) => `  const v${i} = ${i}`).join('\n')
      const dir = fixture({ 'src/f.ts': `export function ok() {\n${body}\n  return 1\n}\n` })
      return { ...runGate('scripts/gates/checks/code/functions.ts', dir), dir }
    },
  },
  {
    name: '导出函数缺 JSDoc → FAIL',
    gate: 'notes',
    expect: 1,
    reason: '这是"注释规范"最核心的一条，缺了它整个 check-notes 形同虚设',
    expectIn: ['缺 JSDoc'],
    run: () => {
      const dir = fixture({ 'src/n.ts': 'export function bare(a) {\n  return a\n}\n' })
      return { ...runGate('scripts/gates/checks/code/notes.ts', dir), dir }
    },
  },
  {
    name: '@param 与真实签名不一致 → FAIL',
    gate: 'notes',
    expect: 1,
    reason: '错名字的注释比没有注释更危险',
    expectIn: ['@param'],
    run: () => {
      const src = '/**\n * 有注释但写错了参数名。\n * @param {string} wrong\n * @returns {string}\n */\nexport function f(real) {\n  return real\n}\n'
      const dir = fixture({ 'src/n.ts': src })
      return { ...runGate('scripts/gates/checks/code/notes.ts', dir), dir }
    },
  },
  {
    name: '控制组：完整 JSDoc → PASS',
    gate: 'notes',
    expect: 0,
    reason: '防止门禁对正确注释也报红（误报会让人整体关掉它）',
    run: () => {
      const src = '/**\n * 合规样例。\n * @param {string} real 参数\n * @returns {string} 原样返回\n */\nexport function f(real) {\n  return real\n}\n'
      const dir = fixture({ 'src/n.ts': src })
      return { ...runGate('scripts/gates/checks/code/notes.ts', dir), dir }
    },
  },
  {
    name: '行尾空白 / tab 缩进 / 缺末尾换行 → FAIL',
    gate: 'format',
    expect: 1,
    reason: '格式六条是"自动修"的前提',
    expectIn: ['行尾有空白字符'],
    run: () => {
      const dir = fixture({ 'src/f.ts': 'export const a = 1   \nexport const b = 2' })
      return { ...runGate('scripts/gates/checks/code/format.ts', dir), dir }
    },
  },
  {
    name: '控制组：规范格式 → PASS',
    gate: 'format',
    expect: 0,
    reason: '防误报',
    run: () => {
      const dir = fixture({ 'src/f.ts': 'export const a = 1\nexport const b = 2\n' })
      return { ...runGate('scripts/gates/checks/code/format.ts', dir), dir }
    },
  },
  {
    name: '棘轮：基线外的超长行 → FAIL',
    gate: 'format',
    expect: 1,
    reason: '没有棘轮就只剩"全仓清零"或"不装"两个选项',
    expectIn: ['新出现在基线外'],
    run: () => {
      const dir = fixture({ 'src/f.ts': `export const a = "${'x'.repeat(130)}"\n` })
      fs.mkdirSync(path.join(dir, '.gates'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.gates/format-long-lines.json'), JSON.stringify({ entries: {} }))
      return { ...runGate('scripts/gates/checks/code/format.ts', dir), dir }
    },
  },
  {
    name: '棘轮：把超长行数改小 → 提示重录（不静默通过）',
    gate: 'format',
    expect: 0,
    reason: '水位降了必须重录，否则基线留着虚高的数、下次能偷偷涨回去',
    expectIn: ['请跑 --update 重录'],
    run: () => {
      const dir = fixture({ 'src/f.ts': 'export const a = 1\n' })
      fs.mkdirSync(path.join(dir, '.gates'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.gates/format-long-lines.json'), JSON.stringify({ entries: { 'src/f.ts': 5 } }))
      return { ...runGate('scripts/gates/checks/code/format.ts', dir), dir }
    },
  },
  {
    name: '白名单语法：缺 |N 的条目 → 显式报错（不静默忽略）',
    gate: 'sizes',
    expect: 2,
    reason: '白名单写错被静默忽略 = 把"没豁免"伪装成"有豁免"',
    run: () => {
      const dir = fixture({ 'src/a.ts': 'export const a = 1\n' })
      fs.mkdirSync(path.join(dir, '.gates'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.gates/whitelist.txt'), 'src/a.js\n')
      return { ...runGate('scripts/gates/checks/size/sizes.ts', dir), dir }
    },
  },
  {
    name: '陈旧白名单条目 → FAIL（双向校验）',
    gate: 'sizes',
    expect: 1,
    reason: '只查单向的白名单一定会积累没人敢删的死条目',
    expectIn: ['陈旧豁免'],
    run: () => {
      const dir = fixture({ 'src/a.ts': 'export const a = 1\n' })
      fs.mkdirSync(path.join(dir, '.gates'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.gates/whitelist.txt'), 'src/gone.js|400\n')
      return { ...runGate('scripts/gates/checks/size/sizes.ts', dir), dir }
    },
  },
  {
    name: 'lane 覆盖：未被认领的顶层条目 → FAIL',
    gate: 'lanes',
    expect: 1,
    reason: '症状是"改了东西却一条门禁都不跑"，运行时完全看不出来',
    expectIn: [],
    run: () => {
      const dir = fixture({ 'unknown-dir/a.ts': 'export const a = 1\n' })
      return { ...runGate('scripts/gates/checks/guard/lanes.ts', dir), dir }
    },
  },
  {
    name: '接线：门禁被从总线摘掉 → 指纹必须 FAIL（wiring 探针）',
    gate: 'fingerprint',
    expect: 1,
    reason: '门禁被摘掉时输出仍可能全绿 —— 这是最危险的静默失效形态',
    expectIn: ['接线'],
    run: () => {
      const dir = fixture({}, { git: false })
      copyFingerprintInputs(dir, {
        tamperRun: (text) => text.replace(/\n  \{\n    group: 'lanes',[\s\S]*?\n  \},/, '\n'),
      })
      return { ...runGate('scripts/gates/meta/fingerprint.ts', dir), dir }
    },
  },
  {
    name: '接线：门禁脚本被摘掉（注册表还在，文件没了）→ 指纹 FAIL',
    gate: 'fingerprint',
    expect: 1,
    reason: '两处只改一处（删脚本不删注册）是最常见的手滑',
    run: () => {
      const dir = fixture({}, { git: false })
      // 把注册表里某条门禁指向一个不存在的脚本:args 变了 → 指纹必须发现.
      const tamper = (text) =>
        text.replace("'scripts/gates/checks/guard/lanes.ts'", "'scripts/gates/check-vanished.ts'")
      copyFingerprintInputs(dir, { tamperRun: tamper })
      return { ...runGate('scripts/gates/meta/fingerprint.ts', dir), dir }
    },
  },
  {
    name: '控制组：接线未变 → 指纹 PASS',
    gate: 'fingerprint',
    expect: 0,
    reason: '证明指纹只对"还跑不跑/有多严"敏感，不是对任何输入都报红',
    run: () => {
      const dir = fixture({}, { git: false })
      copyFingerprintInputs(dir)
      return { ...runGate('scripts/gates/meta/fingerprint.ts', dir), dir }
    },
  },
  {
    name: '语法不可解析 → FAIL（否则 tsc 早退会让类型棘轮假绿）',
    gate: 'syntax',
    expect: 1,
    reason: '语法坏掉时 check-types 的报错数会骤降，棘轮会把它录成"水位下降"',
    expectIn: ['语法不可解析'],
    run: () => {
      const files = { 'src/bad.ts': 'const a = {;\n' }
      for (let i = 0; i < 25; i++) files[`src/ok${i}.ts`] = 'export function ok() {\n  return 1\n}\n'
      const dir = fixture(files)
      return { ...runGate('scripts/gates/checks/code/syntax.ts', dir), dir }
    },
  },
  {
    name: '控制组：语法正确 → PASS',
    gate: 'syntax',
    expect: 0,
    reason: '防误报（门禁对任何输入都报红时，会被整条关掉）',
    run: () => {
      const files = {}
      for (let i = 0; i < 25; i++) files[`src/ok${i}.ts`] = 'export function ok() {\n  return 1\n}\n'
      const dir = fixture(files)
      return { ...runGate('scripts/gates/checks/code/syntax.ts', dir), dir }
    },
  },
]
