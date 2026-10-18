const {readReport, marker, body, locate, notePaths} = require('./diagnostics.ts')

const owned = (comment: any, tag: string) => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(tag)

async function commitFiles(github: any, params: any, head: string) {
  const files: any[] = []
  let base: string | undefined
  for (let page = 1; page <= 30; page++) {
    const response = await github.rest.repos.getCommit({...params, ref: head, per_page: 100, page})
    if (page === 1) base = response.data.parents?.[0]?.sha
    const batch = response.data.files || []
    files.push(...batch)
    if (batch.length < 100) break
  }
  return {files, base}
}

async function publish({github, context, core}: any, run: any, data: any, pr?: any) {
  const params = {...context.repo}
  const diff = pr
    ? {files: await github.paginate(github.rest.pulls.listFiles, {...params, pull_number: pr.number}), base: pr.base.sha}
    : await commitFiles(github, params, run.head_sha)
  const {files} = diff
  const issues = [...data.issues].sort((a: any, b: any) =>
    Number(b.severity === 'error') - Number(a.severity === 'error'))
  const links = {files, base: data.base_commit || diff.base, deleted: data.deleted, mode: data.mode}
  const existing = pr
    ? await github.paginate(github.rest.pulls.listReviewComments, {...params, pull_number: pr.number})
    : await github.paginate(github.rest.repos.listCommentsForCommit, {...params, commit_sha: run.head_sha})
  const groups = new Map<string, {location: any, issues: any[]}>()
  for (const issue of issues) {
    const location = locate(issue, files)
    const notes = notePaths(issue)
    const key = notes.length ? `notes:${notes.join('|')}`
      : location ? `${location.path}:${location.side || 'file'}:${location.line || 0}` : 'summary'
    const group = groups.get(key) || {location, issues: []}
    if (!group.location || (group.location.subject_type === 'file' && location?.subject_type === 'line')) {
      group.location = location || group.location
    }
    group.issues.push(issue)
    groups.set(key, group)
  }
  const fallback: any[] = []
  let inline = 0
  for (const [key, group] of groups) {
    if (!group.location || (!pr && group.location.subject_type === 'file') || inline >= 40) {
      fallback.push(...group.issues)
      continue
    }
    inline++
    const identity = `${run.name || 'Agent Notes Diff'}:${key}`
    const tag = marker(identity)
    const text = body(context, run, group.issues, identity, {...links, limit: 8})
    const prior = existing.find((comment: any) => owned(comment, tag))
    try {
      if (pr) {
        if (prior) await github.rest.pulls.updateReviewComment({...params, comment_id: prior.id, body: text})
        else {
          const {position, ...location} = group.location
          await github.rest.pulls.createReviewComment({...params, pull_number: pr.number,
            commit_id: run.head_sha, ...location, body: text})
        }
      } else {
        if (prior) await github.rest.repos.updateCommitComment({...params, comment_id: prior.id, body: text})
        else await github.rest.repos.createCommitComment({...params, commit_sha: run.head_sha,
          path: group.location.path, position: group.location.position, body: text})
      }
    } catch (error: any) {
      core.warning(`无法在 ${group.location.path} 发布评论: ${error.message}`)
      fallback.push(...group.issues)
    }
  }
  if (fallback.length) {
    const key = `${run.name || 'Agent Notes Diff'}:summary`
    const text = body(context, run, fallback, key, {...links, limit: 8})
    if (pr) {
      const comments = await github.paginate(github.rest.issues.listComments, {...params, issue_number: pr.number})
      const prior = comments.find((comment: any) => owned(comment, marker(key)))
      if (prior) await github.rest.issues.updateComment({...params, comment_id: prior.id, body: text})
      else await github.rest.issues.createComment({...params, issue_number: pr.number, body: text})
    } else {
      const prior = existing.find((comment: any) => owned(comment, marker(key)))
      if (prior) await github.rest.repos.updateCommitComment({...params, comment_id: prior.id, body: text})
      else await github.rest.repos.createCommitComment({...params, commit_sha: run.head_sha, body: text})
    }
  }
}

/**
 * Publish findings beside code while keeping the workflow successful
 * .agents/notes/implemented/process/2026-10-08-agent-notes-advisory-comments.md
 */
module.exports = async function report({github, context, core}: any) {
  try {
    const run = context.payload.workflow_run
    if (!['push', 'pull_request'].includes(run.event)) throw new Error('不支持的扫描触发事件')
    let data: any
    try {
      data = readReport(run.head_sha)
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
      data = {issues: [{path: '.agents/notes.config.json', line: 1, rule: 'missing-report',
        severity: 'error', message: '扫描未产生诊断附件, 请查看扫描工作流日志', related: []}]}
    }
    if (!data.issues.length) return
    if (run.event === 'pull_request') {
      const associated = await github.rest.repos.listPullRequestsAssociatedWithCommit({
        ...context.repo, commit_sha: run.head_sha})
      for (const entry of associated.data) {
        const pr = (await github.rest.pulls.get({...context.repo, pull_number: entry.number})).data
        if (pr.state !== 'open' || pr.head.sha !== run.head_sha ||
            pr.base.repo.full_name !== `${context.repo.owner}/${context.repo.repo}`) continue
        await publish({github, context, core}, run, data, pr)
      }
    } else await publish({github, context, core}, run, data)
    core.info('Agent Notes 审核评论已发布')
  } catch (error: any) {
    core.warning(`Agent Notes 报告不可用: ${error.message}`)
  }
}
