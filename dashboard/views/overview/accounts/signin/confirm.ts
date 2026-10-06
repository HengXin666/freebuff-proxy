/**
 * 签到的成本警告条 + 二次确认对话框.
 *
 * ## 为什么必须有这两样(用户明确要求)
 *
 * 签到不是一次免费的状态查询 ---- 上游没有签到接口, 当天签到由[当天第一条消息]
 * 触发(见 store/signin/run.ts 的文件头). 所以这个按钮可能产生真实花费:
 *
 *   - 若账号此刻没有可复用的热会话, 会走 admit => 当场按所选中模型的整小时
 *     单价预扣(一手实测: rem=0 spent=25, 见
 *     .agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md);
 *   - 若账号已有热会话, 复用它是零边际成本(ensure.ts: [这条会话的整小时
 *     已经买过了, 复用它不产生任何新扣费]).
 *
 * 把它做成[一键静默执行]的后果, 与用户反馈的原话一致: [不要让用户觉得他在
 * 浪费额度]. 所以: 按钮旁常驻一段说明(不是 tooltip ---- 藏起来的警告等于没有),
 * 点击后先弹二次确认, 把上面这段成本说清楚, 再让用户决定.
 *
 * ## 交互纪律(本仓踩过的坑)
 *
 * 任何遮罩交互都必须有可关闭路径: 这个对话框给足三种 ---- 取消按钮 / Esc /
 * 点遮罩. 且它不锁 body 滚动(进度类提示才需要锁, 而这里只是个确认框).
 */
import { t } from '../../../../locale/index.ts'
import { el } from '../../../../lib/dom.ts'

/**
 * 签到的成本说明条(常驻在按钮旁边, 不是 tooltip).
 *
 * 为什么不用 title 属性: 藏起来的警告等于没有 ---- 用户看不到就不会读,
 * 而这条信息决定了[这次点击要不要花掉他一小时的钱].
 *
 * @returns {any} 说明条元素
 */
export function buildSignInCostNotice() {
  return el('div', { class: 'signin-cost-notice', id: 'signin-cost-notice' }, [
    el('span', { class: 'signin-cost-icon', 'aria-hidden': 'true' }, '!'),
    el('span', {}, t('signin.costNotice')),
  ])
}

/**
 * 影响面一行: 会把这次点击波及的账号数与[有没有 0 价模型]摆出来.
 *
 * impact 拿不到时返回 null 而不是显示 0 ---- 显示 [0 个账号] 会让用户以为
 * 无事发生, 而事实是[我们不知道]. 不知道就不要说.
 *
 * @param {any} impact 影响面预估
 * @returns {any} 一行元素;拿不到为 null
 */
function impactRow(impact: any) {
  if (!impact || typeof impact.alive !== 'number') return null
  return el('p', { class: 'signin-confirm-impact' }, [
    t('signin.confirmImpact', { alive: impact.alive, total: impact.accounts }),
    impact.hasZeroPrice
      ? el('span', { class: 'signin-confirm-free' }, t('signin.confirmZeroPrice'))
      : null,
  ])
}

/**
 * 签到的二次确认对话框.
 *
 * 返回 Promise<boolean>: 确认 true / 取消(含 Esc 与点遮罩) false.
 * 不用 window.confirm: 它给不了[分点说明成本]的排版, 而这个对话框的全部价值
 * 就是把成本讲清楚.
 *
 * @param {any} [impact] 影响面预估(accounts / alive / hasZeroPrice), 来自 /api/signin
 * @returns {Promise<boolean>} 用户是否确认
 */
export function confirmSignIn(impact: any) {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (v: boolean) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey)
      backdrop.remove()
      resolve(v)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false)
    }
    // 点遮罩关闭: 三种可关闭路径之一(另两个是取消按钮与 Esc).
    const backdrop = el('div', {
      class: 'signin-confirm-backdrop',
      onclick: (e: any) => { if (e.target === backdrop) finish(false) },
    }, [
      el('div', { class: 'signin-confirm', role: 'dialog', 'aria-modal': 'true' }, [
        el('h3', { class: 'signin-confirm-title' }, t('signin.confirmTitle')),
        el('div', { class: 'signin-confirm-body' }, [
          // 先摆出[会影响几个账号]---- 抽象的成本说明不如一个具体数字有用.
          impactRow(impact),
          el('p', {}, t('signin.confirmCost')),
          el('ul', { class: 'signin-confirm-list' }, [
            el('li', {}, t('signin.confirmBulletCold')),
            el('li', {}, t('signin.confirmBulletWarm')),
            el('li', {}, t('signin.confirmBulletSkip')),
          ]),
          el('p', { class: 'muted' }, t('signin.confirmNote')),
        ]),
        el('div', { class: 'row signin-confirm-actions' }, [
          el('button', {
            class: 'btn', type: 'button', id: 'signin-confirm-cancel',
            onclick: () => finish(false),
          }, t('common.cancel')),
          el('button', {
            class: 'btn btn-primary', type: 'button', id: 'signin-confirm-ok',
            onclick: () => finish(true),
          }, t('signin.confirmOk')),
        ]),
      ]),
    ])
    document.body.append(backdrop)
    document.addEventListener('keydown', onKey)
    // 焦点给[取消]: 破坏性动作的默认焦点应当落在更保守的那个选项上.
    const cancelBtn = document.getElementById('signin-confirm-cancel')
    if (cancelBtn) cancelBtn.focus()
  })
}
