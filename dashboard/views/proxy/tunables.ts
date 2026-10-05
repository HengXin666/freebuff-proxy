import { t } from '../../locale/index.ts'
import { el, icon } from '../../lib/dom.ts'

/**
 * [系统设置]页的可调项卡片 ---- 除 server.host/port 外的全部配置项.
 *
 * ## 与同一页其它卡片的区别(重要)
 *
 * 其它卡片(负载均衡 / 额度保护 / 工具签名...)走的是 /data/settings.json 的
 * 实时 getter, 保存即生效. 本卡片走的是启动合并通道: 值写进
 * settings.json 的可调项路径, 下次启动时合并进 config 才生效.
 *
 *
 *
 * 控件类型/范围/分组/标签全部来自后端的 tunableSpecs(真源
 * src/config/tunables.ts). 前端不写第二份清单;
 * 两处, 而忘改的那处会以"页面少一个控件"的形式静默存在(不报错, 只是没人发现).
 *
 * 本文件只做 DOM 构造: 不发请求, 不写 state, 不弹提示.
 */

/** 分组标题的显示顺序与文案 key. */
const GROUP_ORDER = ['upstream', 'session', 'limits', 'logging', 'web', 'users', 'server']

/**
 * 按声明渲染一张可调项卡片.
 * @param {Array<any>} specs 可调项声明(来自 /api/settings 的 tunableSpecs)
 * @param {Record<string, any>} values 当前生效值(来自 /api/settings 的 tunables)
 * @returns {any} 卡片节点
 */
export function buildTunablesCard(specs: any, values: any) {
  const list = Array.isArray(specs) ? specs : []
  const byGroup = new Map()
  for (const s of list) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, [])
    byGroup.get(s.group).push(s)
  }
  const groups = GROUP_ORDER.filter((g) => byGroup.has(g))

  const card = el('div', { class: 'card settings-band', id: 'tunables-card', style: 'margin-top:12px' })
  card.append(el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('tunables.title')),
      el('span', { class: 'muted' }, t('tunables.hint')),
    ]),
    el('button', { class: 'primary', onclick: () => saveTunablesCard() }, [icon('check', 13), t('common.saveApply')]),
  ]))

  // 重启提示:这是本卡片与同页其它卡片的唯一契约差别, 必须显眼.
  card.append(el('div', { class: 'muted', id: 'tunables-restart-note', style: 'margin-top:8px;font-size:12px' },
    t('tunables.restartNote')))

  for (const g of groups) {
    const rows = byGroup.get(g).map((s: any) => renderRow(s, values?.[s.path]))
    card.append(el('div', { style: 'margin-top:12px' }, [
      el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px' }, groupLabel(g)),
      el('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px 18px' }, rows),
    ]))
  }
  return card
}

/**
 * 渲染单个可调项控件(类型由声明决定).
 * @param {any} spec 项声明
 * @param {any} value 当前值
 * @returns {any} 控件节点
 */
function renderRow(spec: any, value: any) {
  const inputId = `tunable-${spec.path.replace(/\./g, '-')}`
  const label = el('label', { for: inputId, style: 'font-size:12px' }, spec.label)
  let control
  if (spec.type === 'boolean') {
    control = el('input', {
      id: inputId, type: 'checkbox', 'data-path': spec.path, class: 'tunable-input',
      ...(value === true ? { checked: '' } : {}),
    })
  } else if (spec.type === 'enum') {
    control = el('select', { id: inputId, 'data-path': spec.path, class: 'tunable-input' },
      (spec.values || []).map((v: any) =>
        el('option', { value: v, ...(v === value ? { selected: '' } : {}) }, v)))
  } else {
    // integer / string 都走文本框; integer 由后端按声明校验范围.
    // stringList 用逗号分隔(与 config.yaml 的数组语义一致, 且一行可读).
    const shown = spec.type === 'stringList'
      ? (Array.isArray(value) ? value.join(',') : '')
      : (value === null || value === undefined ? '' : String(value))
    control = el('input', {
      id: inputId, type: 'text', 'data-path': spec.path, class: 'tunable-input',
      value: shown, style: 'width:120px',
      ...(spec.type === 'integer' ? { inputmode: 'numeric' } : {}),
    })
  }
  return el('div', { class: 'row', style: 'gap:6px;align-items:center' }, [label, control])
}

/**
 * 把可调项控件的当前值收成补丁并提交.
 *
 * 收值必须按声明类型做, 不能一律当字符串:
 * 后端按声明校验(整数会被判"必须是整数"), 传字符串会稳定 400.
 * @returns {Promise<void>} 提交完成即 resolve
 */
async function saveTunablesCard() {
  const { api } = await import('../../lib/api.ts')
  const { toast } = await import('../../lib/ui.ts')
  const inputs = Array.from(document.querySelectorAll('.tunable-input')) as any[]
  const patch: Record<string, any> = {}
  for (const input of inputs) {
    const path = input.getAttribute('data-path')
    if (!path) continue
    const kind = input.tagName === 'SELECT' ? 'enum' : input.type === 'checkbox' ? 'boolean' : 'text'
    if (kind === 'boolean') patch[path] = input.checked
    else if (kind === 'enum') patch[path] = input.value
    else {
      const raw = String(input.value ?? '').trim()
      // 空字符串 + 路径尾段看起来是"数字项"的情况: 交给后端判(它会给出准确文案),
      // 这里只做"能确定是数字就转数字"这一步 ---- 不做就没法通过整数校验.
      patch[path] = raw
      const numeric = needsNumber(path)
      if (numeric) {
        if (raw === '') continue // 留空 = 不改这一项
        patch[path] = Number(raw)
      } else if (path.endsWith('defaultAdminPassword') && raw === '') {
        patch[path] = null // 该字段 null = 随机生成, 是合法值
      }
    }
  }
  try {
    const res = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) })
    if (res?.restartRequired) toast(t('tunables.savedNeedRestart'))
    else toast(t('common.saved'))
  } catch (err: any) {
    toast(err.message, true)
  }
}

/**
 * 该路径是否应转成数字再提交.
 *
 * @param {string} path 配置路径
 * @returns {boolean} 是否按数字提交
 */
function needsNumber(path: string) {
  return !/^upstream\.loginBase$|^users\.defaultAdmin/.test(path)
}

/** 分组标题文案. */
function groupLabel(group: string) {
  const KEY: Record<string, string> = {
    upstream: 'tunables.groupUpstream',
    session: 'tunables.groupSession',
    limits: 'tunables.groupLimits',
    logging: 'tunables.groupLogging',
    web: 'tunables.groupWeb',
    users: 'tunables.groupUsers',
    server: 'tunables.groupServer',
  }
  return t(KEY[group] || group)
}
