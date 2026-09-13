/**
 * Write the Agent Notes board.
 * Usage:
 *   npx tsx scripts/build-board.ts --init [board.html] ["Project name"]
 *     Lightweight shell (~one file). Open it, click \"Connect notes folder\", pick the
 *     notes directory, and it reads the tree directly — zero rebuild while you write.
 *   npx tsx scripts/build-board.ts --bundle [notesDir] [demo.html] ["Project name"]
 *     Self-contained copy with every note embedded, for offline sharing or Pages.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadNotes, parseArgv } from './notes-lib.ts'

const argv = process.argv.slice(2)
const parsed = parseArgv(argv, ['--repo'])
const mode = parsed.flags.has('--bundle') ? 'bundle' : parsed.flags.has('--init') ? 'init' : null
if (mode === null) {
  console.error('Usage: npx tsx scripts/build-board.ts --init [board.html] ["Project name"]')
  console.error('       npx tsx scripts/build-board.ts --bundle [notesDir] [demo.html] ["Project name"]')
  process.exit(2)
}
const cwd = parsed.values['--repo'] !== undefined && parsed.values['--repo'] !== '' ? resolve(parsed.values['--repo'] as string) : process.cwd()
const rest = parsed.positionals
const here = import.meta.dirname
const templatePath = resolve(here, '..', 'assets', 'board-template.html')
const template = readFileSync(templatePath, 'utf8')
const loaded = loadNotes(cwd)

const DATA_SLOT = '/*__AGENT_NOTES_DATA__*/[]'
const NAME_SLOT = '"Agent Notes"'

function render(data: unknown, name: string, bundled: boolean): string {
  return template
    .replace(DATA_SLOT, () => JSON.stringify(data))
    .replace(NAME_SLOT, () => JSON.stringify(name))
    .replace('"__BUNDLED__"', () => JSON.stringify(bundled))
}

function readNotesTree(root: string): unknown[] {
  const out: unknown[] = []
  for (const lifecycle of [...loaded.config.lifecycles, loaded.config.archive]) {
    const base = join(root, lifecycle)
    if (!existsSync(base)) continue
    for (const cls of readdirSync(base, { withFileTypes: true })) {
      if (!cls.isDirectory()) continue
      for (const file of readdirSync(join(base, cls.name))) {
        if (!file.endsWith('.md') || loaded.config.translationSuffixes.some((suffix) => file.endsWith(suffix))) continue
        if (['AGENTS.md', 'CLAUDE.md'].includes(file)) continue
        const text = readFileSync(join(base, cls.name, file), 'utf8')
        const lines = text.split('\n')
        const title = (lines[0] ?? '').replace(/^# Agent Note:\s*/, '') || file
        const statusLine = lines.slice(0, 6).find((line) => line.startsWith('Status:')) ?? 'Status: unknown'
        const retired = lines.slice(0, 8).find((line) => line.startsWith('Archived:'))?.slice(10) ?? null
        const sections: { heading: string; body: string }[] = []
        let current: { heading: string; body: string } | null = null
        for (const line of lines) {
          if (line.startsWith('## ')) {
            current = { heading: line.slice(3).trim(), body: '' }
            sections.push(current)
          } else if (current !== null && !line.startsWith('# Agent Note:') && !line.startsWith('Status:')) {
            current.body += line + '\n'
          }
        }
        const date = (file.match(/^\d{4}-\d{2}-\d{2}/) ?? [''])[0]
        out.push({
          path: lifecycle + '/' + cls.name + '/' + file,
          lifecycle, cls: cls.name, file, date, title, retired,
          status: statusLine.replace(/^Status:\s*/, '').slice(0, 60),
          sections: sections.map((section) => ({ heading: section.heading, body: section.body.trim() })),
        })
      }
    }
  }
  return out.sort((a, b) => String((a as { path: string }).path).localeCompare(String((b as { path: string }).path)))
}

if (mode === 'init') {
  const out = resolve(cwd, rest[0] ?? 'board.html')
  const name = rest[1] ?? loaded.repoRoot.split('/').pop() ?? 'Agent Notes'
  writeFileSync(out, render([], name, false), 'utf8')
  console.log('board: wrote ' + out + ' (' + Math.round(readFileSync(out).length / 1024) + ' KB, reads the folder live)')
  console.log('open it, click "Connect notes folder", and pick ' + loaded.notesRoot)
} else {
  const notesDir = resolve(cwd, rest[0] ?? loaded.notesRoot)
  const out = resolve(cwd, rest[1] ?? 'demo.html')
  const name = rest[2] ?? loaded.repoRoot.split('/').pop() ?? 'Agent Notes'
  const notes = readNotesTree(notesDir)
  writeFileSync(out, render(notes, name, true), 'utf8')
  console.log('board: bundled ' + notes.length + ' note(s) into ' + out)
}