import { t } from '../../locale/index.ts'
import { el, icon } from '../../lib/dom.ts'
import { state } from '../../lib/state.ts'
import { toast } from '../../lib/ui.ts'


/* ---------------- me ---------------- */
export async function renderMe(view: any) {
  view.innerHTML = ''
  const me = state.me
  const card = el('div', { class: 'card', style: 'max-width:720px' }, [
    el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
      el('h2', { style: 'margin:0' }, t('user.info')),
      el('span', { class: 'muted' }, me.role === 'admin' ? el('span', { class: 'badge admin' }, 'admin') : me.role),
    ]),
    // 定义列表
    el('div', { class: 'kv-list' }, [
      el('div', { class: 'kv' }, [el('span', { class: 'k muted' }, t('user.username')), el('span', { class: 'v' }, me.username)]),
      el('div', { class: 'kv' }, [el('span', { class: 'k muted' }, t('user.role')), el('span', { class: 'v' }, me.role === 'admin' ? t('user.roleAdmin') : t('user.roleUser'))]),
      el('div', { class: 'kv' }, [el('span', { class: 'k muted' }, t('user.scheduling')), el('span', { class: 'v' }, t('user.schedulingValue'))]),
    ]),
    // API Key 独立代码块
    el('label', { style: 'margin-top:20px' }, t('user.apiKeyBearer')),
    el('div', { class: 'key-block' }, [
      el('code', { class: 'mono', id: 'me-key', style: 'font-size:12px;word-break:break-all;flex:1;min-width:0' }, me.apiKey),
      el('button', { class: 'icon', title: t('common.copy'), onclick: async () => { await navigator.clipboard.writeText(me.apiKey).catch(() => {}); toast(t('common.copied')) } }, icon('copy', 14)),
    ]),
    el('p', { class: 'muted', style: 'margin-top:16px' }, t('user.downstreamHint')),
    // curl 示例:深色代码块,横向滚动不溢出卡片
    el('pre', { class: 'code-block mono' },
      `curl http://127.0.0.1:8787/v1/chat/completions \\\n  -H "Authorization: Bearer ${me.apiKey || 'sk-fb-…'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'`),
  ])
  view.append(card)
}
