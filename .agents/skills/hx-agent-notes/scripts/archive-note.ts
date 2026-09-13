/**
 * Archive one implemented note: move it to archived/<class>/, stamp the seal line,
 * repair inbound links, and re-seal the frozen manifest.
 * Usage: npx tsx scripts/archive-note.ts <note-path> [--date YYYY-MM-DD] [--repo <dir>] [--dry-run]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { ARCHIVED_LINE_RE, describe, isNestedWorkTree, loadNotes, manifestPathFor, markdownLinks, matchesAny,
  parseArgv, readManifest, renderManifest, sha256File, walkNotes } from './notes-lib.ts'

const argv = process.argv.slice(2)
const parsed = parseArgv(argv, ['--date', '--repo'])
if (parsed.positionals.length === 0) {
  console.error('Usage: npx tsx scripts/archive-note.ts <path-to-note> [--date YYYY-MM-DD] [--repo <dir>] [--dry-run]')
  process.exit(2)
}
function flag(name: string): string | null {
  return parsed.values[name] ?? null
}
const dryRun = parsed.flags.has('--dry-run')
const repoArg = flag('--repo')
const cwd = repoArg !== null && repoArg !== '' ? resolve(repoArg) : process.cwd()
const loaded = loadNotes(cwd)
const target = resolve(cwd, parsed.positionals[0] as string)
if (!existsSync(target)) {
  console.error('Error: ' + target + ' does not exist')
  process.exit(1)
}
const rel = relative(loaded.notesRoot, target).split('\\').join('/')
const segs = rel.split('/')
if (segs[0] !== 'implemented' || segs.length !== 3) {
  console.error('Error: only implemented/<class>/<file>.md can be archived (got ' + rel + ')')
  process.exit(1)
}
const cls = segs[1] as string
const filename = segs[2] as string
if (!loaded.config.classes.includes(cls)) {
  console.error('Error: unknown class "' + cls + '" (allowed: ' + loaded.config.classes.join(', ') + ')')
  process.exit(1)
}

const date = flag('--date') ?? new Date().toISOString().slice(0, 10)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Error: --date must be YYYY-MM-DD')
  process.exit(2)
}

const raw = readFileSync(target, 'utf8')
const lines = raw.split('\n')
const statusIndex = lines.findIndex((line) => line === 'Status: implemented')
if (statusIndex === -1) {
  console.error('Error: only a note carrying `Status: implemented` can be archived')
  process.exit(1)
}
if (!lines.some((line) => ARCHIVED_LINE_RE.test(line.trim()))) {
  lines.splice(statusIndex + 1, 0, '', 'Archived: ' + date)
}
const updated = lines.join('\n')

const archivedDir = resolve(loaded.notesRoot, loaded.config.archive, cls)
const archivedPath = resolve(archivedDir, filename)
if (existsSync(archivedPath)) {
  console.error('Error: ' + archivedPath + ' already exists; resolve the name collision by hand')
  process.exit(1)
}

// Inbound references are collected before the move so the report names every site that must
// be repaired: other notes, the contract files, and the code backlinks.
const inbound: string[] = []
const { notes } = walkNotes(loaded)
for (const note of notes) {
  if (note.rel === rel) continue
  const text = readFileSync(resolve(loaded.notesRoot, note.rel), 'utf8')
  for (const link of markdownLinks(text)) {
    const withoutAnchor = link.target.split('#')[0] ?? ''
    if (withoutAnchor.endsWith('/' + filename) || withoutAnchor === filename) inbound.push(note.rel + ' -> ' + link.target)
  }
}

// Source citations: the files that cite this note must be retargeted too.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', 'vendor', '__pycache__', '.venv', 'venv', 'target'])
function* sourceFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // A nested work tree keeps its own notes; its citations are not ours to retarget.
      if (!SKIP_DIRS.has(entry.name) && !isNestedWorkTree(full, loaded.gitRoot)) yield* sourceFiles(full)
      continue
    }
    const rel = relative(loaded.repoRoot, full).split('\\').join('/')
    if (matchesAny(rel, loaded.config.backlinks.exclude)) continue
    if (entry.isFile() && loaded.config.backlinks.extensions.some((ext) => entry.name.endsWith(ext))) yield full
  }
}
for (const root of loaded.config.backlinks.roots) {
  for (const file of sourceFiles(resolve(loaded.repoRoot, root))) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes(filename)) continue
    const relFile = relative(loaded.repoRoot, file).split('\\').join('/')
    text.split('\n').forEach((line, index) => {
      if (line.includes(filename)) inbound.push(relFile + ':' + (index + 1) + ' -> ' + (line.trim().slice(0, 120)))
    })
  }
}

const { manifest, error } = readManifest(loaded)
if (error !== null) {
  console.error('Error: ' + error)
  process.exit(1)
}

console.log('archive: ' + rel)
console.log('     -> ' + loaded.config.archive + '/' + cls + '/' + filename)
console.log('     seal line: Archived: ' + date)
if (inbound.length === 0) {
  console.log('     inbound links: none')
} else {
  console.log('     inbound references to repair (retarget to the archived path only when the history is cited on purpose):')
  for (const hit of inbound) console.log('       - ' + hit)
}

if (dryRun) {
  console.log('archive: dry run, nothing written')
  process.exit(0)
}

mkdirSync(archivedDir, { recursive: true })
writeFileSync(target, updated, 'utf8')
renameSync(target, archivedPath)
const key = cls + '/' + filename
manifest.files[key] = sha256File(archivedPath)
mkdirSync(dirname(manifestPathFor(loaded)), { recursive: true })
writeFileSync(manifestPathFor(loaded), renderManifest(manifest.files))
console.log('archive: sealed ' + key + ' in ' + relative(loaded.repoRoot, manifestPathFor(loaded)).split('\\').join('/') + ' under ' + describe(loaded))