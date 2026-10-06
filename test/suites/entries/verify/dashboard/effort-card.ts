/**
 * 思考强度卡: 结构 + 逐模型区分 + 开关语义(用真记账 DOM 桩).
 *
 * 判据(可证伪): 把 effortRow 的档位来源从 item.efforts 改成全局 EFFORTS,
 * 或把开关默认态改成 on, 本文件即红.
 */
import assert from 'node:assert/strict'
import { installDomStub } from '../../../../helpers/dom-stub.ts'

const { document, body } = installDomStub()

const { buildEffortOverrideCard } = await import(
  '../../../../../dashboard/views/proxy/inject/effort.ts'
)

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

/** 已选芯片(桩只支持单类选择器, 故按 data-on 过滤). */
const chosen = (node: any) =>
  [...node.querySelectorAll('.effort-chip')].filter((c: any) => c.attrs['data-on'] === '1')

const MODELS = [
  { key: 'm-aaa', name: 'MiMo 2.6 Flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  { key: 'm-ccc', name: 'Gemini 3.8 Flash', efforts: ['high'], defaultEffort: 'high' },
  { key: 'm-bbb', name: 'Solar Pro 4', efforts: null, defaultEffort: null },
]

/**
 * 渲染一次卡片并挂到 body.
 *
 * @param {any} override reasoningOverride 配置
 * @returns {any} 卡片元素
 */
function mount(override: any) {
  const card = buildEffortOverrideCard(override, MODELS, false, () => {})
  body.append(card)
  return card
}

// -- (1) 默认关闭: 开关不勾选, 状态行是[未启用] --------------------------
{
  const card = mount({ enabled: false, models: [] })
  const box: any = card.querySelector('#effort-override')
  ok(box && box.id === 'effort-override', '必须渲染总开关')
  ok(box.attrs.checked === undefined, '默认必须不勾选(功能默认关闭)')
  ok(chosen(card).length === 0, '默认不得有任何已选档位')
}

// -- (2) 逐模型档位: 每个模型只列自己声明的档位 --------------------------
{
  body.children.length = 0
  const card = mount({ enabled: true, models: [] })
  const rows = card.querySelectorAll('.effort-row')
  ok(rows.length === 3, `三个模型应有三行, got ${rows.length}`)
  const mimo = card.querySelectorAll('.effort-chip')
  const chipsForMimo = [...mimo].filter((c: any) => c.attrs['data-model'] === 'm-aaa')
  const chipsForGemini = [...mimo].filter((c: any) => c.attrs['data-model'] === 'm-ccc')
  ok(chipsForMimo.length === 3, `MiMo 只列目录声明的 3 档, got ${chipsForMimo.length}`)
  ok(chipsForGemini.length === 1, `Gemini 只列 1 档(不能统一用一套), got ${chipsForGemini.length}`)
  ok(chipsForGemini[0].attrs['data-effort'] === 'high', 'Gemini 的那一档必须是 high')
  ok(card.querySelectorAll('.effort-no-efforts').length === 1, '未声明档位的模型必须给出说明而不是芯片')
}

// -- (3) 已配置项回填: 对应芯片高亮 ------------------------------
{
  body.children.length = 0
  const card = mount({ enabled: true, models: [{ model: 'm-aaa', effort: 'max' }] })
  const on = chosen(card)
  ok(on.length === 1, `只应有一个已选芯片, got ${on.length}`)
  ok(on[0].attrs['data-model'] === 'm-aaa' && on[0].attrs['data-effort'] === 'max',
    '已选芯片必须是 m-aaa=max')
}

// -- (4) 开关打开但没配任何模型: 必须给出警告 ---------------------------
{
  body.children.length = 0
  const card = mount({ enabled: true, models: [] })
  const warn = card.querySelector('.effort-warn')
  ok(warn && !String(warn.className).includes('hidden'), '开启但空表时必须显示警告')
  body.children.length = 0
  const off = mount({ enabled: false, models: [] })
  const warn2 = off.querySelector('.effort-warn')
  ok(warn2 && String(warn2.className).includes('hidden'), '关闭时空表警告必须隐藏')
}

// -- (5) 目录未探测: 给出[先去同步]的提示而不是空白 --------------------
{
  body.children.length = 0
  const card = buildEffortOverrideCard({ enabled: true, models: [] }, [], false, () => {})
  body.append(card)
  ok(card.querySelectorAll('.effort-empty').length === 1, '没有目录行时必须提示去同步模型')
}

console.log(`思考强度卡结构验证通过(断言 ${n} 条)`)
