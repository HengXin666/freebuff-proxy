/**
 * 设置页的[开关类]保存处理器 -- 从 views/proxy/index.ts 按体量拆出.
 *
 * 拆出原因: 原文件补齐[自动签到]后 527 行, 撞了前端 500 行硬红线. 这一批
 * 函数形状完全同构(读勾选 -> POST /api/settings -> 回读 -> 还原可交互),
 * 与页面装配(renderProxySettings)分属两件事, 按职责切开.
 *
 * 真源约定: 每个开关的字段名与 settings-store.ts 的 LIVE_FIELDS 一一对应;
 * 回读那一步不是可选的 ---- 少了它, 保存失败时界面会停在与服务端不一致的状态.
 */
import { t } from '../../../locale/index.ts'
import { api } from '../../../lib/api.ts'
import { need } from '../../../lib/boot/hooks.ts'
import { toast } from '../../../lib/ui.ts'

/**
 * 保存自动签到开关(见 bin/serve 的 startAutoSignIn 与 store/signin/auto.ts).
 *
 * 与其余开关同形: 存了就生效(调度器每轮重读设置), 回读一次防止本地状态漂移.
 * @param {any} event 复选框 change 事件
 * @returns {Promise<void>} 无返回值
 */
export async function saveAutoSignInSetting(event: any) {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ autoSignInEnabled: enabled }),
    })
    toast(enabled ? t('settings.autoSignInOn') : t('settings.autoSignInOff'))
    try {
      const s = await api('/api/settings')
      const actual = s.autoSignInEnabled === true
      input.checked = actual
      updateSwitchLabel(input)
    } catch { /* 回读失败也保持可交互 */ }
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
  }
  input.disabled = false
}

/**
 * 保存[官方工具签名兼容]开关并即时反映状态文案.
 * @param {any} event 复选框 change 事件
 * @returns {Promise<void>} 无返回值
 */
export async function saveFreeToolSignatureSetting(event: any) {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ freeToolSignatureEnabled: enabled }),
    })
    toast(
      enabled
        ? t('system.toolSignatureOn')
        : t('system.toolSignatureOff'),
    )
    // 从服务端回读一次,把开关还原为可交互状态并同步到真实值,避免按钮被永久禁用
    try {
      const s = await api('/api/settings')
      const actual = s.freeToolSignatureEnabled !== false
      input.checked = actual
      updateSwitchLabel(input)
    } catch { /* 忽略回读失败，仍保持可交互 */ }
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
  }
  input.disabled = false // 成功/失败后都恢复可交互
}

/**
 * 上游请求链路(legacy / official)切换.
 * @param {any} event 下拉框 change 事件
 * @returns {Promise<void>} 无返回值
 */
export async function saveUpstreamChannelSetting(event: any) {
  const sel = event.currentTarget
  const value = sel.value === 'official' ? 'official' : 'legacy'
  sel.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ upstreamChannel: value }),
    })
    toast(value === 'official' ? t('system.upstreamChannelOfficial') : t('system.upstreamChannelLegacy'))
    try {
      const s = await api('/api/settings')
      sel.value = s.upstreamChannel === 'official' ? 'official' : 'legacy'
    } catch { /* 回读失败也保持可交互 */ }
  } catch (err) {
    sel.value = value === 'official' ? 'legacy' : 'official'
    toast(err.message, true)
  }
  sel.disabled = false
}

/**
 * 工具被拒时剥离 tools 重试开关(见 /api/settings.stripToolsOnSchemaRejection).
 * @param {any} event 复选框 change 事件
 * @returns {Promise<void>} 无返回值
 */
export async function saveStripToolsSetting(event: any) {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ stripToolsOnSchemaRejection: enabled }),
    })
    toast(enabled ? t('system.toolFallbackOn') : t('system.toolFallbackOff'))
    try {
      const s = await api('/api/settings')
      const actual = s.stripToolsOnSchemaRejection === true
      input.checked = actual
      updateSwitchLabel(input)
    } catch { /* 忽略回读失败，仍保持可交互 */ }
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
  }
  input.disabled = false
}

/**
 * 第三方工具承载开关(见 /api/settings.toolCarrierEnabled 与 tool-carrier.ts).
 * @param {any} event 复选框 change 事件
 * @returns {Promise<void>} 无返回值
 */
export async function saveToolCarrierSetting(event: any) {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ toolCarrierEnabled: enabled }),
    })
    toast(enabled ? t('system.toolCarrierOn') : t('system.toolCarrierOff'))
    try {
      const s = await api('/api/settings')
      const actual = s.toolCarrierEnabled !== false
      input.checked = actual
      updateSwitchLabel(input)
    } catch { /* 忽略回读失败，仍保持可交互 */ }
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
  }
  input.disabled = false
}

/**
 * 一键屏蔽收费模型开关: pool=premium 的模型从列表与调度排除.
 * @param {any} event 复选框 change 事件
 * @returns {Promise<void>} 无返回值
 */
export async function saveBlockPremiumSetting(event: any) {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ blockPremiumModels: enabled }),
    })
    toast(enabled ? t('system.blockPremiumOn') : t('system.blockPremiumOff'))
    try {
      const s = await api('/api/settings')
      const actual = s.blockPremiumModels !== false
      input.checked = actual
      updateSwitchLabel(input)
    } catch { /* 忽略回读失败 */ }
    // 切换后即时刷新模型表(收费模型隐藏/恢复)
    need('refreshModelSettingsCard')( )
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
    input.disabled = false
  }
}

/**
 * 同步 switch 旁边的[已开启/已关闭]文字标签, 保持 DOM 与状态一致.
 * @param {any} input 复选框元素
 * @returns {void} 无返回值
 */
function updateSwitchLabel(input: any) {
  const track = input.closest('.switch')
  if (!track) return
  const statusEl = track.querySelector('.switch-status')
  if (statusEl) statusEl.textContent = input.checked ? t('common.on') : t('common.off')
}
