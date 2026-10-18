/**
 * Archive manifest: hashing, rendering, and the append-only proof against a trusted revision.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type LoadedNotes } from './config.ts'

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
