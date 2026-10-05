/* Freebuff Proxy 控制台 -- 零依赖原生 JS SPA(入口装配层)
 *
 * 本文件只做装配:装配跨视图联动 -> 注册路由 -> 启动.
 * 具体视图在 views/,通用工具在 lib/,文案在 locale/.
 * 拆分前这里是 4000 行的单文件(用户硬标准:单文件 <=500 行).
 *
 * registerHooks: 视图之间不互相 import(会成环);
 * 顶层求值读到对方 const 会命中 TDZ 白屏).谁提供实现只有装配层知道,
 * 所以由这里一次性登记;视图侧用 need(name) 取.详见 dashboard/lib/boot/hooks.ts.
 *
 * import 方向的唯一真源是这里:app.ts -> views/shell -> 各视图 -> lib/*.
 */
'use strict'

import { initLocale } from './locale/index.ts'
import { api, setUnauthorizedHandler } from './lib/api.ts'
import { registerHooks } from './lib/boot/hooks.ts'
import { state } from './lib/state.ts'
import {
  addCustomModelRow, buildCustomModelRows, pruneStaleModels, refreshModelSettingsCard,
  removeCustomModel, renderModelSettings, restoreCustomModel, syncUpstreamModels,
} from './views/models/index.ts'
import { renderAccountsCard } from './views/overview/accounts/index.ts'
import {
  probeAccount, refreshAccountsCard, refreshOverviewAfterAccountChange,
} from './views/overview/accounts/refresh.ts'
import { renderProxySettings, saveBlockPremiumSetting } from './views/proxy/index.ts'
import {
  applyIdleReleaseAdvice, runProxyTest, saveLoadBalanceSettings,
  saveProxyPool, saveQuotaProtectionSettings, saveUpstreamChannelSetting, schedulingHint,
} from './views/proxy/index.ts'
// 设置页的分区表在 ./views/proxy/sections.ts(按职责从 index.ts 切出).
import { buildAdvancedSection } from './views/proxy/sections.ts'
import { render } from './views/shell/index.ts'
import {
  clearCooldown, closeAccountSession, colorFor, openAddAccount, openCredentialModal,
  openImportModal, openLoginFlow, removeAccount, shortProxy,
} from './views/users/index.ts'

/* ---------------- 跨视图联动装配 ---------------- */

registerHooks({
  // 整壳重建:401 失效时用,也是账号表[容器没挂载]时的回退路径
  render,
  renderAccountsCard,
  refreshAccountsCard,
  refreshOverviewAfterAccountChange,
  refreshModelSettingsCard,
  renderModelSettings,
  syncUpstreamModels,
  pruneStaleModels,
  buildCustomModelRows,
  addCustomModelRow,
  removeCustomModel,
  restoreCustomModel,
  saveBlockPremiumSetting,
  renderProxySettings,
  // 设置页要把[高级(可调项)]区排到模型区之后, 故单独取用该区的构造器.
  buildAdvancedSection,
  saveUpstreamChannelSetting,
  saveLoadBalanceSettings,
  schedulingHint,
  saveQuotaProtectionSettings,
  applyIdleReleaseAdvice,
  saveProxyPool,
  runProxyTest,
  closeAccountSession,
  clearCooldown,
  removeAccount,
  colorFor,
  openCredentialModal,
  openAddAccount,
  openImportModal,
  openLoginFlow,
  shortProxy,
  probeAccount,
})

/* ---------------- boot ---------------- */

setUnauthorizedHandler(render)

window.addEventListener('hashchange', render)
window.addEventListener('DOMContentLoaded', async () => {
  // 版本号/仓库地址:由发版流水线硬编码进 dashboard/version.json;本地没有则 fallback dev
  // 语种必须在首次 render 之前定好:否则先渲染中文再切语言会闪一下.
  initLocale()
  try {
    const res = await fetch('/version.json', { cache: 'no-store' })
    if (res.ok) state.version = await res.json()
  } catch { /* 本地开发没有 version.json，保持 dev */ }
  try {
    const { user } = await api('/api/me')
    state.me = user
  } catch {
    state.me = null
  }
  render()
})
