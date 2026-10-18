import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const report = require('../../github/report.ts')
const {body} = require('../../github/diagnostics.ts')
const head = 'a'.repeat(40)
const note = '.agents/notes/' + 'implemented/process/example.md'
const context: any = {repo: {owner: 'owner', repo: 'repo'}, serverUrl: 'https://github.com',
  payload: {workflow_run: {event: 'push', head_sha: head, html_url: 'https://github.com/run'}}}

/**
 * Verify decision groups preserve source locations and publication identity
 * .agents/notes/implemented/process/2026-10-08-agent-notes-advisory-comments.md
 */
function issues() {
  return ['src/a.ts', 'src/b.ts'].map(path => ({path, line: 3, severity: 'review',
    rule: 'code-only-diff', message: '请审核', related: [note]}))
}

test('Markdown groups multiple source files under one decision with exact diagnostic locations', () => {
  const entries = issues()
  entries.push({...entries[0], path: note, line: 12, related: ['src/a.ts'], rule: 'anchor-cardinality'})
  const text = body(context, context.payload.workflow_run, entries, 'test')
  assert.equal(text.split(`[${note}:1]`).length - 1, 1)
  assert.ok(text.includes(`\n\n- [src/a.ts:3]`))
  assert.ok(text.includes(`- [src/b.ts:3]`))
  assert.ok(text.includes(`${note}#L12`))
  assert.ok(text.includes('anchor-cardinality'))
})

test('unassociated resources remain separate and deleted decisions use the base revision', () => {
  const entry = {...issues()[0], path: 'docs/help.md', related: []}
  const text = body(context, context.payload.workflow_run, [...issues(), entry], 'test',
    {deleted: [note], base: 'b'.repeat(40)})
  assert.ok(text.includes('未关联决策文件'))
  assert.ok(text.includes('- [docs/help.md:3]'))
  assert.ok(text.includes(`/blob/${'b'.repeat(40)}/${note}#L1`))
})

test('one decision creates one commit comment and updates it when the representative source changes', async t => {
  const previous = process.cwd()
  const directory = mkdtempSync(join(tmpdir(), 'notes-group-'))
  process.chdir(directory)
  t.after(() => {process.chdir(previous); rmSync(directory, {recursive: true, force: true})})
  mkdirSync('.agent-notes-report')
  writeFileSync('.agent-notes-report/agent-notes-report.json', JSON.stringify({version: 2, ok: false,
    head, issues: issues()}))
  let files = issues().map(issue => ({filename: issue.path, patch: '@@ -3 +3 @@\n-old\n+new'}))
  const existing: any[] = [], calls: any[] = [], warnings: string[] = []
  const github: any = {paginate: async () => existing, rest: {repos: {
    getCommit: async () => ({data: {files}}), listCommentsForCommit() {},
    createCommitComment: async (value: any) => {calls.push(value)},
    updateCommitComment: async (value: any) => {calls.push(value)},
  }}}
  const invoke = () => report({github, context, core: {info() {}, warning(value: string) {warnings.push(value)}}})
  await invoke()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].body.includes('src/a.ts:3') && calls[0].body.includes('src/b.ts:3'))
  existing.push({id: 7, user: {login: 'github-actions[bot]'}, body: calls[0].body})
  files = files.slice(1)
  await invoke()
  assert.equal(calls[1].comment_id, 7)
  assert.deepEqual(warnings, [])
})
