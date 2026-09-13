/**
 * Run every Agent Notes gate in order and report one aggregate verdict.
 * Usage: npx tsx scripts/verify-all.ts [--staged | --base <ref>] [--repo <dir>]
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgv } from './notes-lib.ts'

const argv = process.argv.slice(2)
const parsed = parseArgv(argv, ['--repo', '--base'])
const repoArg = parsed.values['--repo']
const cwd = repoArg !== undefined && repoArg !== '' ? resolve(repoArg) : process.cwd()
const here = import.meta.dirname

function forwarded(extra: string[]): string[] {
  const common: string[] = []
  if (repoArg !== undefined && repoArg !== '') common.push('--repo', cwd)
  return [...common, ...extra]
}

const staged = parsed.flags.has('--staged')
const baseRef = parsed.values['--base'] !== undefined ? (parsed.values['--base'] || 'HEAD') : null
const coverageArgs = staged ? ['--staged'] : baseRef !== null ? ['--base', baseRef] : []
// The archive gate proves the manifest is append-only against a trusted earlier revision.
const archiveArgs = baseRef !== null ? ['--baseline', baseRef] : []

const gates: { id: string; script: string; args: string[] }[] = [
  { id: 'tree', script: 'verify-tree.ts', args: [] },
  { id: 'format', script: 'verify-format.ts', args: [] },
  { id: 'backlinks', script: 'verify-backlinks.ts', args: [] },
  { id: 'archive', script: 'seal-archive.ts', args: archiveArgs },
  { id: 'coverage', script: 'verify-coverage.ts', args: coverageArgs },
]

const failed: string[] = []
for (const gate of gates) {
  const result = spawnSync('npx', ['tsx', resolve(here, gate.script), ...forwarded(gate.args)], {
    cwd, stdio: 'inherit', env: process.env,
  })
  if (result.status !== 0) failed.push(gate.id)
}

if (failed.length > 0) {
  console.error('verify-agent-notes: FAILED — ' + failed.join(', '))
  process.exit(1)
}
console.log('verify-agent-notes: all gates passed (' + gates.map((gate) => gate.id).join(', ') + ')')