/**
 * 官方工具注入卡 -- 从 ./cards.ts 按体量拆出, 渲染与保存同处一地.
 *
 * 拆出理由: index.ts 与 cards.ts 都已贴近 500/300 行上限, 而这张卡的语义
 * (提交整份勾选集合, 空数组是合法值)与其余开关卡的 [改一个布尔] 不同类.
 */
import { t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { el } from '../../lib/dom.ts'
import { toast } from '../../lib/ui.ts'

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
        el('input', attrs),
        el('span', { class: 'official-tool-name' }, item.name),
        el('span', { class: 'muted official-tool-desc' }, item.desc),
      ]))
    }
    body.append(box)
  }
  return el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.officialTools')),
      el('span', { class: 'muted' }, t('system.officialToolsHint')),
    ]),
    unconfigured ? el('div', { class: 'muted' }, t('system.officialToolsAll')) : null,
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
  const card = btn.closest('.card')
  const names: string[] = []
  if (card) {
    for (const input of card.querySelectorAll('input.official-tool-box')) {
      if (input.checked && input.value) names.push(input.value)
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
      if (Array.isArray(s.officialToolNames)) {
        const active = new Set(s.officialToolNames)
        if (card) {
          for (const input of card.querySelectorAll('input.official-tool-box')) {
            input.checked = active.has(input.value)
          }
        }
      }
    } catch { /* 回读失败也保持可交互 */ }
  } catch (err) {
    toast(err.message, true)
  }
  btn.disabled = false
}
