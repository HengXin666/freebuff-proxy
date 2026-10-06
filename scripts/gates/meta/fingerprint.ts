/**
 - check-fingerprint ---- 门禁自己的门禁(防静默放松 / 防静默摘线).
 *
 - 拦什么:两类变化,恰好对应两句话:
 - - 有多严:阈值,白名单条目,棘轮水位,被关掉的规则.改这些等于放松红线;
 - - 还跑不跑:总线注册表里有哪些门禁,参数,依赖产物.改这些等于把门禁摘掉.
 *
 *
 - 真源:.gates/fingerprint.json(仓库内提交的指纹).重录唯一入口是
 - node scripts/gates/check-fingerprint.mjs --update,语义是"承认这次变化",
 - 不是"让门禁通过".
 *
 - 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { LIMITS, ROOT, TIERS } from '../rules.ts'
import { Report } from '../lib/text/report.ts'

const FILE = path.join(ROOT, '.gates/fingerprint.json')
const report = new Report('check-fingerprint')

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 读一个文件,缺失返回空串(缺失本身也是一种状态,要进指纹). */
function readOrEmpty(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return '<missing>'
  }
}

/** 抽取总线注册表里"决定执行"的字段(改 label 文案不在此列). */
function wiring() {
  const src = readOrEmpty('scripts/gates/run.ts')
  const out = []
  for (const m of src.matchAll(/group:\s*'([^']+)'[\s\S]*?args:\s*(\[[^\]]*\])/g)) {
    out.push(`${m[1]}|${m[2].replace(/\s+/g, '')}`)
  }
  const checkpoints = src.match(/CHECKPOINTS\s*=\s*\{[\s\S]*?\n\}/)?.[0] ?? '<missing>'
  return { gates: out, checkpoints: checkpoints.replace(/\s+/g, ' ') }
}

/** 抽取棘轮水位与白名单条目("有多严"). */
function strictness() {
  const ratchets = {}
  for (const f of fs.readdirSync(path.join(ROOT, '.gates')).sort()) {
    if (!f.endsWith('.json')) continue
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, '.gates', f), 'utf8'))
    ratchets[f] = parsed.entries ?? {}
  }
  const wl = readOrEmpty('.gates/whitelist.txt')
  return {
    ratchets,
    limit: LIMITS,
    tiers: TIERS,
    whitelistEntries: wl
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  }
}

// 快照不含 hooks: .git/hooks 不入库, 本地装了而 CI 没有, 同一份代码会算出
// 本地环境状态不属于它. hook 是否跑门禁, 由 CI 直接跑 check:gates 来守.
// 见 .agents/notes/implemented/process/2026-10-05-fingerprint-excludes-local-hook-state.md
const snapshot = { version: 1, algorithm: 'sha256', ...strictness(), wiring: wiring() }
snapshot.fingerprint = createHash('sha256').update(stable(snapshot)).digest('hex')

if (process.argv.includes('--update')) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, `${JSON.stringify(snapshot, null, 2)}\n`)
  report.note(`已重录指纹: ${FILE}`)
  report.note(`fingerprint=${snapshot.fingerprint.slice(0, 16)}…`)
  process.exit(report.finish())
}

if (!fs.existsSync(FILE)) {
  report.add('.gates/fingerprint.json', 0, '指纹文件不存在（门禁的接线与严格度无人看守）', '跑 --update 建立基线，并把它提交进仓库')
  process.exit(report.finish())
}

const prev = JSON.parse(fs.readFileSync(FILE, 'utf8'))
if (prev.version !== snapshot.version) {
  report.add(
    '.gates/fingerprint.json',
    0,
    `SCHEMA_VERSION 不一致（文件 ${prev.version} / 代码 ${snapshot.version}）`,
    '旧指纹不许当有效；确认后用 --update 重录',
  )
  process.exit(report.finish())
}

/** 逐字段比对,把差异说成"哪一类变化". */
function diff(label, a, b) {
  const sa = stable(a)
  const sb = stable(b)
  if (sa !== sb) report.add('.gates/fingerprint.json', 0, `${label} 发生变化`, '若是有意为之，跑 --update 重录并在提交信息里说明；否则撤回改动')
}

const strictNow = {
  limit: snapshot.limit,
  tiers: snapshot.tiers,
  whitelistEntries: snapshot.whitelistEntries,
}
const strictPrev = {
  limit: prev.limit,
  tiers: prev.tiers,
  whitelistEntries: prev.whitelistEntries,
}
diff('阈值/白名单/棘轮（有多严）', strictPrev, strictNow)
diff('棘轮水位', prev.ratchets, snapshot.ratchets)
diff('总线注册表（还跑不跑）', prev.wiring, snapshot.wiring)

report.note(`接线指纹: ${prev.fingerprint?.slice(0, 16)}… → ${snapshot.fingerprint.slice(0, 16)}…`)
report.note(
  `门禁 ${snapshot.wiring.gates.length} 条，棘轮 ${Object.keys(snapshot.ratchets).length} 份，` +
    `白名单条目 ${snapshot.whitelistEntries.length} 条`,
)
void execFileSync

process.exit(report.finish())
