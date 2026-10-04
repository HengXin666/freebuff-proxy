import { t } from '../../i18n.js'
import { api } from '../../lib/api.js'
import { el, icon } from '../../lib/dom.js'
import { state } from '../../lib/state.js'
import { copyText, toast } from '../../lib/ui.js'


/** 日志页的视图状态(切走再回来保持筛选条件). */
const logsView = {
  level: 'all',
  q: '',
  account: '',
  auto: false,
  expanded: new Set(),
  timer: null,
  lines: [],
}

function logsLevelTone(level) {
  if (level === 'error') return 'err'
  if (level === 'warn') return 'warn'
  return ''
}

/**
 - 时间戳 → 人读的本地时间(MM-DD HH:mm:ss).
 *
 - 原样吐 ISO 串(2026-10-03T18:52:20.220Z)有两个毛病:它是 UTC,与用户
 - 本地墙钟差 8 小时;且一屏几十条里 T/Z 分隔符和毫秒全是噪音,扫读不出
 - "刚刚发生了什么".保留完整 ISO 在 title 里,鼠标悬停仍可看精确值.
 */
function logsTs(iso) {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return String(iso)
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 一条日志:默认只给 ts/level/msg,点开才给完整字段(避免一眼全是噪音). */
function buildLogRow(line, idx) {
  const key = (line.ts || '') + '|' + idx
  const open = logsView.expanded.has(key)
  const ts = logsTs(line.ts)
  const extra = { ...line }
  delete extra.ts
  delete extra.level
  delete extra.msg
  const hasExtra = Object.keys(extra).length > 0

  const row = el('div', { class: 'log-row' + (open ? ' open' : '') }, [
    el('button', {
      class: 'log-head',
      onclick: () => {
        if (open) logsView.expanded.delete(key)
        else logsView.expanded.add(key)
        renderLogsList()
      },
    }, [
      el('span', { class: 'log-ts' }, ts),
      el('span', { class: 'badge ' + logsLevelTone(line.level) }, line.level),
      //  账号 + 请求 id:此前日志里没有这两个维度,多账号池并发时几十条
      // 无主记录交织,排障只能靠猜.reqId 同时是聚合键(可用它筛选整条链路).
      //
      // 账号显示完整邮箱:此前写成 split('@')0,
      // 于是 a@gmail.com 与 a@outlook.com 在日志页上长得一模一样 ——
      // 多账号池里这直接把"哪个号出的问题"变成了猜谜.用户要的就是邮箱.
      line.account
        ? el('span', {
            class: 'badge',
            style: 'font-size:11px',
            title: t('logs.accountHint'),
            onclick: (e) => {
              e.stopPropagation()
              logsView.account = String(line.account)
              const sel = document.querySelector('#logs-account')
              if (sel) sel.value = logsView.account
              refreshLogs()
            },
          }, String(line.account))
        : null,
      line.reqId
        ? el('span', {
            class: 'badge muted',
            style: 'font-size:11px',
            title: t('logs.reqIdHint'),
            onclick: (e) => {
              e.stopPropagation()
              logsView.q = line.reqId
              const input = document.querySelector('#logs-search')
              if (input) input.value = line.reqId
              refreshLogs()
            },
          }, '#' + line.reqId)
        : null,
      el('span', { class: 'log-msg' }, line.msg || ''),
      hasExtra ? el('span', { class: 'muted', style: 'font-size:11px' }, open ? '▾' : '▸') : null,
    ].filter(Boolean)),
    open && hasExtra
      ? el('div', { class: 'log-body' }, [
          el('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:6px' }, [
            el('button', {
              class: 'muted',
              style: 'font-size:11px',
              onclick: (e) => {
                e.stopPropagation()
                copyText(JSON.stringify(line, null, 2))
              },
            }, [icon('copy', 11), t('logs.copyJson')]),
          ]),
          el('pre', { class: 'log-pre' }, JSON.stringify(extra, null, 2)),
        ])
      : null,
  ].filter(Boolean))
  return row
}

function renderLogsList() {
  const host = document.querySelector('#logs-list')
  if (!host) return
  const lines = logsView.lines
  if (!lines.length) {
    host.innerHTML = ''
    host.append(el('div', { class: 'muted', style: 'padding:14px' },
      t('logs.empty')))
    return
  }
  host.innerHTML = ''
  // 新的在前:排障时关心的是刚刚发生了什么
  for (let i = lines.length - 1; i >= 0; i--) {
    host.append(buildLogRow(lines[i], i))
  }
}

/**
 - 导出当前筛选结果(.jsonl 下载).
 *
 - 为什么(用户实测诉求):排障要把日志交给别人分析,而进程内缓冲只有一个
 - 可滚动页面 —— 复制几行就丢上下文(多账号池并发时几十条交织).导出把
 - 当前筛选条件下的完整条目一次性落成文件:按账号筛完再导出,
 - 就得到那个账号的独立日志.
 *
 - 导出的是 logsView.lines(当前已加载的),与页面所见严格一致;
 - 每行一个 JSON 对象(jsonl),人能读,jq 也能直接消费.
 - 文件名带上筛选条件,避免多份导出混淆.
 */
function exportLogs() {
  const lines = logsView.lines || []
  if (!lines.length) {
    toast(t('logs.exportEmpty'), true)
    return
  }
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  const parts = ['freebuff-logs']
  if (logsView.account) parts.push(String(logsView.account).replace(/[^\w.@-]/g, '_'))
  if (logsView.level && logsView.level !== 'all') parts.push(logsView.level)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `${parts.join('_')}_${stamp}.jsonl`
  const blob = new Blob([body], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  // 释放对象 URL:不释放会一直占着内存(长时间开着日志页反复导出会累积)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast(t('logs.exported', { n: lines.length, name }))
}

async function refreshLogs() {
  const q = new URLSearchParams({ level: logsView.level, limit: '300' })
  if (logsView.q.trim()) q.set('q', logsView.q.trim())
  // 账号维度:后端已支持 account= 过滤(src/util/log.js readLogBuffer),
  // 此前前端从未传过 —— 多账号池下"只看某个号"只能靠在搜索框里手打邮箱.
  if (logsView.account) q.set('account', logsView.account)
  let data = null
  try { data = await api('/api/logs?' + q.toString()) } catch { return }
  logsView.lines = data?.lines || []
  renderLogsList()
  const meta = document.querySelector('#logs-meta')
  if (meta) {
    meta.textContent = t('logs.meta', {
      n: logsView.lines.length,
      time: logsTs(data?.serverTime),
    })
  }
}

function stopLogsAuto() {
  if (logsView.timer) {
    clearInterval(logsView.timer)
    logsView.timer = null
  }
}

export async function renderLogs(view) {
  view.innerHTML = ''
  view.append(el('h2', { style: 'margin:0 0 12px' }, t('nav.logs')))

  const card = el('div', { class: 'card' })
  card.append(el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('logs.inProcessTitle')),
      el('span', { class: 'muted', id: 'logs-meta' }, t('common.loading')),
    ]),
    el('div', { class: 'row' }, [
      el('button', {
        class: logsView.auto ? '' : 'muted',
        id: 'logs-auto-btn',
        onclick: () => {
          logsView.auto = !logsView.auto
          const btn = document.querySelector('#logs-auto-btn')
          if (btn) {
            btn.className = logsView.auto ? '' : 'muted'
            btn.textContent = logsView.auto ? t('logs.stopAuto') : t('logs.auto')
          }
          if (logsView.auto) {
            stopLogsAuto()
            logsView.timer = setInterval(() => refreshLogs(), 3000)
          } else {
            stopLogsAuto()
          }
        },
      }, [icon('refresh', 13), logsView.auto ? t('logs.stopAuto') : t('logs.auto')]),
      el('button', { class: 'muted', onclick: () => refreshLogs() }, [icon('refresh', 13), t('common.refresh')]),
      /**
       - 导出当前筛选结果(.jsonl 下载).
       *
       - 为什么必须有(用户实测诉求):排障需要把日志交给别人分析,而
       - 进程内缓冲只有一个可滚动的页面 —— 复制几行就丢上下文(多账号池
       - 并发时几十条交织).导出把当前筛选条件下的完整条目一次性落成
       - 文件:按账号筛完再导出,就是那个账号的独立日志.
       *
       - 导出的是 logsView.lines(当前已加载的),与页面所见严格一致 ——
       - 不用"导出全部"这种会让用户意外的东西.每行一个 JSON 对象(jsonl),
       - 既是人能读的文本,也能被 jq / 脚本直接消费.
       */
      el('button', {
        class: 'muted',
        id: 'logs-export-btn',
        title: t('logs.exportTitle'),
        onclick: () => exportLogs(),
      }, [icon('download', 13), t('logs.export')]),
      /**
       - 清空缓冲:环形缓冲会自动丢最旧的,但用户想"从现在起只看新的"时
       - 旧条目仍占满整页(一次故障刷出几百条后新日志被挤到最底下).
       - 没有这个按钮就只能重启进程,而重启会连带丢掉热会话现场.
       - 只清内存里的日志缓冲,不动任何落盘数据.
       */
      el('button', {
        class: 'danger',
        id: 'logs-clear-btn',
        onclick: async () => {
          if (!confirm(t('logs.clearConfirm'))) return
          try {
            await api('/api/logs', { method: 'DELETE' })
            logsView.lines = []
            logsView.expanded.clear()
            renderLogsList()
            toast(t('logs.cleared'))
          } catch (err) {
            toast(err.message, true)
          }
        },
      }, [icon('trash', 13), t('logs.clear')]),
    ]),
  ]))

  // 筛选条:级别 + 关键词(关键词直接命中完整 JSON,含上游原始字段)
  const levelSel = el('select', {
    id: 'logs-level',
    onchange: (e) => { logsView.level = e.target.value; refreshLogs() },
  }, [
    ['all', t('logs.levelAll')],
    ['info', t('logs.levelInfo')],
    ['warn', t('logs.levelWarn')],
    ['error', t('logs.levelError')],
  ].map(([v, label]) => el('option', { value: v, selected: logsView.level === v ? 'selected' : null }, label)))

  /**
   - 账号筛选下拉:选项直接取账号池的邮箱.
   *
   - 为什么不是"填关键词":日志里的 account 字段就是邮箱,但用户得先知道
   - 拼法才能搜;而账号池是他自己导入的,下拉里点一下即可.
   - 还额外并入缓冲里出现过的账号 —— 有些日志来自已删除/尚未刷进
   - state.accounts 的号,只按账号池建选项会漏掉它们.
   */
  const accountOptions = [['', t('logs.accountAll')]]
  const seen = new Set()
  for (const a of state.accounts || []) {
    const email = String(a?.email || '').trim()
    if (email && !seen.has(email)) {
      seen.add(email)
      accountOptions.push([email, email])
    }
  }
  for (const line of logsView.lines) {
    const email = String(line?.account || '').trim()
    if (email && !seen.has(email)) {
      seen.add(email)
      accountOptions.push([email, email])
    }
  }
  const accountSel = el('select', {
    id: 'logs-account',
    onchange: (e) => { logsView.account = e.target.value; refreshLogs() },
  }, accountOptions.map(([v, label]) =>
    el('option', { value: v, selected: logsView.account === v ? 'selected' : null }, label)))

  const searchInput = el('input', {
    id: 'logs-q',
    placeholder: t('logs.searchPlaceholder'),
    value: logsView.q,
    oninput: (e) => { logsView.q = e.target.value },
    onkeydown: (e) => { if (e.key === 'Enter') refreshLogs() },
  })

  card.append(el('div', { class: 'row', style: 'margin-top:10px;gap:8px;flex-wrap:wrap' }, [
    levelSel,
    accountSel,
    searchInput,
    el('button', { onclick: () => refreshLogs() }, [icon('search', 13), t('common.search')]),
    el('button', {
      class: 'muted',
      onclick: () => {
        logsView.q = ''
        logsView.level = 'all'
        logsView.account = ''
        logsView.expanded.clear()
        const inp = document.querySelector('#logs-q')
        if (inp) inp.value = ''
        const sel = document.querySelector('#logs-level')
        if (sel) sel.value = 'all'
        const asel = document.querySelector('#logs-account')
        if (asel) asel.value = ''
        refreshLogs()
      },
    }, t('logs.clearFilters')),
  ]))

  card.append(el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
    t('logs.expandHint')))

  card.append(el('div', { id: 'logs-list', class: 'logs-list' }))
  view.append(card)
  await refreshLogs()
}
