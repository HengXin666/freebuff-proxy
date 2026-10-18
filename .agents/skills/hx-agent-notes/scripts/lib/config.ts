/**
 * Notes-tree scope and configuration: work-tree discovery, config loading with a guarded
 * exemption merge, and the shared path helpers the rest of the library builds on.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { defeatedExemptions, toPosix } from './glob.ts'

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
      const defeated = defeatedExemptions(config.coverage.exempt, config.coverage.guarded)
      if (defeated.length > 0) {
        config.coverage.exempt = config.coverage.exempt.filter((pattern) => !defeated.includes(pattern))
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

/** A one-line description of the resolved tree, for gate output. */
export function describe(loaded: LoadedNotes): string {
  return toPosix(relative(loaded.repoRoot, loaded.notesRoot)) || loaded.notesRoot
}

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}
