const fs = require('node:fs')
const {createHash} = require('node:crypto')

const ROOT = '<!-- agent-notes:'
const safePath = (value: unknown): value is string => typeof value === 'string' && !!value &&
  !value.startsWith('-') && !/[\\\n\r\t`#?*{}\[\]]/.test(value) &&
  value.split('/').every(part => !['', '.', '..'].includes(part))
const escape = (value: unknown) => String(value).replace(/[\r\n]/g, ' ').replace(/@/g, '@\u200b')
  .replace(/[\[\]<>`*_]/g, '\\$&').slice(0, 800)

function readReport(head: string) {
  const path = '.agent-notes-report/agent-notes-report.json'
  if (fs.statSync(path).size > 2_000_000) throw new Error('报告超过大小限制')
  const data = JSON.parse(fs.readFileSync(path, 'utf8'))
  if (!/^[a-f0-9]{40}$/.test(head) || data.head !== head) throw new Error('报告与当前提交不匹配')
  if (data.version !== 2 || typeof data.ok !== 'boolean' || !Array.isArray(data.issues) ||
      data.ok !== (data.issues.length === 0)) throw new Error('报告格式或结果无效')
  if (data.base_commit && !/^[a-f0-9]{40}$/.test(data.base_commit)) throw new Error('基线提交无效')
  if (data.deleted && (!Array.isArray(data.deleted) || !data.deleted.every(safePath))) throw new Error('已删除路径无效')
  for (const issue of data.issues) {
    if (!safePath(issue.path) || (issue.related && (!Array.isArray(issue.related) || !issue.related.every(safePath)))) {
      throw new Error('诊断路径无效')
    }
    if (!Number.isSafeInteger(issue.line) || issue.line < 1) throw new Error('诊断行号无效')
    if (typeof issue.rule !== 'string' || typeof issue.message !== 'string' ||
        !['error', 'review'].includes(issue.severity)) throw new Error('诊断内容或级别无效')
  }
  return data
}

function marker(key: string) {
  return `${ROOT}${createHash('sha256').update(key).digest('hex').slice(0, 24)} -->`
}

function permalink(context: any, head: string, path: string, line: number) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/blob/${head}/${encoded}#L${line}`
}

function notePaths(issue: any): string[] {
  return [...new Set<string>([issue.path, ...(issue.related || [])]
    .filter((path: string) => path.startsWith('.agents/notes/') && path.endsWith('.md')))].sort()
}

function groupedLines(issues: any[], reference: (path: string, line: number) => string) {
  const groups = new Map<string, Map<string, Set<string>>>()
  for (const issue of issues) {
    const notes = notePaths(issue)
    const paths: string[] = [...new Set<string>([issue.path, ...(issue.related || [])])]
    for (const note of notes.length ? notes : ['']) {
      const files = groups.get(note) || new Map<string, Set<string>>()
      const targets = paths.filter(path => !notes.includes(path))
      const level = issue.severity === 'error' ? '错误' : '待审核'
      const detail = `${level} ${escape(issue.rule)}: ${escape(issue.message)}`
      for (const path of targets.length ? targets : [issue.path]) {
        const target = path
        const entries = files.get(target) || new Set<string>()
        const origin = ` (诊断: ${reference(issue.path, issue.line)})`
        entries.add(detail + origin)
        files.set(target, entries)
      }
      groups.set(note, files)
    }
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([note, files]) => {
    const title = note ? reference(note, 1) : '未关联决策文件'
    const entries = [...files].sort(([a], [b]) => a.localeCompare(b))
      .map(([path, details]) => `- ${reference(path, issues.find(issue => issue.path === path)?.line || 1)}` +
        ` | ${[...details].join('; ')}`)
    return `${title}\n\n${entries.join('\n')}`
  }).join('\n\n')
}

function body(context: any, run: any, issues: any[], key: string, links: any = {}) {
  const errors = issues.filter(issue => issue.severity === 'error').length
  const reviews = issues.length - errors
  const compare = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/compare/${links.base}...${run.head_sha}`
  const scope = links.mode === 'diff' && links.base
    ? `检查范围: [${links.base.slice(0, 10)}..${run.head_sha.slice(0, 10)}](${compare}), 包含这次 push 或 PR 比较范围内的全部提交`
    : links.mode === 'all' ? `检查范围: ${run.head_sha.slice(0, 10)} 的完整快照` : ''
  const limit = links.limit ?? issues.length
  const reference = (path: string, line: number) => {
    const file = (links.files || []).find((file: any) => file.filename === path || file.previous_filename === path)
    const old = (links.deleted || []).includes(path) || file?.status === 'removed' ||
      (file?.previous_filename === path && file.filename !== path)
    const url = old && !links.base
      ? `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/commit/${run.head_sha}`
      : permalink(context, old ? links.base : run.head_sha, path, line)
    return `[${escape(path)}:${line}${old ? ' (删除前)' : ''}](${url})`
  }
  const lines = groupedLines(issues.slice(0, limit), reference)
  const counts = new Map<string, number>()
  for (const issue of issues) counts.set(issue.rule, (counts.get(issue.rule) || 0) + 1)
  const statistics = links.limit ? `\n\n规则统计: ${[...counts].map(([rule, count]) => `${escape(rule)}: ${count}`).join(', ')}` : ''
  const omitted = issues.length > limit ? `\n\n其余 ${issues.length - limit} 项见完整 JSON 诊断附件, 待审核提示不等于结构错误` : ''
  return `${marker(key)}\nAgent Notes: ${errors} 项错误, ${reviews} 项待审核` +
    (scope ? `\n\n${scope}` : '') + statistics + `\n\n${lines}` + omitted +
    `\n\n[完整诊断与运行日志](${run.html_url})`
}

function patchLines(patch: string = '') {
  let left = 0, right = 0, position = 0, started = false
  const lines: {line: number, side: string, position: number}[] = []
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      if (started) position++
      started = true
      left = Number(hunk[1]); right = Number(hunk[2])
      continue
    }
    if (!started) continue
    position++
    if (text.startsWith('+')) lines.push({line: right++, side: 'RIGHT', position})
    else if (text.startsWith('-')) lines.push({line: left++, side: 'LEFT', position})
    else if (text.startsWith(' ')) {
      lines.push({line: right++, side: 'RIGHT', position})
      left++
    }
  }
  return lines
}

function locate(issue: any, files: any[]) {
  const candidates = [issue.path, ...(issue.related || [])]
  const source = (path: string) => /\.(?:cpp|cc|cxx|h|hpp|ts|tsx|js|mjs|go|py|rs)$/.test(path)
  candidates.sort((a, b) => Number(source(b)) - Number(source(a)))
  for (const path of candidates) {
    const file = files.find(file => file.filename === path || file.previous_filename === path)
    if (!file) continue
    const side = file.status === 'removed' || (file.previous_filename === path && file.filename !== path) ? 'LEFT' : 'RIGHT'
    const rows = patchLines(file.patch).filter(row => row.side === side)
    const exact = path === issue.path ? rows.find(row => row.line === issue.line) : undefined
    const row = exact || (path === issue.path
      ? rows.reduce((nearest, row) => Math.abs(row.line - issue.line) < Math.abs(nearest.line - issue.line) ? row : nearest, rows[0])
      : rows[0])
    return {path: file.filename, ...(row || {}), subject_type: row ? 'line' : 'file'}
  }
  return null
}

module.exports = {readReport, marker, body, locate, patchLines, notePaths, ROOT}
