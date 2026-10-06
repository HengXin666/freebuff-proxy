/**
 * 官方工具注入卡 -- 从 ./cards.ts 按体量拆出, 渲染与保存同处一地.
 *
 * 拆出理由: index.ts 与 cards.ts 都已贴近 500/300 行上限, 而这张卡的语义
 * (提交整份勾选集合, 空数组是合法值)与其余开关卡的 [改一个布尔] 不同类.
 */
import { t } from '../../../locale/index.ts'
import { api } from '../../../lib/api.ts'
import { el } from '../../../lib/dom.ts'
import { toast } from '../../../lib/ui.ts'

/**
 * 官方工具注入卡: 按[可派发 / 不可派发]分组的勾选列表.
 *
 * 分组判据来自服务端目录(每个工具的 group 字段), 前端不自己分类 ---- 分类真源
 * 在 src/upstream/signals/official-tool-select.ts, 两处判断必然漂移.
 *
 * [未配置] 与 [空数组] 必须能分开显示: 前者全部注入, 后者一个都不注入.
 * 所以 selected 为 null 时按目录里的默认勾选态渲染并提示未配置.
 *
 * 保存处理器由调用方传入(与其余卡片一致): 本文件只做 DOM 构造, 不发请求.
 *
 * @param {any[]} catalog 服务端下发的官方工具目录(名字 / 分组 / 说明)
 * @param {string[]|null} selected 当前生效的名单; null = 未配置
 * @param {boolean} disabled 非管理员时禁用交互
 * @param {any} onApply 应用按钮的点击处理器
 * @returns {any} 卡片元素
 */
export function buildOfficialToolsCard(
  catalog: any[], selected: string[] | null, disabled: boolean, onApply: any,
) {
  const unconfigured = !Array.isArray(selected)
  const list = Array.isArray(catalog) ? catalog : []
  const groups = [
    { items: list.filter((t) => t?.group === 'common'), label: t('system.officialToolsGroupCommon') },
    { items: list.filter((t) => t?.group !== 'common'), label: t('system.officialToolsGroupOrphan') },
  ]
  const body = el('div', { class: 'official-tools-body' })
  for (const g of groups) {
    if (g.items.length === 0) continue
    // 先建容器再挂按钮: 按钮的作用域要引用容器本身, 在同一个表达式里
    // 互相引用会撞上块级作用域(变量在初始化完成前不可用).
    const box = el('div', { class: 'official-tools-group' })
    box.append(el('div', { class: 'official-tools-group-head' }, [
      el('strong', {}, g.label),
      el('div', { class: 'row' }, [
        groupToggleButton(true, box, disabled),
        groupToggleButton(false, box, disabled),
      ]),
    ]))
    for (const item of g.items) {
      const attrs: Record<string, any> = {
        type: 'checkbox', class: 'official-tool-box', value: item.name, 'data-name': item.name,
      }
      // 未配置时按目录默认态(common 勾上), 配置过就严格按名单.
      const on = unconfigured ? item.group === 'common' : selected.includes(item.name)
      if (on) attrs.checked = ''
      if (disabled) attrs.disabled = ''
      box.append(el('label', { class: 'official-tool-item' }, [
        el('input', { ...attrs, 'data-default': on ? '1' : '0' }),
        el('span', { class: 'official-tool-name' }, item.name),
        el('span', { class: 'muted official-tool-desc' }, item.desc),
      ]))
    }
    body.append(box)
  }
  const activeNames: string[] | null = unconfigured ? null : selected
  return el('div', {
    class: 'card settings-band', id: 'official-tools-card', style: 'margin-top:12px',
  }, [
    el('div', { class: 'row spread official-tools-head' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('system.officialTools')),
        el('span', { class: 'muted' }, t('system.officialToolsHint')),
      ]),
      el('div', {
        class: unconfigured ? 'official-tools-status muted' : 'official-tools-status',
      }, unconfigured || !activeNames
        ? t('system.officialToolsStatusAuto')
        : activeNames.length === 0
          ? t('system.officialToolsStatusNone')
          : t('system.officialToolsStatusCount').replace('{n}', String(activeNames.length))),
    ]),
    // 生效时点必须写在卡上: 这个开关改的是[下一个请求带上游的工具集],
    // 在途请求不受影响 ---- 只说[即时生效]会让用户拿正在跑的会话去判断.
    el('div', { class: 'muted official-tools-when' }, t('system.officialToolsWhen')),
    body,
    el('div', { class: 'row' }, [
      el('button', {
        class: 'btn btn-primary', type: 'button', id: 'official-tools-apply',
        disabled: disabled ? '' : undefined,
        onclick: onApply,
      }, t('system.officialToolsApply')),
    ]),
  ])
}

/**
 * 分组内的全选/全不选按钮.
 *
 * 作用域按所在盒子就地查找, 不依赖全局 id ---- 两个分组各有自己的按钮.
 *
 * @param {boolean} on 勾选还是取消
 * @param {any} box 分组容器元素
 * @param {boolean} disabled 只读时禁用
 * @returns {any} 按钮元素
 */
function groupToggleButton(on: boolean, box: any, disabled: boolean) {
  return el('button', {
    class: 'btn btn-sm', type: 'button', disabled: disabled ? '' : undefined,
    onclick: () => { for (const i of box.querySelectorAll('input.official-tool-box')) i.checked = on },
  }, t(on ? 'system.officialToolsSelectAll' : 'system.officialToolsSelectNone'))
}

/**
 * 保存官方工具注入名单(见 /api/settings.officialToolNames).
 *
 * 提交的是[当前勾选的集合], 不是增量: 服务端把空数组当[一个都不注入],
 * 所以未勾任何一项时必须原样提交空数组, 不能跳过请求.
 *
 * @param {any} event 应用按钮的 click 事件
 * @returns {Promise<void>} 无返回值
 */
export async function saveOfficialToolsSetting(event: any) {
  const btn = event.currentTarget
  // 作用域用[卡片容器 id]而不是 closest('.card'): 后者要求按钮恰好落在
  // .card 内, 卡片结构一变(或按钮被挪出)就会收集到空数组 ---- 而空数组在
  // 服务端语义是[一个都不注入], 等于静默把用户配置改成全关.
  const card = document.getElementById('official-tools-card')
  const names: string[] = []
  if (card) {
    for (const input of card.querySelectorAll('input.official-tool-box')) {
      const box = input as HTMLInputElement
      if (box.checked && box.value) names.push(box.value)
    }
  }
  btn.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ officialToolNames: names }),
    })
    toast(t('system.officialToolsSaved'))
    try {
      const s = await api('/api/settings')
      // 回读必须把 [未配置(null)] 与 [空数组] 分开回填: 混同会让界面显示的
      // 勾选态与真实生效值不一致(用户看到勾着, 实际全不注入).
      const raw: unknown = s.officialToolNames
      const active = Array.isArray(raw) ? new Set(raw as string[]) : null
      if (card) {
        for (const input of card.querySelectorAll('input.official-tool-box')) {
          const box = input as HTMLInputElement
          box.checked = active
            ? active.has(box.value)
            : box.getAttribute('data-default') === '1'
        }
      }
      applyStatus(card, active)
    } catch { /* 回读失败也保持可交互 */ }
  } catch (err) {
    toast(err.message, true)
  }
  btn.disabled = false
}

/**
 * 刷新卡片顶部的[当前生效]状态行.
 *
 * 为什么必须有(用户反馈): 这个开关的作用对象是[发给上游的工具集], 从界面上
 * 看不出[现在到底注入了几个], 只能靠逐项数勾选, 关掉一个也说不清生效没有.
 * 状态行把三态直接写出来: 未配置(自动) / 已配置 / 全不注入.
 *
 * @param {any} card 卡片容器
 * @param {Set<string>|null} active 生效名单; null 表示未配置
 * @returns {void} 无返回值
 */
function applyStatus(card: any, active: Set<string> | null) {
  const line = card?.querySelector?.('.official-tools-status')
  if (!line) return
  if (!active) {
    line.textContent = t('system.officialToolsStatusAuto')
    line.className = 'official-tools-status muted'
    return
  }
  line.textContent = active.size === 0
    ? t('system.officialToolsStatusNone')
    : t('system.officialToolsStatusCount').replace('{n}', String(active.size))
  line.className = 'official-tools-status'
}
