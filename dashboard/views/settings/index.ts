/**
 * 设置页 ---- 全局配置的独立入口.
 *
 * 背景(用户反馈): 全局配置原先全部堆在总览页尾部(工具签名 / 工具兜底 / 工具
 * 承载 / 请求链路 / 负载均衡 / 额度保护 / 代理池 / 可调项), 与"账号池状态"混在
 * 一起, 输入框全挤在一块儿没有分区, 既难看也找不到想改的项.
 *
 * 现在: 总览页只留账号池状态与统计, 全局配置整体搬到本页, 并按用途分成四区
 * (上游与工具 / 调度与额度 / 网络与出口 / 高级需重启). 分区由
 * views/proxy/index.ts 的 buildSettingsSections 单列定义, 本文件只负责页面
 * 骨架, 跳转条与首屏加载态.
 *
 * 见 .agents/notes/implemented/feature/2026-10-06-settings-page-sections.md
 */
import { t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { el, icon } from '../../lib/dom.ts'
import { need } from '../../lib/boot/hooks.ts'
import { endProgress, startProgress } from '../../lib/ui.ts'

/** 左侧边栏的分区(顺序必须与 buildSettingsSections 的区序一致). */
/**
 * 各分区: slug 用于 URL(#settings/<slug>), 让每个子页面可被直接打开/分享/回退.
 *
 * 顺序必须与 buildSettingsSections 的区序一致.
 */
const SECTIONS: Array<{ key: string, icon: string, slug: string }> = [
  { key: 'settings.sectionTools', icon: 'terminal', slug: 'tools' },
  { key: 'settings.sectionUpstream', icon: 'box', slug: 'upstream' },
  // 系统提示词独立一区: 它要占用整块编辑区(Monaco), 与开关卡挤在一区会被压扁.
  { key: 'settings.sectionSystemPrompt', icon: 'chat', slug: 'prompt' },
  { key: 'settings.sectionScheduling', icon: 'gauge', slug: 'scheduling' },
  { key: 'settings.sectionNetwork', icon: 'globe', slug: 'network' },
  { key: 'settings.sectionModels', icon: 'cpu', slug: 'models' },
  { key: 'settings.sectionAdvanced', icon: 'settings', slug: 'advanced' },
]

/** 当前选中的分区下标(模块级即可: 同一时刻只会渲染一个设置页). */
let activeSection = 0

/** hashchange 处理器(每次渲染重挂, 避免多份同时生效). */
let onHashChange: any = () => {}

/**
 * 从 URL hash 解析分区下标.
 *
 * 形式: #settings/<slug>; 认不出就回 0(第一个分区).
 *
 * @returns {number} 分区下标
 */
function sectionFromHash() {
  const raw = (location.hash || '').replace(/^#/, '')
  const slug = raw.includes('/') ? raw.split('/')[1] : ''
  const i = SECTIONS.findIndex((s) => s.slug === slug)
  return i >= 0 ? i : 0
}

/**
 * 渲染设置页.
 *
 * 布局是[左侧边栏切换 + 右侧内容]: 边栏列出五个分区, 点哪项右侧就换成哪一区,
 * 而不是把所有区纵向堆成一长条(用户要求"左侧边栏有个导航那种").
 *
 * 配置卡片的构造与保存逻辑全部复用 views/proxy/ 与 views/models/(它们本来就是
 * 那套实现的唯一归属), 本函数只做页面级装配: 边栏 + 内容容器 + 加载/错误态.
 *
 * @param {any} view 内容容器
 * @returns {Promise<void>} 无返回值
 */
export async function renderSettings(view: any) {
  view.innerHTML = ''
  view.append(settingsSkeleton())
  startProgress()
  const panel = el('div', { class: 'settings-panel' })
  try {
    // 配置卡片由 proxy / models 两个视图渲染: 它们对各自接口的读取与保存语义
    // 都在那两层, 这里不复制一份(避免两处口径漂移).
    // 顺序: 上游与工具 -> 调度与额度 -> 网络与出口 -> 模型 -> 高级(需重启).
    await need('renderProxySettings')(panel)
    panel.append(modelSection())
    await need('renderModelSettings')(modelSectionBody(panel))
    panel.append(await advancedSection())
    endProgress()
    view.innerHTML = ''
    const layout = el('div', { class: 'settings-layout' })
    layout.append(sideNav(panel))
    layout.append(panel)
    view.append(settingsHeader())
    view.append(layout)
    showSection(panel, sectionFromHash())
    // 直接在地址栏改子页(或浏览器前进/后退)时同步切分区.
    // 用 once 语义: 每次渲染重新挂, 换页时先摘掉旧的.
    window.removeEventListener('hashchange', onHashChange)
    onHashChange = () => {
      if ((location.hash || '').startsWith('#settings')) showSection(panel, sectionFromHash())
    }
    window.addEventListener('hashchange', onHashChange)
  } catch (err) {
    endProgress()
    view.innerHTML = ''
    view.append(el('div', { class: 'card' }, err.message))
  }
}

/**
 * 左侧分区边栏.
 *
 * 点击只切换 section 的 active 类, 不重建 DOM ---- 配置卡上的输入框状态(用户
 * 已经改了一半的值)在切换分区时必须保留, 重建会把它清掉.
 *
 * @param {any} panel 内容容器(内含各分区)
 * @returns {any} 边栏元素
 */
function sideNav(panel: any) {
  const nav = el('div', { class: 'settings-nav' })
  SECTIONS.forEach((section, i: number) => {
    nav.append(el('button', {
      'data-section': String(i),
      onclick: () => {
        showSection(panel, i)
        // 写进 URL: 每个子页面可刷新保持, 可回退, 可直接分享.
        location.hash = 'settings/' + section.slug
      },
    }, [icon(section.icon, 14), t(section.key)]))
  })
  return nav
}

/**
 * 显示第 i 个分区: 切换 active 类并同步边栏高亮.
 *
 * @param {any} panel 内容容器
 * @param {number} index 分区下标
 * @returns {void} 无返回值
 */
function showSection(panel: any, index: number) {
  const sections = panel.querySelectorAll('.settings-section')
  if (!sections.length) return
  const target = Math.max(0, Math.min(index, sections.length - 1))
  activeSection = target
  sections.forEach((node: any, i: number) => node.classList.toggle('active', i === target))
  const nav = document.querySelector('.settings-nav')
  if (nav) {
    for (const btn of nav.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.getAttribute('data-section') === String(target))
    }
  }
}

/**
 * 模型区外壳.
 *
 * renderModelSettings 会把卡片直接 append 到传入的容器, 而我们要给它套一层
 * 带标题的分区外壳, 所以先建空壳再取它的 body 交给那个函数填充.
 *
 * @returns {any} 模型分区元素
 */
function modelSection() {
  return el('section', { class: 'settings-section' }, [
    el('div', { class: 'settings-section-head' }, [
      el('h3', {}, t('settings.sectionModels')),
      el('span', { class: 'muted' }, t('settings.sectionModelsHint')),
    ]),
    el('div', { class: 'settings-section-body', id: 'settings-models-body' }),
  ])
}

/**
 * 取模型区的内容容器.
 *
 * @param {any} page 设置页容器
 * @returns {any} 模型区 body 元素
 */
function modelSectionBody(page: any) {
  return page.querySelector('#settings-models-body')
}

/**
 * 高级区(可调项, 改完需重启).
 *
 * 它要排在模型区之后, 所以不走 renderProxySettings 的区分表, 而是这里单独取
 * /api/settings 再交给 proxy 视图的 buildAdvancedSection 构造 ---- 卡片实现
 * 仍在那一层, 本文件只决定它落在页面哪个位置.
 *
 * @returns {Promise<any>} 高级分区元素
 */
async function advancedSection() {
  const settings = await api('/api/settings').catch(() => ({}))
  return need('buildAdvancedSection')(settings)
}

/** 页头: 标题 + 一句说明(分区切换在左侧边栏). */
function settingsHeader() {
  return el('div', {}, [
    el('div', { class: 'row spread', style: 'margin-bottom:6px' }, [
      el('h2', { style: 'margin:0' }, t('settings.title')),
    ]),
    el('div', { class: 'muted', style: 'margin-bottom:14px' }, t('settings.subtitle')),
  ])
}

/** 首屏骨架(与总览页同款观感). */
function settingsSkeleton() {
  return el('div', {}, [
    el('div', { class: 'card', style: 'height:62px;margin-bottom:16px' },
      el('div', { class: 'skeleton', style: 'height:16px;width:40%' })),
    ...[1, 2].map(() => el('div', { class: 'card', style: 'margin-top:12px' }, [
      el('div', { class: 'skeleton', style: 'height:16px;width:30%' }),
      el('div', { class: 'skeleton', style: 'height:34px;margin:10px 0' }),
      el('div', { class: 'skeleton', style: 'height:34px;margin:10px 0' }),
    ])),
  ])
}

void api
void icon
