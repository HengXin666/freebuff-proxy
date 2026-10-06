/**
 * 思考强度覆盖卡 -- 出站请求的 reasoning 档位强制覆盖.
 *
 * 与其余开关卡的区别: 它的配置不是单个布尔, 而是[开关 + 逐模型档位].
 * 逐模型可选项来自服务端下发的目录行(reasoningModels.efforts), 前端不自己列档位.
 * 落点与判据见 .agents/notes/implemented/feature/2026-10-06-reasoning-effort-override.md.
 */
import { t } from '../../../locale/index.ts'
import { api } from '../../../lib/api.ts'
import { el } from '../../../lib/dom.ts'
import { toast } from '../../../lib/ui.ts'

/** 上游档位枚举(与 src/proxy/reasoning-effort.ts 的 REASONING_EFFORTS 同源). */
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/**
 * 归一化服务端下发的覆盖配置.
 *
 * @param {any} raw /api/settings 的 reasoningOverride
 * @returns {{ enabled: boolean, selected: Map<string, string> }} 归一结果
 */
function normalizeCfg(raw: any) {
  const selected = new Map<string, string>()
  for (const item of Array.isArray(raw?.models) ? raw.models : []) {
    const model = typeof item?.model === 'string' ? item.model.trim() : ''
    if (!model || !EFFORTS.includes(item?.effort)) continue
    selected.set(model, item.effort)
  }
  return { enabled: raw?.enabled === true, selected }
}

/**
 * 该模型此刻选的档位(未配置返回空串).
 *
 * @param {any} selected 已选档位表(model -> effort)
 * @param {string} model 模型标识
 * @returns {string} 档位;未配置为空串
 */
function effortOf(selected: Map<string, string>, model: string) {
  return selected.get(model) || ''
}

/**
 * 一行档位芯片: 每个可用档位一个按钮, 选中的高亮.
 *
 * @param {string} model 模型标识
 * @param {string[]} efforts 该模型可用档位
 * @param {string} current 当前选中档位
 * @param {boolean} disabled 只读时禁用
 * @returns {any} 芯片容器
 */
function effortChips(
  model: string, efforts: string[], current: string, disabled: boolean, onApply: any,
) {
  const row = el('div', { class: 'effort-chips' })
  for (const effort of efforts) {
    const on = effort === current
    row.append(el('button', {
      type: 'button',
      class: on ? 'effort-chip is-on' : 'effort-chip',
      'data-model': model,
      'data-effort': effort,
      'data-on': on ? '1' : '0',
      title: t('system.effortChipTitle'),
      // 选中态是卡片自己的状态, 先就地切换再交给保存处理器 ----
      // 把切换塞进保存处理器会让[点了没反应]与[存失败]长得一模一样.
      onclick: (event: any) => {
        toggleEffortChip(event?.currentTarget)
        onApply(event)
      },
      ...(disabled ? { disabled: '' } : {}),
    }, effort))
  }
  return row
}

/**
 * 切换一个芯片的选中态: 同一模型只允许一个档位, 其余兄弟芯片一并取消.
 *
 * @param {any} chip 被点击的芯片(没有它时什么也不做)
 * @returns {void} 无返回值
 */
export function toggleEffortChip(chip: any) {
  if (!chip || !chip.classList?.contains('effort-chip')) return
  const on = chip.getAttribute('data-on') === '1'
  chip.setAttribute('data-on', on ? '0' : '1')
  chip.classList.toggle('is-on', !on)
  for (const sib of chip.parentElement?.querySelectorAll('.effort-chip') || []) {
    if (sib === chip) continue
    sib.setAttribute('data-on', '0')
    sib.classList.remove('is-on')
  }
  syncRowState(chip)
}

/**
 * 一行模型: 名字 + 档位芯片(或[未声明档位]说明).
 *
 * @param {{ key: string, name: string, efforts: string[]|null }} item 模型项
 * @param {Map<string, string>} selected 已选档位表
 * @param {boolean} disabled 只读时禁用
 * @returns {any} 行元素
 */
function effortRow(item: any, selected: Map<string, string>, disabled: boolean, onApply: any) {
  const model = item.key || item.name
  const current = effortOf(selected, model) || effortOf(selected, item.name)
  const head = el('div', { class: 'effort-row-head' }, [
    el('span', { class: 'effort-name', title: item.key || item.name }, item.name),
    current
      ? el('span', { class: 'effort-current' }, current)
      : el('span', { class: 'effort-current muted' }, t('system.effortFollow'))
  ])
  const body = item.efforts && item.efforts.length
    ? effortChips(model, item.efforts, current, disabled, onApply)
    : el('div', { class: 'muted effort-no-efforts' }, t('system.effortNoEfforts'))
  return el('div', { class: 'effort-row' + (current ? ' is-set' : '') }, [head, body])
}

/**
 * 配置过但不在当前目录里的模型行(目录未探测或模型已下线时仍可查看/修改).
 *
 * @param {Map<string, string>} selected 已选档位表
 * @param {Set<string>} known 目录里出现过的模型标识
 * @param {boolean} disabled 只读时禁用
 * @returns {any[]} 行元素数组
 */
function danglingRows(
  selected: Map<string, string>, known: Set<string>, disabled: boolean, onApply: any,
) {
  const out: any[] = []
  for (const [model, effort] of selected) {
    if (known.has(model)) continue
    out.push(el('div', { class: 'effort-row is-set' }, [
      el('div', { class: 'effort-row-head' }, [
        el('span', { class: 'effort-name' }, model),
        el('span', { class: 'effort-current' }, effort),
      ]),
      effortChips(model, EFFORTS, effort, disabled, onApply),
    ]))
  }
  return out
}

/**
 * 思考强度覆盖卡(开关 + 逐模型档位).
 *
 * @param {any} raw /api/settings 的 reasoningOverride
 * @param {any[]} models /api/settings 的 reasoningModels
 * @param {boolean} disabled 非管理员时只读
 * @param {any} onApply 开关/芯片变更的保存处理器
 * @returns {any} 卡片元素
 */
export function buildEffortOverrideCard(raw: any, models: any[], disabled: boolean, onApply: any) {
  const cfg = normalizeCfg(raw)
  const list = Array.isArray(models) ? models : []
  const known = new Set<string>()
  const rows: any[] = []
  for (const item of list) {
    if (item?.key) known.add(item.key)
    if (item?.name) known.add(item.name)
    rows.push(effortRow(item, cfg.selected, disabled, onApply))
  }
  rows.push(...danglingRows(cfg.selected, known, disabled, onApply))
  const switcher = el('label', { class: 'switch', for: 'effort-override' }, [
    el('input', {
      id: 'effort-override',
      type: 'checkbox',
      class: 'switch-input',
      onchange: onApply,
      ...(cfg.enabled ? { checked: '' } : {}),
      ...(disabled ? { disabled: '' } : {}),
    }),
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
    el('span', { class: 'switch-status' }, cfg.enabled ? t('common.on') : t('common.off')),
  ])
  return el('div', { class: 'card settings-band', id: 'effort-card' }, [
    el('div', { class: 'row spread effort-head' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('system.effortTitle')),
        el('span', { class: 'muted' }, t('system.effortHint')),
        el('div', { class: 'muted effort-when' }, t('system.effortWhen')),
      ]),
      switcher,
    ]),
    el('div', { class: cfg.enabled ? 'effort-status' : 'effort-status muted' },
      cfg.enabled
        ? t('system.effortStatusOn', { n: cfg.selected.size })
        : t('system.effortStatusOff')),
    el('div', {
      class: cfg.enabled && cfg.selected.size === 0 ? 'effort-warn' : 'effort-warn hidden',
    }, t('system.effortEmptyWarn')),
    el('div', { class: 'effort-list' }, rows.length
      ? rows
      : el('div', { class: 'muted effort-empty' }, t('system.effortNoModels'))),
    el('div', { class: 'muted effort-tip' }, t('system.effortTip')),
  ])
}

/**
 * 从卡片 DOM 收集当前配置.
 *
 * 判据是[芯片的 data-on], 不是 CSS 类: 保存失败时类会被回滚, 判据必须来自状态位.
 *
 * @returns {{ enabled: boolean, models: Array<{ model: string, effort: string }> }} 当前配置
 */
function readConfig() {
  const card = document.getElementById('effort-card')
  const enabled = Boolean((card?.querySelector('#effort-override') as HTMLInputElement)?.checked)
  const models: Array<{ model: string, effort: string }> = []
  const seen = new Set<string>()
  for (const chip of card?.querySelectorAll('.effort-chip.is-on') || []) {
    const model = chip.getAttribute('data-model') || ''
    const effort = chip.getAttribute('data-effort') || ''
    if (!model || !effort || seen.has(model)) continue
    seen.add(model)
    models.push({ model, effort })
  }
  return { enabled, models }
}

/**
 * 保存思考强度覆盖(开关与芯片共用; 变更即存, 实时生效).
 *
 * 点击芯片的行为: 点未选中的档位 = 选中; 再点已选中的档位 = 取消该模型的覆盖.
 *
 * @returns {Promise<void>} 无返回值
 */
export async function saveEffortOverride() {
  // 选中态由卡片在点击时就地切换(见 toggleEffortChip), 这里只做[读当前态 -> 落盘].
  const cfg = readConfig()
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ reasoningOverride: cfg }) })
    refreshStatus(cfg)
  } catch (err) {
    toast(err.message, true)
    try {
      const fresh = await api('/api/settings')
      renderInto(fresh.reasoningOverride, fresh.reasoningModels)
    } catch { /* 回读失败时保留本地态, 下次操作仍会重试 */ }
  }
}

/**
 * 就地刷新状态行与行高亮(不重建卡片, 避免输入焦点/滚动位置丢失).
 *
 * @param {{ enabled: boolean, models: Array<{ model: string, effort: string }> }} cfg 当前配置
 * @returns {void} 无返回值
 */
function refreshStatus(cfg: any) {
  const card = document.getElementById('effort-card')
  const status = card?.querySelector('.effort-status')
  if (status) {
    status.textContent = cfg.enabled
      ? t('system.effortStatusOn', { n: cfg.models.length })
      : t('system.effortStatusOff')
    status.classList.toggle('muted', !cfg.enabled)
  }
  const warn = card?.querySelector('.effort-warn')
  if (warn) warn.classList.toggle('hidden', !(cfg.enabled && cfg.models.length === 0))
  const label = card?.querySelector('.switch-status')
  if (label) label.textContent = cfg.enabled ? t('common.on') : t('common.off')
  for (const row of card?.querySelectorAll('.effort-row') || []) {
    row.classList.toggle('is-set', Boolean(row.querySelector('.effort-chip.is-on')))
  }
}

/**
 * 同步一行内的[当前档位]文字.
 *
 * @param {any} chip 被点击的芯片
 * @returns {void} 无返回值
 */
function syncRowState(chip: any) {
  const row = chip.closest('.effort-row')
  const current = row?.querySelector('.effort-current')
  if (!current) return
  const on = chip.getAttribute('data-on') === '1'
  current.textContent = on ? chip.getAttribute('data-effort') : t('system.effortFollow')
  current.classList.toggle('muted', !on)
}

/**
 * 用服务端回执重建卡片(保存失败回滚时用).
 *
 * @param {any} override 回执里的 reasoningOverride
 * @param {any} models 回执里的 reasoningModels
 * @returns {void} 无返回值
 */
function renderInto(override: any, models: any) {
  const card = document.getElementById('effort-card')
  if (!card) return
  const fresh = buildEffortOverrideCard(
    override, models, false, saveEffortOverride,
  )
  card.replaceWith(fresh)
}
