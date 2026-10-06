import { t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { el, icon } from '../../lib/dom.ts'
import { state } from '../../lib/state.ts'
import { copyText, toast } from '../../lib/ui.ts'

/** 日志页的视图状态(切走再回来保持筛选条件). */
const logsView: any = {
  level: 'all',
  q: '',
  account: '',
  auto: false,
  expanded: new Set(),
  timer: null,
  lines: [],
}

/**
 * 颗粒度/事件类型徽标.
 * @param {any} line 一条日志
 * @returns {any} 徽标节点或 null
 */
function kindBadge(line: any) {
  if (line.kind === 'request') {
    return el('span', { class: 'badge', style: 'font-size:11px', title: t('logs.kindHint') },
      t('logs.kindRequest'))
  }
  if (line.event) {
    return el('span', { class: 'badge', style: 'font-size:11px', title: t('logs.eventHint') },
      eventLabel(line.event))
  }
  return null
}

/** 事件类型 -> 词条 key 的显式映射(拼接写法会让 i18n 门禁看不到 key). */
const EVENT_KEY: Record<string, string> = {
  quotaRefresh: 'logs.event.quotaRefresh',
  accountProbe: 'logs.event.accountProbe',
  modelFetch: 'logs.event.modelFetch',
  catalogSync: 'logs.event.catalogSync',
  accountImport: 'logs.event.accountImport',
  accountDelete: 'logs.event.accountDelete',
  loginFlow: 'logs.event.loginFlow',
  sessionAdmit: 'logs.event.sessionAdmit',
  sessionRelease: 'logs.event.sessionRelease',
  sessionRefund: 'logs.event.sessionRefund',
  sessionHeartbeat: 'logs.event.sessionHeartbeat',
  deviceKey: 'logs.event.deviceKey',
  proxyTest: 'logs.event.proxyTest',
  settingsChange: 'logs.event.settingsChange',
  dataFile: 'logs.event.dataFile',
  system: 'logs.event.system',
  telemetry: 'logs.event.telemetry',
}

/**
 * 事件类型标签.
 * @param {string} key 事件 key
 * @returns {string} 当前语种文案(未知 key 回落原文)
 */
function eventLabel(key: string) {
  const dictKey = EVENT_KEY[key]
  return dictKey ? t(dictKey) : key
}

function logsLevelTone(level: any) {
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
function logsTs(iso: any) {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return String(iso)
  const d = new Date(ms)
  const p = (x: any) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 一条日志:默认只给 ts/level/msg,点开才给完整字段(避免一眼全是噪音). */
function buildLogRow(line: any, idx: any) {
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
      line.account
        ? el('span', {
            class: 'badge',
            style: 'font-size:11px',
            title: t('logs.accountHint'),
            onclick: (e: any) => {
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
            onclick: (e: any) => {
              e.stopPropagation()
              logsView.q = line.reqId
              // 输入框的真实 id 是 logs-q(曾误写成 logs-search, 于是点了没反应).
              const input = document.querySelector('#logs-q') as HTMLInputElement | null
              if (input) input.value = line.reqId
              refreshLogs()
            },
          // 带标签: 裸 '#' + reqId 看起来像乱码, 用户不知道那是什么.
          }, t('logs.reqIdBadge') + ' ' + line.reqId)
        : null,
      // 颗粒度与事件类型: 请求日志显示"请求", 独立事件显示它的类型(双语).
      kindBadge(line),
      el('span', { class: 'log-msg' }, line.msg || ''),
      hasExtra ? el('span', { class: 'muted', style: 'font-size:11px' }, open ? '▾' : '▸') : null,
    ].filter(Boolean)),
    open && hasExtra
      ? el('div', { class: 'log-body' }, [
          el('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:6px' }, [
            el('button', {
              class: 'muted',
              style: 'font-size:11px',
              onclick: (e: any) => {
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
 *
 - 导出的是 logsView.lines(当前已加载的),与页面所见严格一致;
 - 每行一个 JSON 对象(jsonl),人能读,jq 也能直接消费.
 - 文件名带上筛选条件,避免多份导出混淆.
 */
/**
 * 导出当前筛选结果.
 *
 * @returns {void} 无返回值
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
  // 账号维度:后端已支持 account= 过滤(src/util/log.ts readLogBuffer),
  // 多账号池下"只看某个号"靠 account 过滤.
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

export async function renderLogs(view: any) {
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
       *
       - 导出的是 logsView.lines(当前已加载的),与页面所见严格一致 ----
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
    onchange: (e: any) => { logsView.level = e.target.value; refreshLogs() },
  }, [
    ['all', t('logs.levelAll')],
    ['info', t('logs.levelInfo')],
    ['warn', t('logs.levelWarn')],
    ['error', t('logs.levelError')],
  ].map(([v, label]) => el('option', { value: v, selected: logsView.level === v ? 'selected' : null }, label)))

  /**
   - 账号筛选下拉:选项直接取账号池的邮箱.
   *
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
    onchange: (e: any) => { logsView.account = e.target.value; refreshLogs() },
  }, accountOptions.map(([v, label]) =>
    el('option', { value: v, selected: logsView.account === v ? 'selected' : null }, label)))

  const searchInput = el('input', {
    id: 'logs-q',
    placeholder: t('logs.searchPlaceholder'),
    value: logsView.q,
    oninput: (e: any) => { logsView.q = e.target.value },
    onkeydown: (e: any) => { if (e.key === 'Enter') refreshLogs() },
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
