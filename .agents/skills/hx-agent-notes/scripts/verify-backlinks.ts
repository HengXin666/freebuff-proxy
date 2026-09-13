/**
 * Gate 4 — anchors: source that cites a note path must cite one that still resolves, and (when
 * required) every shipped note must be cited somewhere. Whole-repo sweep, cheap on every change.
 *
 * A "backlink" is any source reference to a note path — repo-relative
 * (.agents/notes/implemented/<class>/<file>.md) or lifecycle-relative
 * (implemented/<class>/<file>.md). There is no magic marker token: a token like the one this gate
 * used to require also appears in ordinary prose, so a convention that fires on English sentences
 * reports phantom violations instead of gaps.
 *
 * Usage: npx tsx scripts/verify-backlinks.ts [--repo <dir>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, isNestedWorkTree, loadNotes, matchesAny, parseArgv, walkNotes } from './notes-lib.ts'

const parsed = parseArgv(process.argv.slice(2), ['--repo'])
const cwd = parsed.values['--repo'] !== undefined && parsed.values['--repo'] !== '' ? resolve(parsed.values['--repo'] as string) : process.cwd()
const loaded = loadNotes(cwd)
const { config, notesRoot, repoRoot } = loaded

if (!config.backlinks.enabled) {
  console.log('verify-agent-notes:backlinks: disabled in config')
  process.exit(0)
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', 'vendor', '__pycache__', '.venv', 'venv', 'target'])
const errors: string[] = []

function readdirSafe(dir: string): { name: string; isDirectory(): boolean; isFile(): boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }) as unknown as { name: string; isDirectory(): boolean; isFile(): boolean }[]
  } catch {
    return []
  }
}

function* implementationFiles(): Generator<string> {
  const stack = config.backlinks.roots.map((root) => join(repoRoot, root)).filter((path) => existsSync(path))
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const entry of readdirSafe(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // A nested work tree keeps its own notes; its citations are not ours to grade.
        if (!SKIP_DIRS.has(entry.name) && !isNestedWorkTree(full, loaded.gitRoot)) stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(repoRoot, full).split('\\').join('/')
      if (matchesAny(rel, config.backlinks.exclude)) continue
      if (!config.backlinks.extensions.some((ext) => entry.name.endsWith(ext))) continue
      yield full
    }
  }
}

const rootPattern = config.root.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
const lifecycleAlt = [...config.lifecycles, config.archive].join('|')
const BTN = '`'
const STOP = '\\s)' + "'" + '"' + BTN + ' ,;'
const refPatterns = [
  // Repo-relative, including the path inside a relative markdown link.
  new RegExp(rootPattern + '\\/((?:' + lifecycleAlt + ')\\/[^' + STOP + ']+\\.md)', 'g'),
  // Lifecycle-relative, which is unambiguous because of the dated filename.
  new RegExp('(?:^|[\\s(' + "'" + '"' + BTN + '])((?:' + lifecycleAlt + ')\\/[a-z-]+\\/\\d{4}-\\d{2}-\\d{2}-[^' + STOP + ']+\\.md)', 'g'),
]

const anchored = new Set<string>()
let referenceCount = 0

for (const file of implementationFiles()) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('.md')) continue
  const relFile = relative(repoRoot, file).split('\\').join('/')
  text.split('\n').forEach((line, index) => {
    for (const pattern of refPatterns) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(line)) !== null) {
        referenceCount += 1
        const ref = match[1] as string
        const target = ref.startsWith(describe(loaded)) ? join(repoRoot, ref) : join(notesRoot, ref)
        if (!existsSync(target) || !statSync(target).isFile()) {
          errors.push('backlink: ' + relFile + ':' + (index + 1) + ' — ' + ref + ' does not resolve; the note moved or was archived')
          continue
        }
        anchored.add(resolve(target))
      }
    }
  })
}

if (config.backlinks.required) {
  const { notes } = walkNotes(loaded)
  for (const note of notes) {
    if (note.lifecycle !== 'implemented') continue
    if (!anchored.has(resolve(notesRoot, note.rel))) {
      errors.push('backlink: ' + note.rel + ' — no source file cites this shipped decision')
    }
  }
}

if (errors.length > 0) {
  console.error('verify-agent-notes:backlinks: ' + errors.length + ' violation(s)')
  for (const error of errors.slice(0, 25)) console.error('  ' + error)
  if (errors.length > 25) console.error('  … and ' + (errors.length - 25) + ' more')
  console.error('  Cite the note next to the declaration the decision governs:')
  console.error('    ' + "/**" + '… (see the [<topic> note](../../../../' + describe(loaded) + '/implemented/<class>/<yyyy-mm-dd-topic>.md)). ' + "*/")
  process.exit(1)
}

const suffix = config.backlinks.required
  ? 'every implemented note is anchored in source'
  : 'anchors resolve (backlinks.required is off, so an unanchored note is allowed)'
console.log('verify-agent-notes:backlinks: ' + referenceCount + ' reference(s) to ' + anchored.size + ' note(s); ' + suffix)
