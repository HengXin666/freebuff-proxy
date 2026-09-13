/**
 * Create one note from the lifecycle template with a correct path, date, and status.
 * Usage: npx tsx scripts/new-note.ts <lifecycle> <class> <topic-slug> [--date YYYY-MM-DD] [--title <title>] [--repo <dir>]
 * Example: npx tsx scripts/new-note.ts proposed architecture session-store-handles
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadNotes, parseArgv } from './notes-lib.ts'

const argv = process.argv.slice(2)
const parsed = parseArgv(argv, ['--date', '--title', '--repo'])
const positional = parsed.positionals
function flag(name: string): string | null {
  return parsed.values[name] ?? null
}
if (positional.length < 3) {
  console.error('Usage: npx tsx scripts/new-note.ts <lifecycle> <class> <topic-slug> [--date YYYY-MM-DD] [--title <title>] [--repo <dir>]')
  process.exit(2)
}
const [lifecycle, cls, slug] = positional as [string, string, string]
const repoArg = flag('--repo')
const cwd = repoArg !== null && repoArg !== '' ? resolve(repoArg) : process.cwd()
const loaded = loadNotes(cwd)
const { config, notesRoot } = loaded

if (!config.lifecycles.includes(lifecycle)) {
  console.error('Error: unknown lifecycle "' + lifecycle + '" (allowed: ' + config.lifecycles.join(', ') + ')')
  process.exit(1)
}
if (!config.classes.includes(cls)) {
  console.error('Error: unknown class "' + cls + '" (allowed: ' + config.classes.join(', ') + ')')
  process.exit(1)
}
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
  console.error('Error: slug must be lowercase words joined by single hyphens (got ' + JSON.stringify(slug) + ')')
  process.exit(1)
}
const date = flag('--date') ?? new Date().toISOString().slice(0, 10)
const title = flag('--title') ?? slug.split('-').join(' ')
const dir = resolve(notesRoot, lifecycle, cls)
const file = resolve(dir, date + '-' + slug + '.md')
if (existsSync(file)) {
  console.error('Error: ' + file + ' already exists; update the note that already owns this decision')
  process.exit(1)
}

const status = lifecycle === 'rejected'
  ? 'Status: rejected — <one line: why the proposal loses>'
  : 'Status: ' + lifecycle

const body = [
  '# Agent Note: ' + title,
  '',
  status,
  '',
  '## Problem',
  '',
  '<What breaks, what must change, and what happens if nothing does. This section must stand on its own: delete the rest of the file and it still describes the same problem.>',
  '',
  lifecycle === 'proposed' ? '## Proposal' : lifecycle === 'implemented' ? '## Decision' : '## Proposal',
  '',
  lifecycle === 'implemented'
    ? '<What shipped, stated in the present tense. Name the mechanism, not the intention.>'
    : '<The intended change. Future tense is allowed while the work is unbuilt.>',
  '',
  '## Alternatives considered',
  '',
  '- **<Strongest rival option>** — <its best argument>, then why it loses here.',
  '- **<Do nothing / reuse what exists>** — <why that was not enough>.',
  '',
  lifecycle === 'proposed' ? '## Acceptance criteria' : lifecycle === 'rejected' ? '' : '## Consequences',
  // A rejected note is a frozen proposal and still carries the mandatory section above it,
  '',
  lifecycle === 'proposed'
    ? '<The observable state that means done.>'
    : lifecycle === 'rejected'
      ? ''
      : '<What this cost and what it bought. Both halves are mandatory. Any relative claim needs a baseline; without one state the fact instead.>',
  '',
  lifecycle === 'proposed' ? '## Risks' : '',
  '',
  lifecycle === 'proposed' ? '<What could go wrong, and what the change knowingly gives up.>' : '',
  '',
].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n')

mkdirSync(dir, { recursive: true })
writeFileSync(file, body.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8')
console.log('created: ' + file.split('\\').join('/'))