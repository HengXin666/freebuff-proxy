import { t } from '../../locale/index.js'
import { api } from '../../lib/api.js'
import { $, el } from '../../lib/dom.js'
import { need } from '../../lib/hooks.js'
import { modelNameFor } from '../../lib/format/models.js'
import { state } from '../../lib/state.js'
import { toast, withButtonLoading } from '../../lib/ui.js'

/**
 * 模型管理的[与上游对账]动作:局部刷新 / 同步上游目录 / 清理陈旧条目 / 同步报告.
 *
 * 这些动作的共同点:都会改写 /api/models 的数据,并且都要让用户看见[改了什么].
 * 与 custom.js 的分界:custom.js 改的是[用户手填的],本文件改的是[从上游抄来的].
 */

/** 模型管理卡片局部刷新:只重建 models-card,不重渲染整页 */
export async function refreshModelSettingsCard() {
  const wrap = document.createElement('div')
  await need('renderModelSettings')(wrap)
  const card = wrap.querySelector('#models-card')
  const old = $('#models-card')
  if (card && old) old.replaceWith(card)
}

/** 同步上游模型:只补[上游有,catalog 没有]的新模型,catalog 已有的不写入自定义.
 - 删除语义:内置模型删除=隐藏(同步会按最新上游完整拉回,不永久卡在 hidden);
 - 手动添加的自定义模型删除=彻底移除(上游没有它,同步自然不会回来). */
export async function syncUpstreamModels() {
  const btn = document.querySelector('#models-card .primary, .card .primary')
  let upstream
  try {
    upstream = await api('/api/models/upstream')
  } catch (err) {
    toast(t('model.fetchFail', { msg: err.message }), true)
    return
  }
  /**
   - [上游暂无可用模型]的触发条件必须是目录抓取失败,不是列表为空.
   *
   - 此前判的是 models.length === 0,而列表来自会话回执的 rateLimitsByModel
   - (今日给了额度的子集,实测只有 6 个键)---- 额度耗尽/当日额度为 0 时它天然
   - 为空,于是[同步]永远弹这一句,实际模型一个都没少.
   - 后端现在在目录抓取失败时会带 catalogError: true.
   */
  if (upstream.catalogError) {
    toast(
      t('model.catalogFail', {
        msg:
          upstream.notProbed
            ? t('playground.notProbed')
            : upstream.note || t('model.noneUpstream'),
      }),
      true,
    )
    return
  }
  if (!upstream.models?.length) {
    toast(t('model.noneUpstream'), true)
    return
  }
  try {
    // 现有自定义模型(id → 定义),保留用户手动配置与彻底移除语义
    const cur = await api('/api/models/custom')
    const curById = new Map((cur.models || []).map((m) => [m.id, m]))
    // catalog 已有 id:同步绝不固化这些(catalog 就是权威,写进自定义只会冗余/错覆盖)
    const catalogSet = new Set((cur.catalog || []).map((m) => m.id))
    // merged = 保留现有自定义 +(上游有 & catalog 没有的)新模型
    // 内置被隐藏(hidden)的模型:同步按最新上游完整拉回(用户选[删除只影响当前列表])
    const merged = []
    for (const [id, m] of curById) merged.push(m) // 保留已存在的自定义/覆盖
    for (const um of upstream.models) {
      //  后端现在给的 um.id 已经是可读模型名(目录行 displayName,
      // 如 "DeepSeek V4.1 Flash"),不再是目录 key.
      // catalogId 只是 legacy 反查的兼容字段,上游新增模型没有 legacyDigests
      // (实测 Ling 3.1 Flash / Laguna S 2.1 都没有),此时它为空 ----
      // 绝不能因为 catalogId 为空就丢掉整行,否则新模型永远同步不进来.
      // 取值顺序反过来:优先 um.id(目录真值),catalogId 仅作兜底.
      const id = um.id || um.catalogId || um.key
      if (!id) continue
      if (catalogSet.has(id)) continue // catalog 已有,不用写自定义
      const existing = curById.get(id) || {}
      merged.push({
        id,
        displayName: existing.displayName || um.displayName || um.id || '',
        // 收费模型(premium)走热 session 复用调度,别按 daily 平摊到多账号
        pool: existing.pool || (um.premium ? 'premium' : um.pool || 'daily'),
        agentId: existing.agentId || um.agentId || '',
        fallbackAgentId: existing.fallbackAgentId || um.fallbackAgentId || '',
      })
    }
    const r = await api('/api/models/custom', {
      method: 'POST',
      body: JSON.stringify({ models: merged }),
    })
    // save() 会把写回的自定义条目自动解除 hidden----被隐藏的内置模型同步后自然拉回
    /**
     - 同步结果必须是对齐报告,不能只报"写了几条自定义".
     *
     - 用户原话:点刷新应当是[同步上游],而列表里那些账号用不了的
     - (内置/手动添加,上游目录里根本不存在的)留着就是误导 ----
     - 旧文案只说[自定义 {n} 条],数字越大用户越以为同步成功,
     - 实际那 53 条里绝大部分上游压根没有,调用必然失败.
     *
     - 所以这里按[上游真实目录]为基准做三向对账并如实报数:
     - - aligned:上游有,列表也有 → 能调用
     - - added:  上游有,列表原本没有 → 本次补进来的
     - - stale:  列表有,上游目录里没有 → 账号调用不了(提示可一键清理)
     */
    const upstreamIds = new Set(
      (upstream.models || []).map((m) => m.id || m.catalogId || m.key).filter(Boolean),
    )
    const listIds = new Set([
      ...(cur.catalog || []).map((m) => m.id),
      ...merged.map((m) => m.id),
    ])
    let aligned = 0
    for (const id of upstreamIds) if (listIds.has(id)) aligned += 1
    const stale = [...listIds].filter((id) => !upstreamIds.has(id)).length
    await showSyncReport({ aligned, added: upstreamIds.size - aligned, stale, total: upstreamIds.size })
    refreshModelSettingsCard()
  } catch (err) {
    toast(t('model.syncFail', { msg: err.message }), true)
  }
}

/**
 - 同步后的对齐报告弹窗.
 *
 - 为什么不用 toast:toast 一闪而过,而[哪些模型其实调不了]是用户必须
 - 能看清,能据此操作的结论(旧实现把它塞进一行 toast,用户根本来不及读).
 - 这里用模态,把三向对账的数字与处置动作一起给全:
 - 只有 stale > 0 时才显示[清理不可用模型]按钮 ---- 没有脏数据时
 - 多一个按钮就是噪音.
 */
export function showSyncReport({ aligned, added, stale, total }) {
  return new Promise((resolve) => {
    const close = () => {
      document.querySelector('#sync-report-backdrop')?.remove()
      resolve()
    }
    const backdrop = el('div', {
      id: 'sync-report-backdrop',
      class: 'modal-backdrop',
      onclick: (e) => {
        if (e.target?.id === 'sync-report-backdrop') close()
      },
    }, [
      el('div', { class: 'modal', style: 'max-width:420px' }, [
        el('h3', { style: 'margin:0 0 10px' }, t('model.syncReportTitle')),
        el('div', { class: 'row', style: 'gap:10px;margin-bottom:8px' }, [
          el('span', { class: 'badge ok' }, t('model.syncReportAligned', { n: total })),
          added > 0 ? el('span', { class: 'badge' }, t('model.syncReportAdded', { n: added })) : null,
          stale > 0 ? el('span', { class: 'badge warn' }, t('model.syncReportStale', { n: stale })) : null,
        ]),
        el('p', { class: 'muted', style: 'margin:0 0 4px;font-size:12px;line-height:1.6' },
          t('model.syncReportBody')),
        stale > 0
          ? el('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px;line-height:1.6' },
              t('model.syncReportStaleHint', { n: stale }))
          : null,
        el('div', { class: 'row', style: 'margin-top:14px;justify-content:flex-end;gap:8px' }, [
          stale > 0
            ? el('button', { class: 'danger', onclick: async () => { close(); await pruneStaleModels() } },
                t('model.syncReportPrune', { n: stale }))
            : null,
          el('button', { class: 'primary', onclick: close }, t('common.ok')),
        ]),
      ]),
    ])
    document.body.append(backdrop)
  })
}

/**
 - 一键清理[不在上游目录里]的模型(内置=隐藏,自定义=彻底移除).
 *
 - 幂等且可恢复:内置模型走 hidden(可在[已删除的模型]区点回来),
 - 手动添加的走彻底移除(上游没有它,留着只能误导).
 */
export async function pruneStaleModels() {
  try {
    const [up, cur] = await Promise.all([
      api('/api/models/upstream'),
      api('/api/models/custom'),
    ])
    const upstreamIds = new Set(
      (up.models || []).map((m) => m.id || m.catalogId || m.key).filter(Boolean),
    )
    const builtinIds = new Set((cur.catalog || []).map((m) => m.id))
    const staleBuiltin = []
    const staleCustom = []
    for (const m of cur.catalog || []) {
      if (!upstreamIds.has(m.id)) staleBuiltin.push(m.key || m.id)
    }
    for (const m of cur.models || []) {
      if (!upstreamIds.has(m.id) && !builtinIds.has(m.id)) staleCustom.push(m.id)
    }
    for (const id of staleBuiltin) {
      await api('/api/models/custom/hide', { method: 'POST', body: JSON.stringify({ id }) })
    }
    for (const id of staleCustom) {
      await api('/api/models/custom/remove', { method: 'POST', body: JSON.stringify({ id }) })
    }
    toast(t('model.pruned', { n: staleBuiltin.length + staleCustom.length }))
    refreshModelSettingsCard()
  } catch (err) {
    toast(t('model.pruneFail', { msg: err.message }), true)
  }
}
