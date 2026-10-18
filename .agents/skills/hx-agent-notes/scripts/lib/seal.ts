/**
 * Seal verification: prove the frozen archive is byte-identical to its manifest.
 *
 * Legacy archive browsing; current decisions use the v2 graph.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type LoadedNotes } from './config.ts'
import { manifestPathFor, readManifest, renderManifest, sha256File } from './manifest.ts'
import { filesUnder } from './tree.ts'

/** The date-stamped seal line every archived note carries below its status. */
export const ARCHIVED_LINE_RE = /^Archived: \d{4}-\d{2}-\d{2}$/

/**
 * Verify the frozen archive: known kind folders, one seal line per archived note,
 * and every artifact byte-identical to its manifest hash. An unsealed artifact is
 * a violation unless the caller is sealing it (write mode).
 */
export function verifyArchive(loaded: LoadedNotes, writeMode: boolean): string[] {
  const { notesRoot, config } = loaded
  const archiveRoot = join(notesRoot, config.archive)
  const errors: string[] = []
  const added: string[] = []
  if (!existsSync(archiveRoot)) return errors
  const { manifest, error } = readManifest(loaded)
  if (error !== null) errors.push('archive: ' + error)
  const artifacts: Record<string, string> = {}
  for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
    if (entry.isFile()) {
      if (!['AGENTS.md', 'manifest.json'].includes(entry.name)) {
        errors.push('archive: ' + entry.name + ' — unexpected root file')
      }
      continue
    }
    if (!config.classes.includes(entry.name)) {
      errors.push('archive: ' + entry.name + '/ — unknown class folder')
      continue
    }
    for (const rel of filesUnder(join(archiveRoot, entry.name), loaded.gitRoot)) {
      const key = entry.name + '/' + rel
      const full = join(archiveRoot, entry.name, rel)
      artifacts[key] = sha256File(full)
      if (rel.endsWith('.md') && !config.translationSuffixes.some((suffix) => rel.endsWith(suffix))) {
        const lines = readFileSync(full, 'utf8').split('\n')
        if (!lines.slice(0, 6).some((line) => ARCHIVED_LINE_RE.test(line.trim()))) {
          errors.push('archive: ' + key + ' — missing the Archived: YYYY-MM-DD seal line below Status')
        }
      }
    }
  }
  for (const [key, hash] of Object.entries(artifacts)) {
    const sealed = manifest.files[key]
    if (sealed === undefined) {
      if (writeMode) added.push(key)
      else errors.push('archive: ' + key + ' — not sealed in manifest.json (run the archive script, or seal with --write)')
      continue
    }
    if (sealed !== hash) {
      errors.push('archive: ' + key + ' — content changed after sealing; archived notes are frozen, restore the sealed bytes')
    }
  }
  for (const key of Object.keys(manifest.files)) {
    if (artifacts[key] === undefined) errors.push('archive: ' + key + ' — sealed artifact is missing')
  }
  if (writeMode && added.length > 0 && errors.length === 0) {
    for (const key of added) manifest.files[key] = artifacts[key] as string
    mkdirSync(dirname(manifestPathFor(loaded)), { recursive: true })
    writeFileSync(manifestPathFor(loaded), renderManifest(manifest.files))
  }
  return errors
}