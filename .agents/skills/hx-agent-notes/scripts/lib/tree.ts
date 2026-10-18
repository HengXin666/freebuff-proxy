/**
 * Tree walking and markdown link extraction: enumerate the note files a gate grades, and read
 * the relative links a note carries.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type LoadedNotes, isNestedWorkTree } from './config.ts'
import { toPosix } from './glob.ts'

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
