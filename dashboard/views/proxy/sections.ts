/**
 * 设置页的分区表 ---- 总览页剥离全局配置后的独立页骨架.
 *
 * 从 index.ts 按职责切出(原文件触及 500 行前端红线): 本文件只放[分区怎么分]
 * (标题 / 说明 / 每区挂哪些卡片), index.ts 放[数据怎么取, 开关怎么存].
 *
 * 单列真源的意义: 新增一张配置卡时只在这里决定它归哪个区; 渲染顺序与设置页的
 * 跳转条都由此派生, 不需要同时改三处(这正是原先八张卡平铺时做不到的).
 *
 * 用户提出分区的原话: 全局配置不该堆在总览页, 输入框全挤在一起看不出归属.
 */
import { t } from '../../locale/index.ts'
import { el } from '../../lib/dom.ts'
import {
  buildFreeToolSignatureCard, buildLoadBalanceCard, buildProxyPoolCard,
  buildQuotaProtectionCard, buildStripToolsCard, buildToolCarrierCard,
  buildUpstreamChannelCard,
} from './cards.ts'
import { buildTunablesCard } from './tunables.ts'

/**
 * 设置页的分区表(标题 / 说明 / 该区的卡片).
 *
 * 单列真源: 新增一张卡时只在这里决定它归哪个区, 渲染顺序与跳转条都由此派生,
 * 不需要同时改三处.
 *
 * @param {any} ctx 渲染上下文(各开关属性 / 当前值 / 接口数据)
 * @returns {any[]} 分区元素数组
 */
export function buildSettingsSections(ctx: any) {
  const s = ctx.settings
  return [
    settingsSection('settings.sectionUpstream', 'settings.sectionUpstreamHint', [
      buildUpstreamChannelCard(ctx.channel),
      buildFreeToolSignatureCard(ctx.toggleAttrs, ctx.signatureEnabled),
      buildStripToolsCard(ctx.stripAttrs, ctx.stripTools),
      buildToolCarrierCard(ctx.carrierAttrs, ctx.carrierEnabled),
    ]),
    settingsSection('settings.sectionScheduling', 'settings.sectionSchedulingHint', [
      buildLoadBalanceCard(ctx.schedMode, ctx.concurrency, ctx.overflowWaitMs),
      buildQuotaProtectionCard(
        ctx.advice, ctx.idleReleaseSec, ctx.lowBalanceThreshold, ctx.maxNewSessions,
      ),
    ]),
    settingsSection('settings.sectionNetwork', 'settings.sectionNetworkHint', [
      buildProxyPoolCard(ctx.data),
    ]),
  ]
}

/**
 * 高级区(可调项)单独取用: 设置页要把它排在[模型]区之后.
 *
 * 为什么不把模型区也塞进 buildSettingsSections: 模型卡片由 views/models 渲染
 * (需要 await, 且属于另一个视图的职责), 而本函数是纯同步的卡片装配. 让它保持
 * 同步, 由设置页决定最终顺序, 比在这里引入跨视图 await 更清晰.
 *
 * @param {any} settings /api/settings 回执
 * @returns {any} 高级分区元素
 */
export function buildAdvancedSection(settings: any) {
  return settingsSection('settings.sectionAdvanced', 'settings.sectionAdvancedHint', [
    buildTunablesCard(settings.tunableSpecs, settings.tunables, settings.secrets),
  ])
}

/**
 * 一个设置分区: 标题条 + 该区的卡片容器.
 *
 * 卡片自带 margin-top(它们原本是独立平铺的), 在区内由容器 gap 统一控制,
 * 所以这里用 CSS 类 settings-section-body 覆盖掉那个外边距(见 base.css).
 *
 * @param {string} titleKey 标题词条
 * @param {string} hintKey 说明词条
 * @param {any[]} cards 该区的卡片元素
 * @returns {any} 分区元素
 */
function settingsSection(titleKey: string, hintKey: string, cards: any[]) {
  const body = el('div', { class: 'settings-section-body' })
  for (const card of cards) body.append(card)
  return el('section', { class: 'settings-section' }, [
    el('div', { class: 'settings-section-head' }, [
      el('h3', {}, t(titleKey)),
      el('span', { class: 'muted' }, t(hintKey)),
    ]),
    body,
  ])
}
