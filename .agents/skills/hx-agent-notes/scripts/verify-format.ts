/**
 * Gate 2 — format: the three-line header, status/lifecycle agreement, first section
 * `## Problem`, lifecycle-specific sections, the mandatory Alternatives section,
 * present-tense discipline in implemented notes, and translation skeleton parity.
 * Usage: npx tsx scripts/verify-format.ts [--repo <dir>]
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentNote } from './notes-lib.ts'
import { loadNotes, parseArgv, walkNotes } from './notes-lib.ts'

const parsed = parseArgv(process.argv.slice(2), ['--repo'])
const cwd = parsed.values['--repo'] !== undefined && parsed.values['--repo'] !== '' ? resolve(parsed.values['--repo'] as string) : process.cwd()
const loaded = loadNotes(cwd)
const { notes, errors } = walkNotes(loaded)

const GRANDFATHER = '<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->'

const SECTIONS = {
  problem: ['## Problem', '## 问题'],
  proposal: ['## Proposal', '## 提议', '## 方案', '## 提案'],
  decision: ['## Decision', '## 决定', '## 决策'],
  alternatives: ['## Alternatives considered', '## 备选方案', '## 考虑过的备选方案', '## 备选'],
  acceptance: ['## Acceptance criteria', '## 验收标准', '## 验收条件'],
  risks: ['## Risks', '## 风险'],
  consequences: ['## Consequences', '## 后果', '## 影响'],
}

// 'alternatives' is deliberately absent: it is checked separately below so a pre-format note can
// carry the grandfather comment instead. Demanding it here made that escape unreachable.
const REQUIRED: Record<string, string[]> = {
  proposed: ['proposal', 'acceptance', 'risks'],
  implemented: ['decision', 'consequences'],
  rejected: ['proposal'],
}

const BANNED_IMPLEMENTED = [
  '## Proposal', '## Plan', '## Migration plan', '## Acceptance criteria',
  '## 提议', '## 方案', '## 提案', '## 计划', '## 规划', '## 验收标准', '## 验收条件',
]

const STATUS: Record<string, RegExp> = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
}

/** Body lines with fenced code removed: format tokens inside examples are not structure. */
function proseLines(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { inFence = !inFence; continue }
    if (!inFence) out.push(line)
  }
  return out
}

function h2Of(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith('## ')).map((line) => line.trimEnd())
}

function sectionsOf(h2s: string[]): Set<string> {
  const found = new Set<string>()
  for (const [name, aliases] of Object.entries(SECTIONS)) {
    if (h2s.some((heading) => aliases.some((alias) => heading === alias || heading.startsWith(alias + ' ')))) found.add(name)
  }
  return found
}

function check(notes: AgentNote[]): void {
  for (const note of notes) {
    const full = resolve(loaded.notesRoot, note.rel)
    const raw = readFileSync(full, 'utf8')
    const lines = raw.split('\n')
    const prose = proseLines(raw)
    const fail = (message: string): void => { errors.push('format: ' + note.rel + ' — ' + message) }

    if (!/^# Agent Note: \S/.test(lines[0] ?? '')) fail('line 1 must be `# Agent Note: <title>`')
    if (lines[1] !== '') fail('line 2 must be blank')
    const statusRe = STATUS[note.lifecycle]
    if (statusRe !== undefined && !statusRe.test(lines[2] ?? '')) {
      fail('line 3 must match the ' + note.lifecycle + ' status grammar (' + String(statusRe) + ')')
    }
    if (lines[3] !== '') fail('line 4 must be blank')
    const statusLines = prose.filter((line) => line.startsWith('Status:'))
    if (statusLines.length !== 1 || statusLines[0] !== lines[2]) fail('the line-3 `Status:` line must be the only Status line in the file')

    const h2s = h2Of(prose)
    const found = sectionsOf(h2s)
    const firstSection = h2s[0]
    if (firstSection === undefined || !SECTIONS.problem.includes(firstSection)) {
      fail('the first section must be `## Problem` (got ' + JSON.stringify(firstSection ?? '<none>') + ')')
    }
    for (const name of REQUIRED[note.lifecycle] ?? []) {
      if (!found.has(name)) fail('missing the required `' + (SECTIONS[name]?.[0] ?? name) + '` section')
    }
    if (note.lifecycle === 'implemented') {
      for (const heading of h2s) {
        if (BANNED_IMPLEMENTED.some((banned) => heading.startsWith(banned))) {
          fail('`' + heading + '` is proposal-era wording; an implemented note states what is — fold it into Decision/Consequences/Testing')
        }
      }
    }
    const hasAlt = found.has('alternatives')
    const hasGrandfather = prose.includes(GRANDFATHER)
    if (hasAlt && hasGrandfather) fail('carries both the Alternatives section and the grandfather comment — drop the comment')
    if (!hasAlt) {
      const preFormat = note.date < loaded.config.formatAdopted
      if (!hasGrandfather) fail('missing `## Alternatives considered` — a decision recorded without what it beat invites re-litigation')
      else if (!preFormat) fail('the grandfather comment is only valid for notes dated before ' + loaded.config.formatAdopted)
    }
    for (const phrase of loaded.config.proseBannedPhrases) {
      if (raw.includes(phrase)) fail('carries the banned phrase ' + JSON.stringify(phrase))
    }

    // Translation skeleton parity: a counterpart mirrors the English section count.
    for (const suffix of loaded.config.translationSuffixes) {
      const counterpart = full.replace(/\.md$/, suffix)
      if (!existsSync(counterpart)) continue
      const counterpartH2 = h2Of(proseLines(readFileSync(counterpart, 'utf8')))
      if (counterpartH2.length !== h2s.length) {
        const rel = note.rel.replace(/\.md$/, suffix)
        errors.push('format: ' + rel + ' — ' + counterpartH2.length + ' section(s) against ' + h2s.length + ' in ' + note.rel + '; a translation mirrors its sibling section-for-section')
      }
    }
  }
}

check(notes)

if (errors.length > 0) {
  console.error('verify-agent-notes:format: ' + errors.length + ' violation(s)')
  for (const error of errors) console.error('  ' + error)
  process.exit(1)
}
console.log('verify-agent-notes:format: ' + notes.length + ' note(s) conform (header, status, sections, alternatives, tense)')