/**
 * 一键签到(总览页顶部按钮).
 *
 * ## 为什么不是一个孤立的按钮
 *
 * 官方没有签到接口 ---- 当天签到由[当天第一条消息]触发(见
 * src/web/store/signin/run.ts 的文件头). 所以这个动作会对每个存活账号
 * 读一次状态, 只给[今天还没签]的账号发一条最小消息. 已签过的会被跳过.
 *
 * ## 交互约束
 *
 *   - 18 小时防抖由服务端判(store.manualAllowed), 前端只把它画出来:
 *     按钮置灰 + 显示剩余时间. 刷新页面 / 换浏览器都绕不过去.
 *   - 进行中禁用按钮并显示进度文案 ---- 一轮签到要串行打多个上游请求,
 *     没有反馈的话用户会以为没反应而反复点.
 *   - 完成后把逐账号结果摘要显示出来(签了几个 / 跳了几个 / 失败几个).
 */
import { t } from '../../../../locale/index.ts'
import { api } from '../../../../lib/api.ts'
import { el, icon } from '../../../../lib/dom.ts'
import { toast } from '../../../../lib/ui.ts'
import { buildSignInCostNotice, confirmSignIn } from './confirm.ts'

/** 把毫秒差格式化成[还剩 X 小时 Y 分]. */
function fmtRemain(ms: number) {
  const totalMin = Math.max(0, Math.ceil(ms / 60000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0
    ? t('signin.remainHourMin', { h, m })
    : t('signin.remainMin', { m })
}

/**
 * 拉签到状态并渲染按钮(首次进入总览页时调).
 *
 * 拿不到状态时按钮保持可点但不显示剩余时间 ---- 状态显示失败不该顺带
 * 把功能也禁掉(服务端仍会拦重复触发).
 *
 * @param {any} slot 按钮容器
 * @returns {Promise<void>} 无返回值
 */
export async function renderSignInButton(slot: any) {
  let st: any = null
  try {
    st = await api('/api/signin')
  } catch {
    st = null
  }
  slot.innerHTML = ''
  const canSign = st ? st.canSignIn !== false : true
  const btn = el('button', {
    id: 'signin-btn',
    class: canSign ? '' : 'is-disabled',
    disabled: canSign ? undefined : '',
    title: st && !canSign
      ? t('signin.cooldownTip', { time: fmtRemain(st.remainMs || 0) })
      : t('signin.tip'),
    // 把 slot 显式传下去, 不用 btn.parentElement 反推 ----
    // 按钮被包进 wrap 之后, parentElement 拿到的是 wrap 而不是真正的容器,
    // 回读时会把 renderSignInButton(wrap) 当成 renderSignInButton(slot),
    // 于是每点一次就多一层 .signin-wrap 嵌套 + 多一条警告条(实测会无限累积).
    onclick: () => runSignIn(btn, st, slot),
  }, [icon('gift', 14), t('signin.button')])
  // 成本警告条常驻在按钮下方(不是 tooltip): 这条信息决定[这次点击要不要
  // 花掉用户一小时的钱], 藏起来等于没有. 用户明确要求[不要让用户觉得
  // 他在浪费额度] ---- 那就得先讲清楚代价, 而不是等他点完才发现.
  const wrap = el('div', { class: 'signin-wrap' }, [btn])
  if (st && !canSign) {
    wrap.append(el('span', { class: 'muted signin-remain' },
      fmtRemain(st.remainMs || 0)))
  }
  const auto = st?.autoEnabled === true
  wrap.append(el('span', {
    class: 'muted signin-auto', title: t('signin.autoTipShort'),
  }, auto ? t('signin.autoOn') : t('signin.autoOff')))
  slot.append(wrap)
  slot.append(buildSignInCostNotice())
}

/**
 * 触发一轮签到.
 *
 * 429 是防抖窗口的正常回执, 不当成错误弹红 ---- 它只是告诉你还要等多久.
 *
 * @param {any} btn 按钮
 * @param {any} st 渲染时缓存的 /api/signin 回执(取其 impact 给确认框)
 * @param {any} slot 按钮所在的容器(回读时重渲染用; 不用 parentElement 反推)
 * @returns {Promise<void>} 无返回值
 */
export async function runSignIn(btn: any, st: any, slot?: any) {
  if (!btn) return
  // 二次确认: 这个动作可能花掉用户一小时的钱, 所以必须在他点下[确认]之前
  // 把成本摊开讲(见 signin/confirm.ts). 取消(按钮/Esc/点遮罩)则什么都不做.
  // impact 来自按钮渲染时缓存的 /api/signin 回执, 不再多发一次请求.
  const confirmed = await confirmSignIn(st?.impact)
  if (!confirmed) return
  const label = btn.querySelector?.('span') || btn
  const original = label.textContent
  btn.disabled = true
  label.textContent = t('signin.running')
  try {
    const r = await api('/api/signin', { method: 'POST' })
    const parts = [
      t('signin.resultSigned', { n: r.signedIn || 0 }),
      t('signin.resultSkipped', { n: r.skipped || 0 }),
    ]
    if (r.failed) parts.push(t('signin.resultFailed', { n: r.failed }))
    toast(parts.join(' · '), r.failed > 0)
  } catch (err: any) {
    const msg = String(err?.message || err)
    // 防抖命中: 服务端回 429 + remainMs. 前端把它翻成人话.
    const m = msg.match(/(\d+)\s*$/)
    toast(m ? t('signin.cooldownTip', { time: fmtRemain(Number(m[1])) }) : msg, true)
  } finally {
    btn.disabled = false
    label.textContent = original
    // 回读状态: 成功后按钮要变成[冷却中], 否则用户能连点(后端会拦, 但体验差).
    // 容器用调用方传进来的那个 ---- 反推(btn.parentElement)会拿到 wrap,
    // 结果是容器被层层套娃, 警告条无限累积.
    if (slot) await renderSignInButton(slot)
  }
}
