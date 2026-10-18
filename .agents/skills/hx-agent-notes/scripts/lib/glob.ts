/**
 * Glob matching and argv parsing: the two pure helpers every gate entry point reuses.
 */
export function toPosix(value: string): string {
  return value.split('\\').join('/')
}

/** A concrete path a glob would match, used to test whether another pattern defeats it. 
 * .agents/notes/implemented/process/2026-10-08-repository-agent-notes-v2-adoption.md
 */
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

/**
 * Exemptions that a guarded glob already covers. A project that guards a path has said the
 * assumption behind the default exemption does not hold there, so the exemption must not
 * silently swallow the guard.
 */
export function defeatedExemptions(exempt: string[], guarded: string[]): string[] {
  return exempt.filter((pattern) =>
    guarded.some((guard) => globToRegExp(pattern).test(samplePath(guard))))
}
