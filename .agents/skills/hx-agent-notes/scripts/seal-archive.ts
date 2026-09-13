/**
 * Seal (or re-verify) the frozen archive manifest.
 * Usage: npx tsx scripts/seal-archive.ts [--write] [--repo <dir>]
 * Without --write this is a pure verifier: the same rules the CI gate runs.
 */
import { relative, resolve } from 'node:path'
import { describe, loadNotes, parseArgv, readManifest, verifyArchive, verifyManifestAppendOnly } from './notes-lib.ts'

const argv = process.argv.slice(2)
const parsed = parseArgv(argv, ['--repo', '--baseline'])
const writeMode = parsed.flags.has('--write')
const cwd = parsed.values['--repo'] !== undefined && parsed.values['--repo'] !== '' ? resolve(parsed.values['--repo'] as string) : process.cwd()
const loaded = loadNotes(cwd)
const errors = verifyArchive(loaded, writeMode)

// Append-only proof against a trusted earlier revision. Local runs default to HEAD, so a
// hand-edited note plus a re-run of the seal script is still caught before the commit.
const baselineRef = parsed.values['--baseline'] !== undefined && parsed.values['--baseline'] !== ''
  ? parsed.values['--baseline'] as string
  : process.env.AGENT_NOTES_BASE_REF ?? 'HEAD'
const manifestRelPath = relative(loaded.repoRoot, resolve(loaded.notesRoot, loaded.config.archive, 'manifest.json')).split('\\').join('/')
let appended = 0
if (baselineRef !== '' && errors.length === 0) {
  const current = readManifest(loaded).manifest.files
  const proof = verifyManifestAppendOnly(loaded.repoRoot, manifestRelPath, current, baselineRef)
  errors.push(...proof.errors)
  appended = proof.checked
}

if (errors.length > 0) {
  console.error('verify-agent-notes:archive: ' + errors.length + ' violation(s)')
  for (const error of errors) console.error('  ' + error)
  if (writeMode) console.error('  (nothing was sealed: --write refuses while any violation is outstanding)')
  process.exit(1)
}
console.log('verify-agent-notes:archive: ' + (writeMode ? 'sealed new artifact(s)' : 'frozen archive intact') + ' under ' + describe(loaded) + ' (' + appended + ' existing seal(s) proven unchanged against ' + baselineRef + ')')