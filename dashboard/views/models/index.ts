import { t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { el, icon } from '../../lib/dom.ts'
import { need } from '../../lib/boot/hooks.ts'
import { modelNameFor } from '../../lib/format/models.ts'
import { state } from '../../lib/state.ts'
import { toast } from '../../lib/ui.ts'
import {
  buildHiddenModelsArea, buildModelsEditor, buildModelsHeader,
  buildModelsReconcileBar, buildModelsSwitchRow, buildModelsTable,
} from './cards.ts'

// 对外导出面保持不变(总览与代理设置页都从本模块取这些名字):
// 实现已下沉到同目录的 sync.ts / custom.ts,这里只做转发.
export { refreshModelSettingsCard, syncUpstreamModels, pruneStaleModels } from './sync.ts'
export {
  addCustomModelRow, buildCustomModelRows, removeCustomModel,
  removeCustomOnlyModel, restoreCustomModel,
} from './custom.ts'

/**
 * 模型管理卡片的装配层(总览页的一个区块).
 *
 * 本目录的分工:
 *   cards.ts   六张卡的纯渲染
 *   custom.ts  自定义模型的增/删/恢复/自动保存
 *   sync.ts    与上游目录对账(局部刷新 / 同步 / 清理 / 报告)
 *   index.ts   本文件:拉数据 -> 组装卡片
 *
 * 跨文件引用一律走 need(name)(见 dashboard/lib/boot/hooks.ts),避免模块环.
 */

export async function renderModelSettings(view: any) {
  let data = { models: [], catalog: [] }
  let upstream = { models: [], accessTier: null }
  try {
    data = await api('/api/models/custom')
  } catch { /* ignore */ }
  try {
    upstream = await api('/api/models/upstream')
  } catch { /* ignore */ }

  const known: Map<string, any> = new Map()
  // catalog 先行:agent/兜底 agent 以 catalog 为准(内置目录是 agent 映射的权威源)
  for (const m of data.catalog || []) known.set(m.id, { ...m, source: 'catalog' })
  for (const m of upstream.models || []) {
    const prev = known.get(m.id)
    if (prev) {
      known.set(m.id, {
        ...prev,
        ...m,
        // 保留 catalog 的 agent/fallback(上游探测值不作为调度依据)
        agentId: prev.agentId || m.agentId,
        fallbackAgentId: prev.fallbackAgentId || m.fallbackAgentId,
        source: 'upstream',
      })
    } else {
      known.set(m.id, { ...m, source: 'upstream' })
    }
  }
  /**
   - [账号真实可用]的判据 = 上游目录里有没有这一行.
   *
   - 用户质疑得对:表里有 15 条内置 + 53 条自定义,而上游目录只有 13 条.
   - 那些上游根本没有的条目调用必然失败,却在列表里与可用模型长得一模一样
   - ---- 纯粹是误导.所以每一行都必须能一眼看出它在不在上游目录里.
   *
   - 匹配按可读名(与 /v1/models 同源,口径 displayName || key)比对;
   - 目录 key(m-xxx)作兜底,因为旧自定义条目可能只存了 key.
   */
  const upstreamIdSet = new Set(
    (upstream.models || []).map((m) => m.id || m.catalogId || m.key).filter(Boolean),
  )
  const upstreamKeySet = new Set((upstream.models || []).map((m) => m.key).filter(Boolean))
  const isLiveUpstream = (m: any) =>
    upstreamIdSet.has(m.id) || (m.key && upstreamKeySet.has(m.key))

  const rows = [...known.values()]
  /**
   - staleCount 必须在 rows 声明之后算.
   *
   - 第一版把它写在 const rows 之前,而它要读 rows ---- 命中 TDZ
   - (can't access lexical declaration 'rows' before initialization),
   - 整个模型管理页直接白屏.判据函数本身不碰 rows,可以前置;
   - 但任何消费 rows 的派生值都必须排在它后面.
   */
  const staleCount = rows.filter((m) => !isLiveUpstream(m)).length
  const isAdmin = state.me.role === 'admin'
  // 屏蔽收费模型开关(读全局设置,默认开)
  let settings = { blockPremiumModels: true }
  try { settings = await api('/api/settings') } catch { /* 忽略 */ }
  const blockPremium = settings.blockPremiumModels !== false
  const blockToggleAttrs = {
    id: 'block-premium',
    type: 'checkbox',
    class: 'switch-input',
    onchange: need('saveBlockPremiumSetting'),
  }
  if (blockPremium) blockToggleAttrs.checked = ''
  if (state.me.role !== 'admin') blockToggleAttrs.disabled = ''

  const card = el('div', { id: 'models-card', class: 'card', style: 'margin-top:12px' }, [
    ...buildModelsHeader(isAdmin),
    ...buildModelsSwitchRow(blockToggleAttrs, blockPremium),
    ...buildModelsReconcileBar(upstream, staleCount, isAdmin),
    ...buildModelsTable(rows, isLiveUpstream, isAdmin),
    ...buildModelsEditor(data, isAdmin),
    ...(isAdmin && (data.hidden || []).length ? buildHiddenModelsArea(data) : []),
  ])
  view.append(card)
}
