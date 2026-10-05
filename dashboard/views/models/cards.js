import { t } from '../../locale/index.js'
import { el, icon } from '../../lib/dom.js'
import { need } from '../../lib/hooks.js'
import { modelNameFor, poolBadgeClass, poolLabel } from '../../lib/format/models.js'
import { fmtModelPrice } from '../../lib/format/quota.js'
import { state } from '../../lib/state.js'

/**
 * 模型管理页的六张卡片(纯渲染,无副作用).
 *
 * 为什么单独成文件:六张卡合计 160 行节点树,与[同步/清理/自定义增删]的控制
 * 逻辑挤在一起会双双超限.这里只保留[给数据 -> 出节点];事件回调一律走
 * need(name) 或本目录的构建函数,不直接引用控制逻辑.
 *
 * 本文件所有函数都只做 DOM 构造:不发请求,不写 state,不弹提示.
 */

/** 模型卡头部:标题 + 说明 + 管理员专属[同步上游模型]按钮. */
export function buildModelsHeader(isAdmin) {
  return [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('model.management')),
        el('span', { class: 'muted' }, t('model.syncHint')),
      ]),
      isAdmin
        ? el('div', { class: 'row' }, [
            el('button', { class: 'primary', onclick: need('syncUpstreamModels') }, [icon('refresh', 14), t('model.syncUpstream')]),
          ])
        : null,
    ]),
  ]
}

/** [屏蔽收费模型]开关行(读全局设置,默认开). */
export function buildModelsSwitchRow(blockToggleAttrs, blockPremium) {
  return [
    el('div', { class: 'row', style: 'margin-top:8px;align-items:center;gap:8px' }, [
      el('label', { class: 'switch', for: 'block-premium' }, [
        el('input', blockToggleAttrs),
        el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
        el('span', { class: 'switch-status' }, blockPremium ? t('common.on') : t('common.off')),
      ]),
      el('span', { class: 'muted', style: 'font-size:12px' }, t('model.blockPremium')),
    ]),
  ]
}

/** 对账条:上游目录条数 / 表中调不了的条数 / 一键清理入口. */
export function buildModelsReconcileBar(upstream, staleCount, isAdmin) {
  return [
    upstream.accessTier
      ? el('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' },
          t('model.upstreamCatalog', { n: upstream.models.length, tier: upstream.accessTier }))
      : null,
    /**
     - 对账条:先说清"表里哪些其实调不了",再说别的.
     *
     - 旧界面把 15 条内置 + 53 条自定义与上游 13 条平铺在同一张表里,
     - 没有任何一处告诉用户"这 55 个你的账号用不了"----
     - 用户只能一个个试,试到失败才知道.这里在表头上直接给总数与处置入口.
     */
    upstream.models?.length
      ? el('div', {
          class: 'row',
          style: 'margin-top:8px;gap:8px;align-items:center;flex-wrap:wrap',
        }, [
          el('span', { class: 'badge ok' }, t('model.liveCount', { n: upstream.models.length })),
          staleCount > 0
            ? el('span', { class: 'badge warn' }, t('model.staleCount', { n: staleCount }))
            : null,
          el('span', { class: 'muted', style: 'font-size:12px' }, t('model.staleHint')),
          isAdmin && staleCount > 0
            ? el('button', { class: 'icon danger', onclick: need('pruneStaleModels'), title: t('model.pruneTitle') },
                [icon('trash', 12), t('model.prune', { n: staleCount })])
            : null,
        ])
      : null,
  ]
}

/** 模型表:每行标注[账号可用 / 池类型 / 额度 / agent / 来源]. */
export function buildModelsTable(rows, isLiveUpstream, isAdmin) {
  return [
    el('div', { class: 'table-wrap', style: 'margin-top:10px;max-height:280px;overflow:auto' }, [
      el('table', { style: 'font-size:12px' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, t('model.id')),
          el('th', {}, t('model.displayName')),
          el('th', {}, t('model.liveHeader')),
          el('th', {}, t('model.pool')),
          el('th', {}, t('model.quotaHeader')),
          el('th', {}, t('model.agentBase2')),
          el('th', {}, t('model.fallbackAgentBase3')),
          el('th', {}, t('model.source')),
          isAdmin ? el('th', {}, t('common.actions')) : null,
        ])),
        el('tbody', {}, rows.map((m) => el('tr', {
          'data-key': m.key || m.id,
          // 上游目录里没有的行整体淡化:它在列表里只是占位,调用必然失败.
          // 视觉上必须与可用模型区分开,否则用户仍会一个个去试.
          style: isLiveUpstream(m) ? null : 'opacity:.45',
        }, [
          // 首列是对外模型名(口径 displayName || key,与 /v1/models 的 id 同源);
          // 目录 key(m-00032eaeec)退到 title 里 ---- 排障时仍要能对上上游日志,
          // 但不该再出现在页面上(用户要求).见
          // .agents/notes/implemented/bug-fix/2026-10-03-readable-model-id-unification.md
          el('td', {
            style: 'font-family:var(--mono);font-size:11px',
            title: m.key && m.key !== m.id ? t('model.idHint') + `: ${m.key}` : null,
          }, m.id),
          el('td', {}, m.display_name || m.displayName || '—'),
          /**
           - [账号可用]列:上游目录里有 = 能调用;没有 = 调了必失败.
           - 悬停给出处置建议(隐藏或移除),让"为什么用不了"有答案.
           */
          el('td', {}, isLiveUpstream(m)
            ? el('span', { class: 'badge ok', title: t('model.liveYesTitle') }, t('model.liveYes'))
            : el('span', { class: 'badge warn', title: t('model.liveNoTitle') }, t('model.liveNo'))),
          el('td', {}, el('span', { class: 'badge', class: poolBadgeClass(m.pool) }, poolLabel(m.pool))),
          el('td', {}, fmtModelPrice(m)),
          el('td', { style: 'font-family:var(--mono);font-size:11px' }, m.agentId || m.agent_id || t('common.none')),
          el('td', { style: 'font-family:var(--mono);font-size:11px' }, m.fallbackAgentId || m.fallback_agent_id || t('common.none')),
          el('td', {}, m.source === 'upstream'
            ? el('span', { class: 'badge ok' }, t('model.sourceUpstream'))
            : el('span', { class: 'badge' }, t('model.sourceBuiltin'))),
          isAdmin
            ? el('td', {}, el('button', {
                class: 'icon danger',
                title: t('model.deleteTitle'),
                // 删除/隐藏提交目录 key 而非展示 id:hidden 表与调度同口径(key),
                // 用可读名提交会隐藏不掉(白名单仍按 key 放行).
                onclick: () => need('removeCustomModel')(m.key || m.id, m.id),
              }, icon('trash', 13)))
            : null,
        ]))),
      ]),
    ]),
  ]
}

/** 自定义模型可视化编辑区(行内编辑自动保存). */
export function buildModelsEditor(data, isAdmin) {
  return [
    el('div', { style: 'margin-top:14px' }, [
      el('label', { class: 'muted' }, t('model.customLabel')),
      el('div', { id: 'custom-models-editor', style: 'margin-top:6px' }, need('buildCustomModelRows')(data.models || [])),
      el('div', { class: 'row', style: 'margin-top:8px' }, [
        isAdmin
          ? el('button', { onclick: () => need('addCustomModelRow')() }, [icon('plus', 13), t('model.add')])
          : null,
        el('span', { class: 'muted', style: 'font-size:12px' }, t('model.overrideHint')),
      ]),
    ]),
  ]
}

/** 被删除(隐藏)的模型恢复区;调用方负责只在有条目时渲染. */
export function buildHiddenModelsArea(data) {
  return [
    el('div', { id: 'hidden-models-area', style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--border)' }, [
      el('label', { class: 'muted' }, t('model.hiddenArea', { n: data.hidden.length })),
      el('div', { class: 'hidden-badges row', style: 'margin-top:6px;gap:6px;flex-wrap:wrap' }, (data.hidden || []).map((id) =>
        el('span', { class: 'badge', style: 'display:inline-flex;align-items:center;gap:6px' }, [
          // hidden 列表存的是服务端口径(目录 key / catalog id);
          // 显示走统一映射,别把 m-00032eaeec 再弹回给用户.
          el('code', { style: 'font-family:var(--mono);font-size:11px', title: id }, modelNameFor(id)),
          el('button', {
            class: 'icon', title: t('model.restoreTitle'),
            onclick: () => need('restoreCustomModel')(id),
          }, icon('refresh', 12)),
        ]),
      )),
    ]),
  ]
}
