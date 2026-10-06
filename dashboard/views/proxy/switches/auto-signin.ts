/**
 * 自动签到卡(设置页 → 调度与额度).
 *
 * 为什么单独一张卡而不是塞进[额度保护]: 签到不是额度策略, 它是一个**会花钱
 * 的定时动作**(每条签到要发一条消息). 默认关闭, 开关旁边必须写清成本与间隔,
 * 否则用户开了之后不知道为什么额度少了.
 *
 * 三态与其余开关卡一致(勾选即存), 保存后实时生效 ---- 调度器每轮开始
 * 重新读设置, 不用重启.
 */
import { t } from '../../../locale/index.ts'
import { el } from '../../../lib/dom.ts'

/**
 * 自动签到卡.
 *
 * @param {any} attrs 复选框属性(由 index.ts 的 buildToolSwitchAttrs 生成)
 * @param {boolean} enabled 当前是否开启
 * @returns {any} 卡片元素
 */
export function buildAutoSignInCard(attrs: any, enabled: boolean) {
  return el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('settings.autoSignIn')),
      el('span', { class: 'muted' }, t('settings.autoSignInHint')),
    ]),
    el('label', { class: 'switch', for: 'auto-signin' }, [
      el('input', attrs),
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      el('span', { class: 'switch-status' }, enabled ? t('common.on') : t('common.off')),
    ]),
  ])
}
