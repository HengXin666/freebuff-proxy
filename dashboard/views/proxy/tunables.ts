import { t } from '../../locale/index.ts'
import { el, icon } from '../../lib/dom.ts'
import { state } from '../../lib/state.ts'

/**
 * [系统设置]页的可调项卡片 ---- 除 server.host/port 外的全部配置项.
 *
 * ## 与同一页其它卡片的区别(重要)
 *
 * 其它卡片(负载均衡 / 额度保护 / 工具签名...)走的是 /data/settings.json 的
 * 实时 getter, 保存即生效. 本卡片走的是启动合并通道: 值写进
 * settings.json 的可调项路径, 下次启动时合并进 config 才生效.
 *
 * 控件类型/范围/分组/标签全部来自后端的 tunableSpecs(真源
 * src/config/tunable/specs.ts). 前端不写第二份清单.
 *
 * ## 两处必须在这里(而不是别处)保证的事
 *
 * 1. 凭据项只写不回显. 标了 secret 的项(超级 API Key / 默认管理员密码)
 *    后端 GET 一律不回真值, 只回[有没有设置]. 前端因此拿不到明文, 也不需要
 *    第二套屏蔽逻辑 ---- 屏蔽发生在真源那一层, 任何新加的读取方都自动受保护.
 * 2. 标签与控件必须成对. 每一项渲染成[标签在上, 控件在下]的竖排一项,
 *    再放进两列网格. 早先是 label 与 input 横向塞进一个 flex 容器里换行排,
 *    于是[这个标签管的是左边还是右边那个框]在视觉上完全无法判断(用户原话:
 *    "谁知道你这个文本对应的是前面那个输入框, 还是后面那个输入框").
 *
 * 本文件只做 DOM 构造: 不发请求, 不写 state, 不弹提示.
 */

/** 分组标题的显示顺序与文案 key. */
const GROUP_ORDER = ['upstream', 'session', 'limits', 'logging', 'web', 'users', 'server']

/** 留空即不改的提示文案 key(凭据项与普通文本项共用). */
const HINT_KEY: Record<string, string> = {
  'upstream.loginBase': 'tunables.hintLoginBase',
}

/**
 * 按声明渲染一张可调项卡片.
 * @param {Array<any>} specs 可调项声明(来自 /api/settings 的 tunableSpecs)
 * @param {Record<string, any>} values 当前生效值(来自 /api/settings 的 tunables)
 * @param {Record<string, boolean>} [secretsSet] 凭据项是否已设置(后端只回布尔)
 * @returns {any} 卡片节点
 */
export function buildTunablesCard(specs: any, values: any, secretsSet: any = {}) {
  const list = Array.isArray(specs) ? specs : []
  // 非 admin 是只读态: 控件禁用 + 不摆保存按钮 ---- 摆了也只会拿到 403,
  // 而那正是"按了才知道没权限"的糟糕体验.
  const editable = state.me?.role === 'admin'
  const byGroup = new Map()
  for (const s of list) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, [])
    byGroup.get(s.group).push(s)
  }
  const groups = GROUP_ORDER.filter((g) => byGroup.has(g))

  const card = el('div', { class: 'card', id: 'tunables-card' })
  card.append(el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('tunables.title')),
      el('span', { class: 'muted' }, editable ? t('tunables.hint') : t('tunables.readonlyHint')),
    ]),
    editable
      ? el('button', { class: 'primary', onclick: () => saveTunablesCard() },
        [icon('check', 13), t('common.saveApply')])
      : null,
  ]))

  // 重启提示:这是本卡片与同页其它卡片的唯一契约差别, 必须显眼.
  card.append(el('div', { class: 'muted', id: 'tunables-restart-note' }, t('tunables.restartNote')))

  for (const g of groups) {
    const rows = byGroup
      .get(g)
      .map((s: any) => renderRow(s, values?.[s.path], secretsSet?.[s.path] === true, editable))
    card.append(el('div', { class: 'tunable-group' }, [
      el('div', { class: 'tunable-group-title' }, groupLabel(g)),
      el('div', { class: 'tunable-rows' }, rows),
    ]))
  }
  return card
}

/**
 * 渲染单个可调项: [标签 + 说明] 在上, [控件] 在下的竖排一项.
 * @param {any} spec 项声明
 * @param {any} value 当前值(凭据项恒为空 ---- 后端不回真值)
 * @param {boolean} secretSet 该项是否已设置(仅凭据项有意义)
 * @param {boolean} editable 当前用户是否可改(非 admin 时控件禁用)
 * @returns {any} 一项节点
 */
function renderRow(spec: any, value: any, secretSet: boolean, editable: boolean) {
  const inputId = `tunable-${spec.path.replace(/\./g, '-')}`
  const control = buildControl(spec, value, inputId, secretSet, editable)
  const hint = hintFor(spec, secretSet)
  return el('div', { class: 'tunable-item' }, [
    el('label', { class: 'tunable-item-label', for: inputId }, spec.label),
    control,
    hint ? el('div', { class: 'tunable-item-hint muted' }, hint) : null,
  ])
}

/**
 * 按声明类型构造控件.
 *
 * 凭据项用 type=password 且不预填: 后端不回真值, 这里留空表示[不改],
 * 输入即替换. 这样界面上永远不会出现明文凭据, 也不需要"显示/隐藏"这类
 * 只是把明文再摆一遍的开关.
 * @param {any} spec 项声明
 * @param {any} value 当前值
 * @param {string} inputId 控件 id
 * @param {boolean} secretSet 凭据项是否已设置
 * @param {boolean} editable 是否可改
 * @returns {any} 控件节点
 */
function buildControl(spec: any, value: any, inputId: string, secretSet: boolean, editable: boolean) {
  const ro = editable ? {} : { disabled: '' }
  if (spec.type === 'boolean') {
    return el('input', {
      id: inputId, type: 'checkbox', 'data-path': spec.path, class: 'tunable-input',
      ...(value === true ? { checked: '' } : {}), ...ro,
    })
  }
  if (spec.type === 'enum') {
    return el('select', { id: inputId, 'data-path': spec.path, class: 'tunable-input', ...ro },
      (spec.values || []).map((v: any) =>
        el('option', { value: v, ...(v === value ? { selected: '' } : {}) }, v)))
  }
  // integer / string / stringList 都走文本框; 校验范围在后端按声明做.
  // stringList 用逗号分隔(与 config.yaml 的数组语义一致, 且一行可读).
  // 收值侧按 data-type 判类型, 不再靠[路径长得像数字]来猜 ---- 猜错会让
  // 字符串项(如登录站点)被转成数字, 或被后端按整数校验直接 400.
  const shown = spec.secret
    ? ''
    : spec.type === 'stringList'
      ? (Array.isArray(value) ? value.join(',') : '')
      : (value === null || value === undefined ? '' : String(value))
  return el('input', {
    id: inputId,
    type: spec.secret ? 'password' : 'text',
    autocomplete: 'off',
    'data-path': spec.path,
    'data-type': spec.type,
    'data-secret': spec.secret ? '1' : null,
    class: 'tunable-input',
    value: shown,
    ...(spec.secret && secretSet ? { placeholder: t('tunables.secretPlaceholderSet') } : {}),
    ...(spec.type === 'integer' ? { inputmode: 'numeric' } : {}),
    ...ro,
  })
}

/**
 * 单项说明文案(没有则返回空串, 由调用方跳过该节点).
 *
 * 说明只讲[这一项的值从哪来,留空会怎样], 与该项自己相关;
 * 组级说明在分组标题那一行, 不在这里重复.
 * @param {any} spec 项声明
 * @param {boolean} secretSet 凭据项是否已设置
 * @returns {string} 说明文案
 */
function hintFor(spec: any, secretSet: boolean) {
  if (spec.secret) {
    return secretSet ? t('tunables.hintSecretSet') : t('tunables.hintSecretUnset')
  }
  if (spec.zeroMeansOff) return t('tunables.hintZeroMeansOff')
  const key = HINT_KEY[spec.path]
  return key ? t(key) : ''
}

/**
 * 把可调项控件的当前值收成补丁并提交.
 *
 * 收值必须按声明类型做, 不能一律当字符串:
 * 后端按声明校验(整数会被判"必须是整数"), 传字符串会稳定 400.
 *
 * 凭据项的两种特例(都在这一个循环里判掉, 不留给后端猜):
 *   - 空输入 = 不改这一项(不回显真值, 所以"空"必须是"保持原样");
 *   - 非空 stringList 按逗号切分, 空串成员丢弃.
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
    if (input.tagName === 'SELECT') {
      patch[path] = input.value
      continue
    }
    if (input.type === 'checkbox') {
      patch[path] = input.checked
      continue
    }
    const raw = String(input.value ?? '').trim()
    // 留空 = 不改这一项. 凭据项因此"不填就保持原样", 普通项也不会被清成空值.
    if (raw === '') continue
    const kind = input.getAttribute('data-type')
    patch[path] = kind === 'integer' ? Number(raw)
      : kind === 'stringList' ? splitList(raw)
        : raw
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
 * 逗号分隔文本 → 字符串数组(去空白, 丢空项).
 * @param {string} raw 输入原文
 * @returns {string[]} 清洗后的列表
 */
function splitList(raw: string) {
  return raw.split(',').map((x) => x.trim()).filter(Boolean)
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
