import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const report = require('../github/report.ts')
const {readReport, patchLines, marker} = require('../github/diagnostics.ts')
const sha = 'a'.repeat(40)

/**
 * Verify advisory comments against GitHub API behavior
 * .agents/notes/implemented/process/2026-10-08-agent-notes-advisory-comments.md
 */
function fixture(t: any) {
  const original = process.cwd()
  const directory = mkdtempSync(join(tmpdir(), 'notes-report-'))
  process.chdir(directory)
  mkdirSync('.agent-notes-report')
  t.after(() => { process.chdir(original); rmSync(directory, {recursive: true, force: true}) })
  const data: any = {version: 2, ok: false, head: sha, issues: [
    {path: 'src/a.py', line: 3, rule: 'code-only-diff', severity: 'review', message: '@team must review <script>', related: []},
  ]}
  const save = () => writeFileSync('.agent-notes-report/agent-notes-report.json', JSON.stringify(data))
  save()
  const calls: any[] = [], warnings: string[] = []
  const pr = {state: 'open', number: 3, head: {sha}, base: {sha: 'b'.repeat(40), repo: {full_name: 'owner/repo'}}}
  const state: any = {files: [{filename: 'src/a.py', status: 'modified',
    patch: '@@ -2,2 +2,2 @@\n context\n-old\n+new'}], reviews: [], summaries: [], commit: [], rejected: []}
  const api = (kind: string) => async (args: any) => {
    calls.push({kind, ...args})
    if (state.rejected.includes(kind)) throw new Error('permission or invalid diff')
    return {data: {}}
  }
  const list = (values: () => any[]) => async () => ({data: values()})
  const github = {
    paginate: async (method: any) => (await method()).data,
    rest: {
      pulls: {get: async () => ({data: pr}), listFiles: list(() => state.files),
        listReviewComments: list(() => state.reviews), createReviewComment: api('review-create'),
        updateReviewComment: api('review-update')},
      repos: {listPullRequestsAssociatedWithCommit: async () => ({data: [pr]}),
        getCommit: async () => ({data: {files: state.files, parents: [{sha: 'b'.repeat(40)}]}}),
        listCommentsForCommit: list(() => state.commit), createCommitComment: api('commit-create'),
        updateCommitComment: api('commit-update')},
      issues: {listComments: list(() => state.summaries), createComment: api('pr-create'), updateComment: api('pr-update')},
    },
  }
  const context: any = {repo: {owner: 'owner', repo: 'repo'}, serverUrl: 'https://github.com',
    payload: {workflow_run: {event: 'pull_request', head_sha: sha, html_url: 'https://github.com/owner/repo/actions/runs/1'}}}
  const invoke = () => report({github, context, core: {info() {}, warning(text: string) { warnings.push(text) }}})
  return {data, save, calls, warnings, pr, state, context, invoke}
}

test('PR findings attach to exact lines and update existing bot comments', async t => {
  const f = fixture(t)
  await f.invoke()
  const comment = f.calls[0]
  assert.equal(comment.kind, 'review-create')
  assert.equal(comment.path, 'src/a.py')
  assert.equal(comment.line, 3)
  assert.equal(comment.side, 'RIGHT')
  assert.equal(comment.commit_id, sha)
  assert.ok(!('position' in comment))
  assert.ok(comment.body.includes(`/blob/${sha}/src/a.py#L3`))
  assert.ok(!comment.body.includes('@team'))
  f.state.reviews = [{id: 7, user: {login: 'github-actions[bot]'}, body: comment.body}]
  await f.invoke()
  assert.equal(f.calls[1].kind, 'review-update')
  assert.equal(f.calls[1].comment_id, 7)
})

test('findings on the same code location are grouped', async t => {
  const f = fixture(t)
  f.data.issues.push({...f.data.issues[0], rule: 'reverse-edge'})
  f.save()
  await f.invoke()
  assert.equal(f.calls.length, 1)
  assert.ok(f.calls[0].body.includes('reverse-edge'))
})

test('missing backlink diagnostics attach to their related code', async t => {
  const f = fixture(t)
  f.data.issues = [{path: '.agents/notes/' + 'example.md', line: 9, rule: 'anchor-cardinality',
    severity: 'error', message: 'Missing anchor', related: ['src/a.py']}]
  f.save()
  await f.invoke()
  assert.equal(f.calls[0].path, 'src/a.py')
  assert.equal(f.calls[0].kind, 'review-create')
})

test('deleted source receives a LEFT review comment', async t => {
  const f = fixture(t)
  f.state.files = [{filename: 'src/a.py', status: 'removed', patch: '@@ -3,1 +2,0 @@\n-old'}]
  await f.invoke()
  assert.equal(f.calls[0].side, 'LEFT')
  assert.equal(f.calls[0].line, 3)
  assert.ok(f.calls[0].body.includes(`/blob/${f.pr.base.sha}/src/a.py#L3`))
})

test('renamed source retains an exact review location', async t => {
  const f = fixture(t)
  f.state.files[0].previous_filename = 'src/old.py'
  f.data.issues[0].path = 'src/old.py'
  f.save()
  await f.invoke()
  assert.equal(f.calls[0].path, 'src/a.py')
  assert.equal(f.calls[0].side, 'LEFT')
  assert.ok(f.calls[0].body.includes(`/blob/${f.pr.base.sha}/src/old.py#L3`))
})

test('PR file comments handle unavailable patches', async t => {
  const f = fixture(t)
  delete f.state.files[0].patch
  await f.invoke()
  assert.equal(f.calls[0].kind, 'review-create')
  assert.equal(f.calls[0].subject_type, 'file')
  assert.ok(!('line' in f.calls[0]))
})

test('push findings create and update positioned commit comments', async t => {
  const f = fixture(t)
  f.context.payload.workflow_run.event = 'push'
  await f.invoke()
  assert.equal(f.calls[0].kind, 'commit-create')
  assert.equal(f.calls[0].path, 'src/a.py')
  assert.equal(f.calls[0].position, 3)
  f.state.commit = [{id: 8, user: {login: 'github-actions[bot]'}, body: f.calls[0].body}]
  await f.invoke()
  assert.equal(f.calls[1].kind, 'commit-update')
})

test('inline rejection falls back to a summary without failing', async t => {
  const f = fixture(t)
  f.state.rejected = ['review-create']
  await assert.doesNotReject(f.invoke)
  assert.deepEqual(f.calls.map(call => call.kind), ['review-create', 'pr-create'])
  assert.equal(f.warnings.length, 1)
  f.state.rejected.push('pr-create')
  await assert.doesNotReject(f.invoke)
  assert.ok(f.warnings.length > 1)
})

test('unmapped findings update a single summary comment', async t => {
  const f = fixture(t)
  f.state.files = []
  await f.invoke()
  assert.equal(f.calls[0].kind, 'pr-create')
  f.state.summaries = [{id: 6, user: {login: 'github-actions[bot]'}, body: f.calls[0].body}]
  await f.invoke()
  assert.equal(f.calls[1].kind, 'pr-update')
})

test('successful reports and stale PR heads publish nothing', async t => {
  const f = fixture(t)
  f.pr.head.sha = 'b'.repeat(40)
  await f.invoke()
  assert.equal(f.calls.length, 0)
  f.pr.head.sha = sha
  f.data.ok = true
  f.data.issues = []
  f.save()
  await f.invoke()
  assert.equal(f.calls.length, 0)
})

test('missing artifacts yield a diagnostic summary', async t => {
  const f = fixture(t)
  unlinkSync('.agent-notes-report/agent-notes-report.json')
  await f.invoke()
  assert.equal(f.calls[0].kind, 'pr-create')
  assert.ok(f.calls[0].body.includes('missing-report'))
})

test('untrusted reports are rejected and do not fail the reporter', async t => {
  const f = fixture(t)
  for (const change of [
    () => { f.data.head = 'c'.repeat(40) },
    () => { f.data.head = undefined },
    () => { f.data.head = sha; f.data.issues[0].path = '../escape.py' },
    () => { f.data.issues[0].path = 'src/a.py'; f.data.issues[0].line = 0 },
    () => { f.data.issues[0].line = 3; f.data.issues[0].related = ['../bad.py'] },
    () => { f.data.issues[0].related = []; f.data.issues[0].severity = 'ignored' },
  ]) {
    change(); f.save()
    assert.throws(() => readReport(sha))
    await assert.doesNotReject(f.invoke)
    assert.equal(f.calls.length, 0)
  }
  assert.equal(f.warnings.length, 6)
})

test('many findings at one location retain counts and bounded detail', async t => {
  const f = fixture(t)
  f.data.issues = Array.from({length: 45}, (_, i) => ({...f.data.issues[0], line: i + 1,
    related: ['.agents/notes/' + 'example.md']}))
  f.save()
  await f.invoke()
  assert.equal(f.calls.length, 1)
  assert.ok(f.calls[0].body.includes('45 项待审核'))
  assert.ok(f.calls[0].body.includes('其余 37 项'))
})

test('diff positions count later hunk headers and removed lines', () => {
  const rows = patchLines('@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-c\n+d')
  assert.deepEqual(rows.at(-1), {line: 10, side: 'RIGHT', position: 5})
  assert.notEqual(marker('src/a.py:RIGHT:3'), marker('src/a.py:LEFT:3'))
})

test('full and diff reports retain separate comments at the same code location', async t => {
  const f = fixture(t)
  await f.invoke()
  f.state.reviews = [{id: 7, user: {login: 'github-actions[bot]'}, body: f.calls[0].body}]
  f.context.payload.workflow_run.name = 'Agent Notes Full'
  await f.invoke()
  assert.equal(f.calls[1].kind, 'review-create')
})

test('push comments locate files past the first commit API page', async t => {
  const f = fixture(t)
  f.context.payload.workflow_run.event = 'push'
  const target = f.state.files[0]
  const pages: number[] = []
  f.state.files = Array.from({length: 100}, (_, i) => ({filename: `other/${i}.py`}))
  const githubMethod = require('../github/report.ts')
  const github: any = {paginate: async () => [], rest: {repos: {
    getCommit: async ({page}: any) => { pages.push(page); return {data: {files: page === 1 ? f.state.files : [target]}} },
    listCommentsForCommit() {}, createCommitComment: async (args: any) => { f.calls.push(args) },
  }}}
  await githubMethod({github, context: f.context, core: {info() {}, warning() {}}})
  assert.deepEqual(pages, [1, 2])
  assert.equal(f.calls[0].path, 'src/a.py')
})

test('reporter loads in projects that use ESM', t => {
  fixture(t)
  writeFileSync('package.json', '{"type":"module"}')
  const target = '.agents/skills/hx-agent-notes/scripts/github'
  mkdirSync(target, {recursive: true})
  for (const name of ['report.ts', 'diagnostics.ts', 'package.json']) {
    copyFileSync(new URL(`../github/${name}`, import.meta.url), `${target}/${name}`)
  }
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e',
    `if (typeof require('./${target}/report.ts') !== 'function') process.exit(1)`], {encoding: 'utf8'})
  assert.equal(result.status, 0, result.stderr)
})

test('deleted files outside the latest commit use the exact comparison base', async t => {
  const f = fixture(t)
  f.context.payload.workflow_run.event = 'push'
  f.data.base_commit = 'c'.repeat(40)
  f.data.deleted = ['src/a.py']
  f.state.files = []
  f.save()
  await f.invoke()
  assert.ok(f.calls[0].body.includes(`/blob/${f.data.base_commit}/src/a.py#L3`))
})

test('push summaries explain the full range and prioritize errors after review findings', async t => {
  const f = fixture(t)
  f.context.payload.workflow_run.event = 'push'
  f.data.mode = 'diff'
  f.data.base_commit = 'c'.repeat(40)
  const error = {...f.data.issues[0], severity: 'error', rule: 'anchor-cardinality'}
  f.data.issues = Array.from({length: 50}, (_, i) => ({...f.data.issues[0], path: `assets/${i}.md`, rule: 'resource-review'}))
  f.data.issues.push(error)
  f.save()
  await f.invoke()
  const inline = f.calls.find(call => call.path === 'src/a.py')
  assert.ok(inline.body.includes('1 项错误, 0 项待审核'))
  const summary = f.calls.find(call => !call.path)
  assert.ok(summary.body.includes('0 项错误, 50 项待审核'))
  assert.ok(summary.body.includes(`/compare/${f.data.base_commit}...${sha}`))
  assert.ok(summary.body.includes('resource-review: 50'))
  assert.ok(summary.body.includes('其余 42 项'))
  assert.ok(!summary.body.includes('assets/49.md'))
  const original = JSON.parse(require('node:fs').readFileSync('.agent-notes-report/agent-notes-report.json', 'utf8'))
  assert.equal(original.issues.length, 51)
  assert.equal(original.issues.at(-1).severity, 'error')
})
