import { t } from '../../i18n.js'
import { api } from '../../lib/api.js'
import { $, el, icon } from '../../lib/dom.js'
import { toast } from '../../lib/ui.js'


export async function renderSystem(view) {
  view.innerHTML = ''
  view.append(el('h2', { style: 'margin:0 0 12px' }, t('nav.system')))
  await renderDataFilesCard(view)
}

async function renderDataFilesCard(view) {
  let data = null
  try { data = await api('/api/system/data-status') } catch { return }
  const files = data?.files || []
  if (!files.length) return
  const invalid = files.filter((f) => f.status === 'invalid')
  const dirty = files.filter((f) => (f.droppedEntries || 0) > 0)
  const pending = files.reduce((n, f) => n + (f.openHandles || 0), 0)
  const summary = [
    invalid.length ? t('system.filesBroken', { n: invalid.length }) : null,
    dirty.length ? t('system.filesDirty', { n: dirty.length }) : null,
    pending ? t('system.filesPending', { n: pending }) : null,
  ].filter(Boolean).join(' · ') || t('common.ok')
  const card = el('div', { id: 'data-files-card', class: 'card' })
  card.append(el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.dataSelfCheck')),
      el('span', { class: 'muted' }, t('system.dataDirSummary', { dir: data.dir, n: files.length, summary })),
    ]),
    el('button', { class: 'muted', onclick: () => refreshDataFilesCard() }, [icon('refresh', 13), t('common.refresh')]),
  ]))
  if (invalid.length) {
    card.append(el('div', { class: 'muted', style: 'margin-top:8px;color:var(--red)' },
      t('system.invalidHint')))
  }
  if (dirty.length) {
    card.append(el('div', { class: 'muted', style: 'margin-top:8px;color:var(--yellow,#e0a800)' },
      t('system.dirtyHint')))
  }
  const rows = files.map((f) => {
    const dirtyCount = f.droppedEntries || 0
    const pending = f.openHandles || 0
    const badge = f.status === 'invalid'
      ? el('span', { class: 'badge err' }, t('system.statusBroken'))
      : f.status === 'missing'
        ? el('span', { class: 'badge' }, t('system.statusMissing'))
        : dirtyCount
          ? el('span', { class: 'badge err' }, t('system.statusDirtyCount', { n: dirtyCount }))
          : pending
            ? el('span', { class: 'badge' }, t('system.statusPendingCount', { n: pending }))
            : el('span', { class: 'badge ok' }, t('common.ok'))
    const desc = f.status === 'invalid'
      ? f.reason
      : dirtyCount
        ? `${f.droppedReason || t('system.descDirty')}${f.droppedBackup ? t('system.descBackup', { name: f.droppedBackup.split('/').pop() }) : ''}`
        : pending
          ? t('system.descPendingHandles', { n: pending })
          : f.reason || (f.status === 'missing' ? t('system.descAutoCreate') : t('common.none'))
    return el('tr', {}, [
      el('td', { class: 'mono', style: 'font-size:12px' }, f.name + (f.critical ? ' ' : '')),
      el('td', {}, badge),
      el('td', { class: 'muted', style: 'font-size:12px' }, desc),
      el('td', {}, f.status === 'invalid'
        // 真源文件(users.json / sessions.json)不能照抄 mv:sessions.json 里
        // 可能还挂着没结算的会话句柄,删掉就永久失去寻址能力(槽位一直占着).
        ? (f.critical
            ? el('span', { class: 'muted' }, t('system.actionBackupThenMove'))
            : codeCopyButton(`mv ${f.file} ${f.file}.broken`))
        : el('span', { class: 'muted' }, dirtyCount ? t('system.actionNoneNeeded') : t('common.none'))),
    ])
  })
  card.append(el('div', { class: 'table-wrap', style: 'margin-top:10px' }, [
    el('table', { style: 'font-size:12px' }, [
      el('thead', {}, el('tr', {}, [t('system.colFile'), t('common.status'), t('system.colDesc'), t('system.colAction')].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows),
    ]),
  ]))
  view.append(card)
}

/** 一键复制命令的小按钮(运维照抄用). */
function codeCopyButton(cmd) {
  return el('div', { class: 'row', style: 'gap:6px' }, [
    el('code', { class: 'mono', style: 'font-size:11px' }, cmd),
    el('button', {
      class: 'icon', title: t('system.copyCommand'),
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(cmd)
          toast(t('toast.commandCopied'))
        } catch {
          toast(t('toast.copyFailSelectShort'), true)
        }
      },
    }, icon('copy', 12)),
  ])
}

/** 数据文件自检卡片局部刷新. */
async function refreshDataFilesCard() {
  const old = $('#data-files-card')
  if (!old) return
  const holder = document.createElement('div')
  await renderDataFilesCard(holder)
  const fresh = holder.querySelector('#data-files-card')
  if (fresh) old.replaceWith(fresh)
}
