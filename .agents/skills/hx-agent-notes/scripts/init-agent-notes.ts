/**
 * Install the Agent Notes tree into a project: notes root, class folders, the
 * archived kind folders, an AGENTS.md contract, the config file, and package
 * scripts. Idempotent: existing files are never overwritten unless --force.
 * Usage: npx tsx scripts/init-agent-notes.ts [--repo <dir>] [--force] [--with-board]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, describe, loadNotes, parseArgv } from './notes-lib.ts'

const parsed = parseArgv(process.argv.slice(2), ['--repo'])
const force = parsed.flags.has('--force')
const repoArg = parsed.values['--repo']
const cwd = repoArg !== undefined && repoArg !== '' ? resolve(repoArg) : process.cwd()
const loaded = loadNotes(cwd)
const { config, notesRoot, repoRoot } = loaded
const written: string[] = []
const skipped: string[] = []
const DEFAULT_SCRIPTS_DIR = '.agents/skills/hx-agent-notes/scripts'

function ensure(rel: string, content: string, header: string): void {
  const full = join(repoRoot, rel)
  if (existsSync(full) && !force) { skipped.push(rel); return }
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
  written.push(header)
}

// 1. Config — only when the file is absent, since an existing config is the project's own.
const configRel = '.agents/notes.config.json'
if (!existsSync(join(repoRoot, configRel))) {
  ensure(configRel, JSON.stringify({
    root: config.root,
    archive: config.archive,
    lifecycles: config.lifecycles,
    classes: config.classes,
    formatAdopted: config.formatAdopted,
    coverage: config.coverage,
    backlinks: config.backlinks,
  }, null, 2) + '\n', 'config')
} else {
  skipped.push(configRel)
}

// 2. Class folders for every active lifecycle, plus the archive.
for (const lifecycle of config.lifecycles) {
  for (const cls of config.classes) {
    const full = join(notesRoot, lifecycle, cls)
    if (!existsSync(full)) { mkdirSync(full, { recursive: true }); written.push(describe(loaded) + '/' + lifecycle + '/' + cls + '/') }
  }
}
for (const cls of config.classes) {
  const full = join(notesRoot, config.archive, cls)
  if (!existsSync(full)) { mkdirSync(full, { recursive: true }); written.push(describe(loaded) + '/' + config.archive + '/' + cls + '/') }
}

const notesPrefix = describe(loaded)

// 3. The tree's own contract, read by every agent that opens the folder.
const agentsMd = [
  '# AGENTS.md — Agent Notes',
  '',
  'Agent Note 记录的是「为什么是这个形状, 以及为此放弃了什么」—— 代码和普通文档都放不下这两样.',
  'Agent 每次会话从零开始, 读到的只有当下的代码, 所以一个已权衡过的取舍在它眼里就是多余的复杂度,',
  '于是被"顺手简化"掉. Note 就是那道护栏.',
  '',
  '- **路径即身份**: `' + notesPrefix + '/{lifecycle}/{class}/yyyy-mm-dd-topic.md`.',
  '- `proposed/` 是还没建的决策; `implemented/` 是已上线、且与代码保持同步的; `rejected/` 是输掉的',
  '  提案, 只在还能拦住一个有人可能重犯的错误时保留.',
  '- 极少数确实不需要 note 的受保护改动, 把理由写进本目录的 `NOTE-EXEMPT.md`:',
  '  `' + config.coverage.label + ': <为什么这次不需要 note>`, 覆盖率门禁会用这个豁免代替 note.',
  '- **一篇 note 只管一条决策.** 只有事实移动(路径、名字、默认值)时就地更新那篇;',
  '  绝不把它改写成另一条决策 —— 要取代它, 并双向互链.',
  '- **每一篇 active note 都要带 `## Alternatives considered`.** 没写打败了什么的决策, 会被重新论证.',
  '- **不要 `INDEX.md`**: 目录树本身就是索引; 一个共享索引会把每次并行改动都变成冲突.',
  '- ' + config.archive + '/ 是冻结的. 已封存的 note 永不编辑、翻译、重排版或移动.',
  '',
  '**小标题用英文, 正文随你.** `## Problem` / `## Decision` 这类标题是被机器校验的词元; 正文写中文',
  '(或任何语言)完全不影响门禁. 但别在一篇里混用两种语言的小标题.',
  '',
  '动手改一个声明之前, 先读它旁边引用的那篇 note(任何 `.agents/notes/<lifecycle>/<class>/<file>.md` 路径).',
  '任何改动之后跑 `' + verifyCommand() + '`; 动了受保护的源码, 就必须在同一次改动里带上 note.',
  '',
].join('\n')
ensure(join(notesPrefix, 'AGENTS.md'), agentsMd, 'notes AGENTS.md')

const archivedAgents = [
  '# AGENTS.md — Archived Agent Notes',
  '',
  '这里的 note 是冻结的历史快照, **不是当前行为的权威**. 永不编辑、重排版、翻译、修补或删除任何一篇.',
  '每篇的状态行下面带一行 `Archived: YYYY-MM-DD`, 字节被封存在 `manifest.json` 里;',
  '任何漂移都会让门禁失败.',
  '',
  '归档一篇 note 用 `' + archiveCommand() + '`: 它会移动文件、盖上 seal 行、',
  '报告入站链接, 并更新 manifest.',
  '',
].join('\n')
ensure(join(notesPrefix, config.archive, 'AGENTS.md'), archivedAgents, 'archive AGENTS.md')

// 4. Implementation-note contract, mirroring the DSH rule that shipped facts stay current.
const implementedAgents = [
  '# AGENTS.md — Implemented Agent Notes',
  '',
  '已落地的 note 用**现在时**描述已上线的现实, 并且在任何移动路径、重命名符号、改动默认值的',
  '**同一次改动里**保持同步. 事实就地更新,**不要追加变更历史**.',
  '',
  '但这不是改写决策的许可证. 决策被推翻要写新 note 并互相引用;',
  '被完全取代的 note 通过 ' + archiveCommand() + ' 离开.',
  '',
].join('\n')
ensure(join(notesPrefix, 'implemented', 'AGENTS.md'), implementedAgents, 'implemented AGENTS.md')

// 4. The gates themselves. A repo that cannot reach the skill over a relative path — a sibling
// clone or a submodule — gets its own copy. A command in the contract that resolves to nothing is
// worse than a duplicate: it stays silent until someone finally trusts it.
function sourceScriptsDir(): string {
  try { return dirname(fileURLToPath(import.meta.url)) } catch { return '' }
}
function vendorScripts(): void {
  const explicit = process.env.AGENT_NOTES_SCRIPTS_DIR
  if (explicit !== undefined && explicit !== '') return
  const src = sourceScriptsDir()
  const dest = join(repoRoot, DEFAULT_SCRIPTS_DIR)
  if (src === '' || !existsSync(src)) { skipped.push('gate scripts (source not found)'); return }
  try { if (realpathSync(src) === realpathSync(dest)) { skipped.push('gate scripts (running in place)'); return } }
  catch { /* dest does not exist yet */ }
  if (existsSync(join(dest, 'verify-all.ts'))) { skipped.push('gate scripts'); return }
  mkdirSync(dest, { recursive: true })
  let copied = 0
  for (const entry of readdirSync(src)) {
    if (!entry.endsWith('.ts')) continue
    copyFileSync(join(src, entry), join(dest, entry))
    copied += 1
  }
  written.push('gate scripts (' + copied + ' files, vendored)')
}
vendorScripts()

// 5. Package scripts, so the gates are one command in the target project.
const pkgPath = join(repoRoot, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
  pkg.scripts = pkg.scripts ?? {}
  const run = runner()
  const scripts: Record<string, string> = {
    'verify-notes': run + ' ' + scriptsDir() + '/verify-all.ts',
    'verify-notes:staged': run + ' ' + scriptsDir() + '/verify-all.ts --staged',
    'verify-notes:tree': run + ' ' + scriptsDir() + '/verify-tree.ts',
    'verify-notes:format': run + ' ' + scriptsDir() + '/verify-format.ts',
    'verify-notes:coverage': run + ' ' + scriptsDir() + '/verify-coverage.ts',
    'verify-notes:backlinks': run + ' ' + scriptsDir() + '/verify-backlinks.ts',
    'notes:new': run + ' ' + scriptsDir() + '/new-note.ts',
    'notes:archive': run + ' ' + scriptsDir() + '/archive-note.ts',
    'notes:board': run + ' ' + scriptsDir() + '/build-board.ts --init board.html',
  }
  let changed = false
  for (const [name, command] of Object.entries(scripts)) {
    if (pkg.scripts[name] === undefined) { pkg.scripts[name] = command; changed = true }
  }
  if (changed) { writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8'); written.push('package.json scripts') }
  else skipped.push('package.json scripts')
} else {
  skipped.push('package.json (absent; wire the gates into whatever task runner the project uses)')
}

/**
 * The runner the target project can actually execute. tsx is not a dependency of a bare-npm
 * project, and npx may have no cache to fill, while Node >= 22.6 strips types natively.
 */
function runner(): string {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  const stripsTypes = typeof (process.features as { typescript?: string } | undefined)?.typescript === 'string'
  return nodeMajor >= 22 && stripsTypes ? 'node' : 'npx tsx'
}

/** The skill directory holding these scripts, as a path usable from the target repo. */
/**
 * The directory holding the entry points, as a path usable from the target repo. An explicit
 * `AGENT_NOTES_SCRIPTS_DIR` names the skill bundle or its `scripts/`; both are accepted, and a
 * value that resolves to neither falls back to the conventional location rather than emitting a
 * command that points at nothing.
 */
function scriptsDir(): string {
  const DEFAULT = DEFAULT_SCRIPTS_DIR
  const hasEntryPoints = (dir: string): boolean => existsSync(join(resolve(repoRoot, dir), 'verify-all.ts'))
  const candidate = (dir: string): string => {
    const rel = relative(repoRoot, resolve(repoRoot, dir)).split('\\').join('/')
    // Inside the repo prefer a relative path; a skill kept outside cannot be referred to relatively.
    return rel !== '' && !rel.startsWith('..') ? rel : dir
  }
  const explicit = process.env.AGENT_NOTES_SCRIPTS_DIR
  if (explicit === undefined || explicit === '') return DEFAULT
  if (hasEntryPoints(explicit)) return candidate(explicit)
  if (hasEntryPoints(join(explicit, 'scripts'))) return candidate(join(explicit, 'scripts'))
  return DEFAULT
}
function verifyCommand(): string { return runner() + ' ' + scriptsDir() + '/verify-all.ts' }
function archiveCommand(): string { return runner() + ' ' + scriptsDir() + '/archive-note.ts ' + notesPrefix + '/implemented/<class>/<file>.md' }

console.log('init-agent-notes: tree at ' + notesPrefix)
for (const item of written) console.log('  wrote   ' + item)
for (const item of skipped) console.log('  kept    ' + item)
console.log('next: ' + verifyCommand())