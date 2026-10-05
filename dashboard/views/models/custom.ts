import { t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { $, el, icon } from '../../lib/dom.ts'
import { need } from '../../lib/hooks.ts'
import { modelNameFor, poolLabel } from '../../lib/format/models.ts'
import { state } from '../../lib/state.ts'
import { toast } from '../../lib/ui.ts'

/**
 * 自定义模型的可视化编辑(增 / 删 / 恢复 / 行内自动保存).
 *
 * 与 cards.ts 的分界:cards.ts 只画节点,本文件负责[改数据] -- 提交自定义模型
 * 数组,隐藏/恢复模型,防抖自动保存.两者都不读 /api/models/upstream,
 * 那是 sync.ts 的职责(同步上游目录是独立动作,不是每次渲染都要做的事).
 */

export async function removeCustomModel(key: any, label: any) {
  const shown = label || key
  if (!confirm(t('model.hideConfirm', { id: shown }))) return
  // 乐观 UI:点击瞬间先从表格移除该行,插入恢复区(不等待任何网络请求).
  // 行按 data-key 匹配(首列显示的是可读名,拿它比 key 永远找不到行).
  const row = [...document.querySelectorAll('#models-card tbody tr')].find(
    (r) => r.dataset.key === key,
  )
  if (row) row.remove()
  const card = $('#models-card')
  if (card) addRestoreBadge(card, key, shown)
  try {
    await api('/api/models/custom/hide', {
      method: 'POST',
      body: JSON.stringify({ id: key }),
    })
    toast(t('model.hidden', { id: shown }))
  } catch (err) {
    // 失败:把行加回表格(用本地重建),并撤销恢复区,反馈错误
    toast(err.message, true)
    need('refreshModelSettingsCard')()
  }
}

/** 彻底移除一个用户手动添加的自定义模型(回退内置目录,不会在同步时回来). */
export async function removeCustomOnlyModel(id: any) {
  if (!confirm(t('model.removeConfirm', { id }))) return
  try {
    const r = await api('/api/models/custom/remove', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    toast(t('model.removed', { id }))
    need('refreshModelSettingsCard')()
  } catch (err) {
    toast(err.message, true)
  }
}

/** 恢复被删除(隐藏)的模型 */
export async function restoreCustomModel(id: any) {
  // 乐观:先从恢复区移除徽章,再后台请求
  const badge = [...document.querySelectorAll('#models-card .badge')].find(
    (b) => b.querySelector(`.icon[title="${t('model.restoreTitle')}"]`) && b.textContent.includes(id),
  )
  if (badge) badge.remove()
  try {
    await api('/api/models/custom/unhide', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    toast(t('model.restored', { id }))
    // 立即重建模型表卡(无需等重拉上游----本地已知恢复)
    need('refreshModelSettingsCard')()
  } catch (err) {
    toast(err.message, true)
    need('refreshModelSettingsCard')()
  }
}

/** 在模型卡里追加一个"已删除模型"恢复徽章(没有恢复区则先创建) */
/**
 - 在[已删除的模型]区插入一个可恢复徽章.
 - key 是服务端口径(提交给 unhide),label 是展示口径(可读模型名);
 - hidden 列表里存的永远是 key(与调度白名单同源),页面显示的是 label.
 */
export function addRestoreBadge(card: any, key: any, label: any) {
  let area = card.querySelector('#hidden-models-area')
  if (!area) {
    area = el('div', { id: 'hidden-models-area', style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--border)' }, [
      el('label', { class: 'muted' }, t('model.hiddenAreaShort')),
      el('div', { class: 'hidden-badges row', style: 'margin-top:6px;gap:6px;flex-wrap:wrap' }, []),
    ])
    card.append(area)
  }
  const labelEl = area.querySelector('.muted')
  if (labelEl) {
    const n = area.querySelectorAll('.badge').length
    labelEl.textContent = t('model.hiddenArea', { n })
  }
  area.querySelector('.hidden-badges').append(el('span', { class: 'badge', style: 'display:inline-flex;align-items:center;gap:6px' }, [
    el('code', { style: 'font-family:var(--mono);font-size:11px', title: key }, label || key),
    el('button', { class: 'icon', title: t('model.restoreTitle'), onclick: () => restoreCustomModel(key) }, icon('refresh', 12)),
  ]))
}

/** 渲染自定义模型编辑行(可视化表单,不填 JSON) */
export function buildCustomModelRows(models: any) {
  const wrap = el('div', { class: 'cm-rows' })
  if (!models.length) {
    wrap.append(el('div', { class: 'muted', style: 'padding:8px 0;font-size:12px' }, t('model.emptyCustom')))
    return wrap
  }
  for (const m of models) wrap.append(customModelRow(m))
  return wrap
}

export function customModelRow(m = {}) {
  const id = el('input', {
    class: 'mono',
    placeholder: t('model.idPlaceholder'),
    value: m.id || '',
    'data-f': 'id',
    style: 'flex:2;min-width:120px',
  })
  const name = el('input', {
    placeholder: t('model.displayNamePlaceholder'),
    value: m.displayName || m.display_name || '',
    'data-f': 'displayName',
    style: 'flex:1.2;min-width:90px',
  })
  const pool = el('select', {
    'data-f': 'pool',
    style: 'flex:1;min-width:90px',
  }, ['', 'daily', 'premium', 'referral', 'limited_offer'].map((p) =>
    el('option', { value: p, selected: (m.pool || '') === p }, p ? poolLabel(p) : t('model.poolDefault'))))
  const agent = el('input', {
    class: 'mono',
    placeholder: t('model.agentPlaceholder'),
    value: m.agentId || m.agent_id || '',
    'data-f': 'agentId',
    style: 'flex:2;min-width:140px',
  })
  const fbAgent = el('input', {
    class: 'mono',
    placeholder: t('model.fallbackAgentPlaceholder'),
    value: m.fallbackAgentId || m.fallback_agent_id || '',
    'data-f': 'fallbackAgentId',
    style: 'flex:2;min-width:140px',
  })
  const del = el('button', {
    class: 'icon danger',
    title: t('model.deleteTitle'),
    onclick: () => {
      const id = row.querySelector('[data-f="id"]')?.value?.trim()
      row.remove()
      const editor = $('#custom-models-editor')
      if (editor && !editor.querySelector('.cm-row')) {
        editor.append(el('div', { class: 'muted', style: 'padding:8px 0;font-size:12px' }, t('model.emptyCustom')))
      }
      // 移除这条自定义模型(彻底删除,回退内置目录;同步不会把它加回来)
      autoSaveCustomModels()
      if (id) removeCustomOnlyModel(id)
    },
  }, icon('trash', 13))
  const row = el('div', { class: 'cm-row' }, [id, name, pool, agent, fbAgent, del])
  // 行内编辑自动保存(防抖 600ms)
  for (const input of [id, name, pool, agent, fbAgent]) {
    input.addEventListener('input', scheduleAutoSave)
    input.addEventListener('change', scheduleAutoSave)
  }
  return row
}

export function addCustomModelRow() {
  const editor = $('#custom-models-editor')
  const empty = editor.querySelector('.muted')
  if (empty) empty.remove()
  editor.append(customModelRow())
  autoSaveCustomModels()
}

/** 行内编辑自动保存(防抖) */
export let _cmSaveTimer: any = null

export function scheduleAutoSave() {
  clearTimeout(_cmSaveTimer)
  _cmSaveTimer = setTimeout(() => autoSaveCustomModels(), 600)
}

/** 从可视化行收集模型数组并自动保存(前端自动组装,不填 JSON) */
export async function autoSaveCustomModels() {
  const models = collectCustomModels()
  if (!models.length) return
  try {
    await api('/api/models/custom', {
      method: 'POST',
      body: JSON.stringify({ models }),
    })
  } catch (err) {
    toast(t('model.saveFail', { msg: err.message }), true)
  }
}

/** 从可视化行收集模型数组(校验必填,前端自动组装) */
export function collectCustomModels() {
  const models = []
  for (const row of document.querySelectorAll('#custom-models-editor .cm-row')) {
    const get = (f: any) => row.querySelector(`[data-f="${f}"]`)?.value?.trim() || ''
    const id = get('id')
    if (!id) continue // 空行跳过
    const m = { id }
    const name = get('displayName')
    if (name) m.displayName = name
    const pool = get('pool')
    if (pool) m.pool = pool
    const agent = get('agentId')
    if (agent) m.agentId = agent
    const fbAgent = get('fallbackAgentId')
    if (fbAgent) m.fallbackAgentId = fbAgent
    models.push(m)
  }
  return models
}
