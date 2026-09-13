/**
 * Gate 3 — coverage: a change that touches guarded source must carry a note in the
 * same change. Escape hatch: any changed file under the notes root containing the
 * configured label (default `note-exempt:`) marks an intentional exemption.
 * Usage: npx tsx scripts/verify-coverage.ts [--base <ref>] [--head <ref>] [--staged] [--files a b] [--repo <dir>]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, loadNotes, matchesAny, parseArgv } from './notes-lib.ts'

const argv = process.argv.slice(2)
const parsed = parseArgv(argv, ['--repo', '--base', '--head', '--files'])
const filesIndex = argv.indexOf('--files')
const explicitFiles = filesIndex >= 0 ? argv.slice(filesIndex + 1).filter((item) => !item.startsWith('--')) : null
function flag(name: string): string | null {
  return parsed.values[name] ?? null
}
const repoArg = flag('--repo')
const cwd = repoArg !== null && repoArg !== '' ? resolve(repoArg) : process.cwd()
const loaded = loadNotes(cwd)
const { config, notesRoot } = loaded

/**
 * git reports paths relative to the work tree that owns `cwd`. A path outside it — which is what
 * an enclosing superproject's diff contains — is not this repository's change to grade, and a
 * leading `../` can never match a guarded glob anyway.
 */
function inScope(file: string): boolean {
  return !file.startsWith('../') && !file.startsWith('/')
}

if (process.env.AGENT_NOTES_COVERAGE === 'off') {
  console.log('verify-agent-notes:coverage: skipped (AGENT_NOTES_COVERAGE=off)')
  process.exit(0)
}
if (!config.coverage.enabled) {
  console.log('verify-agent-notes:coverage: disabled in config')
  process.exit(0)
}

function git(args: string[]): string[] {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function changedFiles(): { files: string[]; mode: string } {
  if (explicitFiles !== null) {
    return { files: explicitFiles, mode: 'explicit file list' }
  }
  if (parsed.flags.has('--staged')) {
    return { files: git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']), mode: 'staged index' }
  }
  const base = flag('--base') ?? process.env.AGENT_NOTES_BASE_REF ?? 'HEAD'
  const head = flag('--head')
  const diff = git(head !== null && head !== ''
    ? ['diff', '--name-only', '--diff-filter=ACMR', base, head]
    : ['diff', '--name-only', '--diff-filter=ACMR', base])
  const untracked = head !== null && head !== '' ? [] : git(['ls-files', '--others', '--exclude-standard'])
  return { files: [...diff, ...untracked], mode: 'diff against ' + base }
}

const raw = changedFiles()
const files = raw.files.filter(inScope)
const ignored = raw.files.length - files.length
const mode = raw.mode + (ignored > 0 ? ', ' + ignored + ' path(s) outside this work tree ignored' : '')
const guarded = files.filter((file) => matchesAny(file, config.coverage.guarded) && !matchesAny(file, config.coverage.exempt))
if (guarded.length === 0) {
  console.log('verify-agent-notes:coverage: no guarded source changed (' + mode + ', ' + files.length + ' path(s) inspected)')
  process.exit(0)
}

const notesPrefix = describe(loaded) + '/'
// Any note-tree change in the same change satisfies the rule: a new or updated note, a
// supersession that moved one into the archive, or an inbound-link repair beside it.
// The tree's own contract files carry no decision of their own and never satisfy it.
const noteChanged = files.some((file) => file.startsWith(notesPrefix)
  && file.endsWith('.md')
  && !config.translationSuffixes.some((suffix) => file.endsWith(suffix))
  && !['AGENTS.md', 'CLAUDE.md'].includes(file.slice(notesPrefix.length).split('/').pop() ?? ''))

const label = config.coverage.label
let exemptReason: string | null = null
for (const file of files) {
  if (!file.startsWith(notesPrefix)) continue
  const full = resolve(cwd, file)
  if (!existsSync(full)) continue
  for (const line of readFileSync(full, 'utf8').split('\n')) {
    const at = line.indexOf(label)
    if (at >= 0) { exemptReason = file + ': ' + line.trim().slice(0, 160); break }
  }
  if (exemptReason !== null) break
}

if (noteChanged) {
  console.log('verify-agent-notes:coverage: ok — ' + guarded.length + ' guarded path(s) changed with a note in the same change (' + mode + ')')
  process.exit(0)
}
if (exemptReason !== null) {
  console.log('verify-agent-notes:coverage: exempted — ' + exemptReason)
  process.exit(0)
}

console.error('verify-agent-notes:coverage: guarded source changed without a note (' + mode + ')')
console.error('  first guarded paths:')
for (const file of guarded.slice(0, 10)) console.error('    ' + file)
if (guarded.length > 10) console.error('    … and ' + (guarded.length - 10) + ' more')
console.error('  fix: add or update a note under ' + notesPrefix + '{implemented,proposed}/<class>/ in this same change,')
console.error('       or write ' + notesPrefix + 'NOTE-EXEMPT.md carrying `' + label + ': <why this change needs no note>`')
process.exit(1)