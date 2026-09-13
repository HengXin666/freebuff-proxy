/**
 * Shared source of truth for an Agent Notes tree: configuration discovery,
 * structural walk, markdown link extraction, glob matching, and the frozen
 * archive manifest. Every verifier imports this module; it holds no policy.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const DEFAULT_LIFECYCLES = ['proposed', 'implemented', 'rejected']
export const DEFAULT_CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']

export interface CoverageConfig {
  enabled: boolean
  guarded: string[]
  exempt: string[]
  label: string
}

export interface BacklinkConfig {
  enabled: boolean
  /** Demand a source anchor for EVERY shipped note. Off by default; see references/mechanism.md. */
  required: boolean
  roots: string[]
  /** Paths never scanned: tooling, vendored trees, and the notes themselves. */
  exclude: string[]
  extensions: string[]
}

export interface NotesConfig {
  root: string
  archive: string
  lifecycles: string[]
  classes: string[]
  rootAllowlist: string[]
  translationSuffixes: string[]
  formatAdopted: string
  proseBannedPhrases: string[]
  coverage: CoverageConfig
  backlinks: BacklinkConfig
}

export interface AgentNote {
  lifecycle: string
  cls: string
  /** Path relative to the notes root, always with forward slashes. */
  rel: string
  /** yyyy-mm-dd taken from the filename. */
  date: string
}

export interface LoadedNotes {
  repoRoot: string
  notesRoot: string
  configPath: string | null
  /** The work-tree root in scope. `null` only outside version control. */
  gitRoot: string | null
  config: NotesConfig
}

export const DEFAULT_CONFIG: NotesConfig = {
  root: '.agents/notes',
  archive: 'archived',
  lifecycles: DEFAULT_LIFECYCLES,
  classes: DEFAULT_CLASSES,
  rootAllowlist: ['AGENTS.md', 'CLAUDE.md', 'NOTE-EXEMPT.md', 'README.md', 'README.zh.md', 'README.i18n.yaml'],
  translationSuffixes: ['.zh.md'],
  formatAdopted: '2026-07-05',
  proseBannedPhrases: [],
  coverage: {
    enabled: true,
    guarded: ['src/**', 'packages/*/src/**', 'apps/**/src/**', 'lib/**', 'scripts/**'],
    exempt: ['**/*.md', '**/*.test.*', '**/*.spec.*', '**/__snapshots__/**', '.agents/**', '**/.agents/**'],
    label: 'note-exempt',
  },
  backlinks: {
    enabled: true,
    required: false,
    roots: ['src', 'packages', 'apps', 'lib', 'scripts'],
    // A vendored skill or notes tree ships its own copies of these checks and their fixtures,
    // so scanning it would grade the tool instead of the project.
    exclude: [
      '.agents/**',
      '**/.agents/**',
      // Test files build synthetic note paths to exercise link handling; a fake path there is
      // not a rotted citation, and those files are not where a decision is enforced.
      '**/*.spec.*',
      '**/*.test.*',
    ],
    extensions: ['.ts', '.tsx', '.js', '.mjs', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp'],
  },
}

const CONFIG_NAMES = ['notes.config.json', 'agent-notes.config.json']

/**
 * The work-tree root that owns `start`: the nearest ancestor holding a `.git` entry (a
 * directory for a normal clone, a file for a submodule or worktree). Everything above it is a
 * different repository, so no path outside it is this repository's business.
 */
export function findGitRoot(start: string): string | null {
  let cur = resolve(start)
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(cur, '.git'))) return cur
    const parent = resolve(cur, '..')
    if (parent === cur) break
    cur = parent
  }
  return null
}

/**
 * True when `dir` is a *different* work tree nested inside the one being graded. A nested
 * repository has its own notes tree and its own gates; reading, counting, or (worst) archiving
 * its files from the outer repository would silently grade somebody else's project.
 */
export function isNestedWorkTree(dir: string, boundary: string | null): boolean {
  if (boundary === null) return false
  const abs = resolve(dir)
  if (abs === resolve(boundary)) return false
  return existsSync(join(abs, '.git'))
}

function findUp(start: string, matcher: (dir: string) => string | null, boundary: string | null, maxDepth = 12): string | null {
  let cur = resolve(start)
  for (let i = 0; i < maxDepth; i += 1) {
    const hit = matcher(cur)
    if (hit !== null) return hit
    // Stop at the work-tree root: a config above it belongs to an enclosing repository, and
    // adopting it would point these gates at a tree this checkout does not own.
    if (boundary !== null && cur === resolve(boundary)) break
    const parent = resolve(cur, '..')
    if (parent === cur) break
    cur = parent
  }
  return null
}

export function loadNotes(cwd: string = process.cwd()): LoadedNotes {
  // Repository scope is decided before anything is read: the notes tree, the config, and every
  // path these gates compare are all confined to one work tree.
  const gitRoot = findGitRoot(cwd)
  const explicit = process.env.AGENT_NOTES_CONFIG
  let configPath: string | null = explicit !== undefined && explicit !== '' ? resolve(cwd, explicit) : null
  if (configPath === null) {
    configPath = findUp(cwd, (dir) => {
      for (const name of CONFIG_NAMES) {
        const candidate = join(dir, '.agents', name)
        if (existsSync(candidate)) return candidate
      }
      return null
    }, gitRoot)
  }
  const config: NotesConfig = structuredClone(DEFAULT_CONFIG)
  if (configPath !== null && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<NotesConfig>
    Object.assign(config, raw)
    config.coverage = { ...DEFAULT_CONFIG.coverage, ...(raw.coverage ?? {}) }
    config.backlinks = { ...DEFAULT_CONFIG.backlinks, ...(raw.backlinks ?? {}) }
    // The default exemptions assume markdown and .agents are documentation rather than guarded
    // source. A project that guards them says the opposite, and inheriting the assumption would
    // silently exempt every path the project just asked to guard — a gate that never fires.
    if (raw.coverage?.guarded !== undefined) {
      const defeated = config.coverage.exempt.filter((pattern) =>
        config.coverage.guarded.some((guard) => globToRegExp(pattern).test(samplePath(guard))))
      if (defeated.length > 0) {
        config.coverage.exempt = config.coverage.exempt.filter((p) => !defeated.includes(p))
      }
    }
  }
  const envRoot = process.env.AGENT_NOTES_ROOT
  const repoRoot = configPath !== null ? resolve(dirname(configPath), '..') : (gitRoot ?? resolve(cwd))
  const notesRoot = envRoot !== undefined && envRoot !== ''
    ? resolve(cwd, envRoot)
    : resolve(repoRoot, config.root)
  return { repoRoot, notesRoot, configPath, config, gitRoot }
}

function toPosix(value: string): string {
  return value.split('\\').join('/')
}

function listFiles(root: string, boundary: string | null, out: string[]): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      // Never descend into another work tree: its notes belong to its own gates.
      if (isNestedWorkTree(full, boundary)) continue
      listFiles(full, boundary, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/**
 * Every regular file below one directory, as forward-slash paths relative to it.
 * `boundary` is the work tree in scope; nested work trees are not entered.
 */
export function filesUnder(root: string, boundary: string | null = null): string[] {
  if (!existsSync(root)) return []
  return listFiles(root, boundary, []).map((full) => toPosix(relative(root, full)))
}

export function walkNotes(loaded: LoadedNotes): { notes: AgentNote[]; errors: string[] } {
  const { notesRoot, config } = loaded
  const notes: AgentNote[] = []
  const errors: string[] = []
  if (!existsSync(notesRoot)) {
    errors.push('structure: notes root ' + toPosix(relative(loaded.repoRoot, notesRoot)) + ' does not exist — run the installer or create it')
    return { notes, errors }
  }
  const known = new Set(config.lifecycles)
  for (const entry of readdirSync(notesRoot, { withFileTypes: true })) {
    if (entry.name === 'INDEX.md') {
      errors.push('structure: INDEX.md — centralized indexes are forbidden; the path (lifecycle/class) is the index, and a shared index makes every parallel branch conflict')
      continue
    }
    if (entry.isDirectory()) {
      if (entry.name !== config.archive && !known.has(entry.name)) {
        errors.push('structure: ' + entry.name + '/ — unknown lifecycle folder (allowed: ' + config.lifecycles.join(', ') + ', plus ' + config.archive + '/)')
      }
      continue
    }
    const documented = config.rootAllowlist.includes(entry.name)
      || config.translationSuffixes.some((suffix) => entry.name.endsWith(suffix))
      || entry.name.endsWith('.i18n.yaml')
    if (!documented) {
      errors.push('structure: ' + entry.name + ' — stray file at the notes root (allowed: ' + config.rootAllowlist.join(', ') + ', plus translation counterparts)')
    }
  }
  for (const lifecycle of config.lifecycles) {
    for (const rel of filesUnder(join(notesRoot, lifecycle), loaded.gitRoot).sort()) {
      if (!rel.endsWith('.md')) continue
      if (config.translationSuffixes.some((suffix) => rel.endsWith(suffix))) continue
      const segs = rel.split('/')
      if (segs.length === 1 && config.rootAllowlist.includes(segs[0] ?? '')) continue
      const cls = segs[0]
      const base = segs[1]
      if (segs.length !== 2 || cls === undefined || base === undefined) {
        errors.push('structure: ' + lifecycle + '/' + rel + ' — expected ' + lifecycle + '/<class>/yyyy-mm-dd-topic.md (got a different depth)')
        continue
      }
      if (!config.classes.includes(cls)) {
        errors.push('structure: ' + lifecycle + '/' + rel + ' — unknown class folder "' + cls + '" (allowed: ' + config.classes.join(', ') + '); adding a class is a config change, not a folder rename')
        continue
      }
      if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(base)) {
        errors.push('structure: ' + lifecycle + '/' + rel + ' — filename must be yyyy-mm-dd-topic.md')
        continue
      }
      notes.push({ lifecycle, cls, rel: lifecycle + '/' + rel, date: base.slice(0, 10) })
    }
  }
  return { notes, errors }
}

export interface MarkdownLink { label: string; target: string }

/**
 * Remove fenced blocks and inline code spans. A note that *documents* a broken link quotes it as
 * an example, and a quoted example is not a reference: resolving it would report the note as
 * broken precisely because it describes the breakage.
 */
export function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
}

export function markdownLinks(text: string): MarkdownLink[] {
  const out: MarkdownLink[] = []
  const source = stripCode(text)
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    out.push({ label: match[1] ?? '', target: match[2] ?? '' })
  }
  return out
}

/** True for targets the gate must not resolve (external, anchors, placeholders). */
export function isExternalLink(target: string): boolean {
  return target.startsWith('http://')
    || target.startsWith('https://')
    || target.startsWith('#')
    || target.startsWith('mailto:')
    || target.includes('…')
    || target.includes('<')
}

/** A concrete path a glob would match, used to test whether another pattern defeats it. */
function samplePath(glob: string): string {
  return glob.replace(/\*\*/g, 'x').replace(/\*/g, 'x').replace(/\?/g, 'x')
}

export function globToRegExp(glob: string): RegExp {
  let out = ''
  const pattern = toPosix(glob)
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string
    if (char === '*' && pattern[i + 1] === '*') {
      i += 1
      if (pattern[i + 1] === '/') {
        i += 1
        out += '(?:.*/)?'
      } else {
        out += '.*'
      }
      continue
    }
    if (char === '*') { out += '[^/]*'; continue }
    if (char === '?') { out += '[^/]'; continue }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + out + '$')
}

export function matchesAny(path: string, globs: string[]): boolean {
  const target = toPosix(path)
  return globs.some((glob) => globToRegExp(glob).test(target))
}

export interface ParsedArgs {
  /** Values that are not options, in the order given. */
  positionals: string[]
  /** Option name to its value, for the options listed in `valueFlags`. */
  values: Record<string, string>
  /** Options given without a value. */
  flags: Set<string>
}

/**
 * Split argv into positionals, valued options, and bare flags. Knowing which options take a
 * value is what keeps `--bundle <dir> <out>` from losing `<dir>` to the flag before it.
 */
export function parseArgv(argv: string[], valueFlags: string[]): ParsedArgs {
  const positionals: string[] = []
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i] as string
    if (!item.startsWith('--')) {
      positionals.push(item)
      continue
    }
    if (valueFlags.includes(item)) {
      values[item] = argv[i + 1] ?? ''
      i += 1
      continue
    }
    flags.add(item)
  }
  return { positionals, values, flags }
}

export interface ArchiveManifest { version: number; files: Record<string, string> }

export function manifestPathFor(loaded: LoadedNotes): string {
  return join(loaded.notesRoot, loaded.config.archive, 'manifest.json')
}

/**
 * Prove the manifest is append-only against a trusted earlier revision. A tamperer who
 * edits a frozen note and re-hashes it locally still fails here, because CI compares
 * against the pre-change commit rather than the working tree.
 */
export function verifyManifestAppendOnly(repoRoot: string, manifestRelPath: string, current: Record<string, string>, baselineRef: string): { errors: string[]; checked: number } {
  const errors: string[] = []
  const result = spawnSync('git', ['show', baselineRef + ':' + manifestRelPath], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) return { errors, checked: 0 }
  let baseline: ArchiveManifest
  try {
    baseline = JSON.parse(result.stdout) as ArchiveManifest
  } catch {
    return { errors: ['archive: the manifest at ' + baselineRef + ' is not valid JSON; refusing to compare'], checked: 0 }
  }
  const files = baseline.files ?? {}
  for (const [key, hash] of Object.entries(files)) {
    if (current[key] === undefined) {
      errors.push('archive: ' + key + ' — seal present at ' + baselineRef + ' is missing now; a seal is append-only, restore it')
      continue
    }
    if (current[key] !== hash) {
      errors.push('archive: ' + key + ' — sealed bytes changed since ' + baselineRef + '; archived notes are frozen')
    }
  }
  return { errors, checked: Object.keys(files).length }
}

export function renderManifest(files: Record<string, string>): string {
  const sorted: Record<string, string> = {}
  for (const key of Object.keys(files).sort()) sorted[key] = files[key] as string
  return JSON.stringify({ version: 1, files: sorted }, null, 2) + '\n'
}

export function readManifest(loaded: LoadedNotes): { manifest: ArchiveManifest; error: string | null } {
  const path = manifestPathFor(loaded)
  if (!existsSync(path)) return { manifest: { version: 1, files: {} }, error: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ArchiveManifest
    return { manifest: { version: 1, files: parsed.files ?? {} }, error: null }
  } catch (error) {
    return { manifest: { version: 1, files: {} }, error: 'manifest.json is not valid JSON: ' + String(error) }
  }
}

export function sha256File(path: string): string {
  return 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The date-stamped seal line every archived note carries below its status. */
export const ARCHIVED_LINE_RE = /^Archived: \d{4}-\d{2}-\d{2}$/

/**
 * Verify the frozen archive: known kind folders, one seal line per archived note,
 * and every artifact byte-identical to its manifest hash. An unsealed artifact is
 * a violation unless the caller is sealing it (write mode).
 */
export function verifyArchive(loaded: LoadedNotes, writeMode: boolean): string[] {
  const { notesRoot, config } = loaded
  const archiveRoot = join(notesRoot, config.archive)
  const errors: string[] = []
  const added: string[] = []
  if (!existsSync(archiveRoot)) return errors
  const { manifest, error } = readManifest(loaded)
  if (error !== null) errors.push('archive: ' + error)
  const artifacts: Record<string, string> = {}
  for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
    if (entry.isFile()) {
      if (!['AGENTS.md', 'manifest.json'].includes(entry.name)) {
        errors.push('archive: ' + entry.name + ' — unexpected root file')
      }
      continue
    }
    if (!config.classes.includes(entry.name)) {
      errors.push('archive: ' + entry.name + '/ — unknown class folder')
      continue
    }
    for (const rel of filesUnder(join(archiveRoot, entry.name), loaded.gitRoot)) {
      const key = entry.name + '/' + rel
      const full = join(archiveRoot, entry.name, rel)
      artifacts[key] = sha256File(full)
      if (rel.endsWith('.md') && !config.translationSuffixes.some((suffix) => rel.endsWith(suffix))) {
        const lines = readFileSync(full, 'utf8').split('\n')
        if (!lines.slice(0, 6).some((line) => ARCHIVED_LINE_RE.test(line.trim()))) {
          errors.push('archive: ' + key + ' — missing the Archived: YYYY-MM-DD seal line below Status')
        }
      }
    }
  }
  for (const [key, hash] of Object.entries(artifacts)) {
    const sealed = manifest.files[key]
    if (sealed === undefined) {
      if (writeMode) added.push(key)
      else errors.push('archive: ' + key + ' — not sealed in manifest.json (run the archive script, or seal with --write)')
      continue
    }
    if (sealed !== hash) {
      errors.push('archive: ' + key + ' — content changed after sealing; archived notes are frozen, restore the sealed bytes')
    }
  }
  for (const key of Object.keys(manifest.files)) {
    if (artifacts[key] === undefined) errors.push('archive: ' + key + ' — sealed artifact is missing')
  }
  if (writeMode && added.length > 0 && errors.length === 0) {
    for (const key of added) manifest.files[key] = artifacts[key] as string
    mkdirSync(dirname(manifestPathFor(loaded)), { recursive: true })
    writeFileSync(manifestPathFor(loaded), renderManifest(manifest.files))
  }
  return errors
}

/** A one-line description of the resolved tree, for gate output. */
export function describe(loaded: LoadedNotes): string {
  return toPosix(relative(loaded.repoRoot, loaded.notesRoot)) || loaded.notesRoot
}

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}