import { t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { $, el, icon } from '../../lib/dom.ts'
import { upstreamReadableIds } from '../../lib/format/models.ts'
import { state } from '../../lib/state.ts'
import { toast, withButtonLoading } from '../../lib/ui.ts'


/* ---------------- playground ---------------- */
/**
 - 测试对话的模型下拉:全量可用模型,并且分级标注.
 *
 - 以前只留 available !== false,而 available 曾错误地由上游 accessTier 决定,
 - 于是 accessTier=limited 时整张表只剩 1 个模型(用户反馈的"只有一个模型").
 - 现在:
 - - 目录条目一律可用(available 只表示'能不能请求',见 src/model.ts);
 - - 上游此刻真给了额度的模型(upstreamModelIds)标  并排在最前;
 - - 被[模型管理]隐藏的(hidden)压根不会出现在 /api/models 里;
 - - 被一键屏蔽收费模型开关排除的 premium 模型也不在列表里.
 - 拿不到上游目录时不隐藏任何模型:宁可多列,也不让用户以为只剩一个.
 */
async function loadPlaygroundModels() {
  let models = []
  // 上游给了额度的模型:用可读 id 建集合(/api/models 的 id 现在是
  // catalogId / displayName / key 三选一,拿目录 key 直接比会全部漏标).
  let upstreamIds = upstreamReadableIds()
  let note = ''
  try {
    const list = await api('/api/models')
    models = Array.isArray(list.data) ? list.data : []
    /**
     - 目录驱动:把本轮模型列表留档,upstreamReadableIds() 据此按
     - rate_limit 标 (不再依赖只有 6 个键的 rateLimitsByModel).
     */
    state.catalogModels = models
    if (Array.isArray(list.upstreamModelIds)) {
      state.upstreamModelIds = list.upstreamModelIds
    }
    if (Array.isArray(list.upstreamModels)) {
      state.upstreamModels = list.upstreamModels
    }
    upstreamIds = upstreamReadableIds()
    /**
     - notProbed 与"目录为空"是两回事:前者是还没探测(服务不自动探测,
     - docs/reverse/20 §20.3),出路是点[一键刷新];后者才是真的没模型.
     - 混为一谈会让用户以为账号有问题.
     */
    if (!models.length) {
      note = list?.notProbed
        ? t('playground.notProbed')
        : t('playground.catalogEmpty')
    }
  } catch (err) {
    note = t('playground.catalogLoadFail', { msg: err.message })
  }
  // 排序:上游确有额度的在前(可直接用),其余按 id 稳定排序
  const scored = models.map((m: any) => ({ ...m, hasQuota: upstreamIds.has(m.id) }))
  scored.sort((a: any, b: any) => (Number(b.hasQuota) - Number(a.hasQuota)) || String(a.id).localeCompare(String(b.id)))
  return { models: scored, note, upstreamCount: upstreamIds.size }
}

export async function renderPlayground(view: any) {
  view.innerHTML = ''
  const { models, note, upstreamCount } = await loadPlaygroundModels()

  view.append(el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
    el('h2', { style: 'margin:0' }, t('playground.title')),
    el('span', { class: 'muted' }, t('playground.subtitle')),
  ]))
  const defaultModel = models.find((m: any) => m.id === 'deepseek/deepseek-v4-flash') || models[0]
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr))' }, [
      el('div', {}, [
        el('label', {}, t('playground.modelSelect', { n: models.length, extra: upstreamCount ? t('playground.modelQuotaSuffix', { n: upstreamCount }) : '' })),
        el('select', { id: 'pg-model' }, models.map((m: any) => el('option', {
          value: m.id,
          selected: defaultModel && m.id === defaultModel.id,
        }, `${m.hasQuota ? ' ' : ''}${m.id}`))),
        el('div', { class: 'row', style: 'margin-top:6px;gap:8px;align-items:center' }, [
          el('button', { class: 'muted', style: 'padding:4px 10px;font-size:12px', onclick: (e: any) => reloadPlaygroundModels(e.currentTarget) },
            [icon('refresh', 12), t('playground.reloadModels')]),
          el('span', { class: 'muted', style: 'font-size:11px' }, t('playground.checkMark')),
        ]),
        note ? el('div', { class: 'muted', style: 'margin-top:4px;font-size:11px' }, note) : null,
      ]),
      el('div', {}, [
        el('label', {}, t('playground.apiKey')),
        el('input', { id: 'pg-key', value: state.me.apiKey, class: 'mono' }),
      ]),
    ]),
    el('label', {}, t('playground.message')),
    el('textarea', { id: 'pg-msg', rows: 4, placeholder: t('playground.messagePlaceholder') }),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', onclick: sendChat }, [icon('chat', 14), t('playground.send')]),
    ]),
    el('div', { class: 'chat-log', id: 'pg-log', style: 'margin-top:12px' }, ''),
  ])
  view.append(card)
}

/** 就地重建模型下拉(只替换 select 的选项,不清空已输入的消息/日志). */
async function reloadPlaygroundModels(btn: any) {
  const restore = withButtonLoading(btn)
  try {
    const { models, upstreamCount } = await loadPlaygroundModels()
    const sel = $('#pg-model')
    if (!sel) return
    const prev = sel.value
    const defaultModel = models.find((m: any) => m.id === 'deepseek/deepseek-v4-flash') || models[0]
    sel.replaceChildren(...models.map((m: any) => el('option', { value: m.id },
      `${m.hasQuota ? ' ' : ''}${m.id}`)))
    sel.value = models.some((m: any) => m.id === prev) ? prev : (defaultModel ? defaultModel.id : '')
    toast(t('playground.modelsReloaded', { n: models.length, extra: upstreamCount ? t('playground.modelsReloadedSuffix', { n: upstreamCount }) : '' }))
  } catch (err) {
    toast(err.message, true)
  } finally {
    restore()
  }
}

async function sendChat() {
  const log = $('#pg-log')
  const model = $('#pg-model').value
  const key = $('#pg-key').value.trim()
  const raw = $('#pg-msg').value.trim()
  if (!model || !raw) return
  const messages = raw.split('\n').filter(Boolean).map((line: any) => {
    const m = line.match(/^(user|assistant|system):\s*(.*)$/i)
    return m ? { role: m[1].toLowerCase(), content: m[2] } : { role: 'user', content: line }
  })
  log.textContent = ''
  log.append(el('div', { class: 'user' }, [icon('user', 12), ' ' + raw.split('\n')[0] + (raw.split('\n').length > 1 ? ' …' : '')]))
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, stream: true }),
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { const j = await res.json(); msg = j.error?.message || j.error || msg } catch { /* noop */ }
      log.append(el('div', { class: 'assistant', style: 'color:var(--red)' }, t('playground.errorPrefix') + msg))
      return
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let out = el('div', { class: 'assistant assistant-typing' }, '')
    log.append(out)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          const delta = j.choices?.[0]?.delta?.content || ''
          if (delta) out.textContent += delta
        } catch { /* partial line */ }
      }
      log.scrollTop = log.scrollHeight
    }
    out.classList.remove('assistant-typing')
  } catch (err) {
    log.append(el('div', { style: 'color:var(--red)' }, t('playground.errorPrefix') + err.message))
  }
}
