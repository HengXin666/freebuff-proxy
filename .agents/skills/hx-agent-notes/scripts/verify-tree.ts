/**
 * Gate 1 — structure: lifecycle/class/filename rules for every note, no root INDEX.md,
 * and relative markdown links inside the active tree that still resolve.
 * Usage: npx tsx scripts/verify-tree.ts [--repo <dir>]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, filesUnder, isExternalLink, loadNotes, markdownLinks, parseArgv, walkNotes } from './notes-lib.ts'

const parsed = parseArgv(process.argv.slice(2), ['--repo'])
const cwd = parsed.values['--repo'] !== undefined && parsed.values['--repo'] !== '' ? resolve(parsed.values['--repo'] as string) : process.cwd()
const loaded = loadNotes(cwd)
const { notes, errors } = walkNotes(loaded)

for (const note of notes) {
  const full = resolve(loaded.notesRoot, note.rel)
  for (const link of markdownLinks(readFileSync(full, 'utf8'))) {
    if (isExternalLink(link.target)) continue
    const withoutAnchor = link.target.split('#')[0] ?? ''
    if (withoutAnchor === '') continue
    const target = resolve(dirname(full), withoutAnchor)
    if (!target.startsWith(loaded.notesRoot)) continue
    if (!existsSync(target)) {
      errors.push('link: ' + note.rel + ' -> "' + link.target + '" does not resolve')
    }
  }
}

// Nested translation sidecars are legitimate; loose files beside a note are not.
for (const lifecycle of loaded.config.lifecycles) {
  for (const rel of filesUnder(resolve(loaded.notesRoot, lifecycle))) {
    if (rel.endsWith('.md')) continue
    const base = rel.split('/').pop() ?? rel
    if (['AGENTS.md', 'CLAUDE.md'].includes(base)) continue
    const isSidecar = rel.endsWith('.i18n.yaml') || base.startsWith('.')
    if (!isSidecar) errors.push('structure: ' + lifecycle + '/' + rel + ' — only .md, translation .zh.md, .i18n.yaml, and dotfiles belong in the tree')
  }
}

if (errors.length > 0) {
  console.error('verify-agent-notes:tree: ' + errors.length + ' violation(s) under ' + describe(loaded))
  for (const error of errors) console.error('  ' + error)
  process.exit(1)
}
console.log('verify-agent-notes:tree: ' + notes.length + ' note(s) verified under ' + describe(loaded) + ' (structure, filename, links)')