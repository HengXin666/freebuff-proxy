/**
 * 官方工具注入卡 -- 从 ./cards.ts 按体量拆出, 渲染与保存同处一地.
 *
 * 拆出理由: index.ts 与 cards.ts 都已贴近 500/300 行上限, 而这张卡的语义
 * (提交整份勾选集合, 空数组是合法值)与其余开关卡的 [改一个布尔] 不同类.
 *
 * 列表必须独占卡片整行, 判据与实测见
 * .agents/notes/implemented/bug-fix/2026-10-06-official-tools-row-full-width.md.
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
    { items: list.filter((x) => x?.group === 'common'), label: t('system.officialToolsGroupCommon') },
    { items: list.filter((x) => x?.group !== 'common'), label: t('system.officialToolsGroupOrphan') },
  ]
  const body = el('div', { class: 'official-tools-body' })
  for (const g of groups) {
    if (g.items.length === 0) continue
    body.append(buildGroup(g.items, g.label, unconfigured, selected, disabled))
  }
  const activeNames: string[] | null = unconfigured ? null : selected
  return el('div', {
    class: 'card settings-band', id: 'official-tools-card', style: 'margin-top:12px',
  }, [
    el('div', { class: 'row spread official-tools-head' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('system.officialTools')),
        el('span', { class: 'muted' }, t('system.officialToolsHint')),
        // 生效时点并入说明区(原先单占一行夹在卡片中部, 视觉上很挤):
        // 这个开关改的是[下个请求带上游的工具集], 在途请求不受影响.
        el('div', { class: 'muted official-tools-when' }, t('system.officialToolsWhen')),
      ]),
      // 保存按钮放标题行: 卡片有 37 个勾选项, 放在底部要滚很久才看得到.
      el('div', { class: 'row', style: 'gap:10px;align-items:center' }, [
        el('div', {
          class: unconfigured ? 'official-tools-status muted' : 'official-tools-status',
        }, unconfigured || !activeNames
          ? t('system.officialToolsStatusAuto')
          : activeNames.length === 0
            ? t('system.officialToolsStatusNone')
            : t('system.officialToolsStatusCount').replace('{n}', String(activeNames.length))),
        el('button', {
          class: 'btn btn-primary', type: 'button', id: 'official-tools-apply',
          disabled: disabled ? '' : undefined,
          onclick: onApply,
        }, t('system.officialToolsApply')),
      ]),
    ]),
    // 空名单警告: 上游按工具集完整性判第三方客户端, 出站不带官方工具会被直接
    // 拒(503). 这种配置没有存在价值, 后端也做了兜底(空数组回落成全注入).
    // 常驻节点 + hidden 开关: 应用空名单后由 applyStatus 就地显示, 不必重建卡片.
    el('div', {
      class: emptyWarnClass(unconfigured, activeNames),
    }, t('system.officialToolsEmptyWarn')),
    el('div', { class: 'official-tools-summary' }, [
      el('span', { class: 'muted' }, t('system.officialToolsCountLabel')),
      el('strong', { class: 'official-tools-count-value' },
        String(list.filter(checkedBy(unconfigured, selected)).length)),
      el('span', { class: 'muted' }, ' / ' + String(list.length)),
    ]),
    body,
  ])
}

/**
 * 空名单警告的类名: 生效名单为空时去掉 hidden.
 *
 * @param {boolean} unconfigured 是否未配置
 * @param {string[]|null} activeNames 生效名单
 * @returns {string} 元素的 class
 */
function emptyWarnClass(unconfigured: boolean, activeNames: string[] | null) {
  const empty = !unconfigured && !!activeNames && activeNames.length === 0
  return empty ? 'official-tools-danger' : 'official-tools-danger hidden'
}

/**
 * 生成[该项此刻是否勾选]的判据函数.
 *
 * @param {boolean} unconfigured 是否未配置(按目录默认态勾选)
 * @param {string[]|null} selected 当前名单
 * @returns {any} 接收目录项的判据
 */
function checkedBy(unconfigured: boolean, selected: string[] | null) {
  return (item: any) => (unconfigured ? item?.group === 'common' : (selected || []).includes(item?.name))
}

/**
 * 建一个工具分组(标题 + 全选/全不选 + 逐项勾选).
 *
 * @param {any[]} items 该组工具
 * @param {string} label 组标题
 * @param {boolean} unconfigured 是否未配置(按目录默认态勾选)
 * @param {string[]|null} selected 当前名单
 * @param {boolean} disabled 只读时禁用
 * @returns {any} 分组元素
 */
function buildGroup(
  items: any[], label: string, unconfigured: boolean,
  selected: string[] | null, disabled: boolean,
) {
  // 先建容器再挂按钮: 按钮的作用域要引用容器本身, 在同一个表达式里互相引用
  // 会撞上块级作用域(变量在初始化完成前不可用).
  const box = el('div', { class: 'official-tools-group' })
  box.append(el('div', { class: 'official-tools-group-head' }, [
    el('strong', {}, label),
    el('div', { class: 'row' }, [
      groupToggleButton(true, box, disabled),
      groupToggleButton(false, box, disabled),
    ]),
  ]))
  for (const item of items) {
    const attrs: Record<string, any> = {
      type: 'checkbox', class: 'official-tool-box', value: item.name, 'data-name': item.name,
    }
    // 未配置时按目录默认态(common 勾上), 配置过就严格按名单.
    const on = unconfigured ? item.group === 'common' : (selected || []).includes(item.name)
    if (on) attrs.checked = ''
    if (disabled) attrs.disabled = ''
    const input = el('input', { ...attrs, 'data-default': on ? '1' : '0' }) as HTMLInputElement
    const row = el('label', { class: on ? 'official-tool-item is-on' : 'official-tool-item' }, [
      input,
      el('span', { class: 'official-tool-name' }, item.name),
      el('span', { class: 'muted official-tool-desc' }, item.desc),
    ])
    // 整行是 label, 点名字或说明即切换勾选; 同步行高亮与进度数字.
    input.addEventListener('change', () => {
      row.classList.toggle('is-on', !!input.checked)
      syncCount(row)
    })
    box.append(row)
  }
  return box
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
    onclick: () => {
      for (const node of box.querySelectorAll('input.official-tool-box')) {
        const i = node as HTMLInputElement
        i.checked = on
        i.closest('.official-tool-item')?.classList.toggle('is-on', on)
      }
      syncCount(box)
    },
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
          // 程序化改 checked 不会触发 change, 行高亮与进度要在这里补一次.
          box.closest('.official-tool-item')?.classList.toggle('is-on', box.checked)
        }
        syncCount(card)
      }
      applyStatus(card, active)
    } catch { /* 回读失败也保持可交互 */ }
  } catch (err) {
    toast(err.message, true)
  }
  btn.disabled = false
}

/**
 * 就地刷新卡片上的[已勾选 / 总数]进度.
 *
 * @param {any} node 卡片内任意节点
 * @returns {void} 无返回值
 */
function syncCount(node: any) {
  const card = node?.closest?.('#official-tools-card')
  const out = card?.querySelector?.('.official-tools-count-value')
  if (!out) return
  out.textContent = String(card.querySelectorAll('input.official-tool-box:checked').length)
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
  const warn = card?.querySelector?.('.official-tools-danger')
  warn?.classList.toggle('hidden', !(active && active.size === 0))
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
