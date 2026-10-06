import { t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { $, el, icon } from '../../lib/dom.ts'
import { need } from '../../lib/boot/hooks.ts'
import { state } from '../../lib/state.ts'
import { toast } from '../../lib/ui.ts'
import {
  buildFreeToolSignatureCard, buildLoadBalanceCard, buildProxyPoolCard,
  buildQuotaProtectionCard, buildStripToolsCard, buildToolCarrierCard,
  buildUpstreamChannelCard,
} from './cards.ts'
import { buildAdvancedSection, buildSettingsSections } from './sections.ts'
import { saveOfficialToolsSetting } from './inject/official-tools.ts'
import { saveEffortOverride } from './inject/effort.ts'
import {
  saveAutoSignInSetting, saveBlockPremiumSetting, saveFreeToolSignatureSetting,
  saveStripToolsSetting, saveToolCarrierSetting, saveUpstreamChannelSetting,
} from './switches/index.ts'

/* ---------------- proxy settings ---------------- */
export async function renderProxySettings(view: any) {
  let data = null
  let settings = null
  try {
    ;[data, settings] = await Promise.all([
      api('/api/proxy'),
      api('/api/settings'),
    ])
  } catch {
    data = { proxies: [], effective: [], accounts: [] }
    settings = { freeToolSignatureEnabled: true }
  }
  state.proxies = data.proxies || []
  // [空闲释放推荐值]要按账号池实时算(活跃模型/账号比),而 /api/proxy 只回
  // 代理信息,不含 session.model.这里单独拉一次 overview 填充 state.accounts.
  // 独立 try:overview 挂了也不能把上面的 settings 一起拖垮(否则整页回落到默认值).
  try {
    const overview = await api('/api/overview')
    if (Array.isArray(overview.accounts)) state.accounts = overview.accounts
  } catch {
    // 拉不到就沿用已有的 state.accounts（可能为空 → 推荐值退回默认 600s）
  }

  const switches = buildToolSwitchAttrs(settings)
  const {
    toggleAttrs, signatureEnabled, stripAttrs, stripTools, carrierAttrs, carrierEnabled,
    autoSignInAttrs, autoSignInEnabled,
  } = switches
  const channel = settings.upstreamChannel === 'official' ? 'official' : 'legacy'
  const concurrency = settings.accountMaxConcurrency ?? 2
  const schedMode = settings.accountSchedulingMode === 'spread' ? 'spread' : 'sticky'
  const overflowWaitMs = settings.accountOverflowWaitMs ?? 15000
  const idleReleaseSec = settings.idleReleaseSec ?? 600
  const maxNewSessions = settings.maxNewSessionsPerRequest ?? 2
  const lowBalanceThreshold = settings.lowBalanceThreshold ?? 15
  state.lowBalanceThreshold = lowBalanceThreshold
  const advice = idleReleaseAdvice(state.accounts)
  // 按用途分区渲染(见 sections.ts); officialToolNames 必须原样透传 null,
  // 它与空数组在服务端语义不同(全部注入 / 一个都不注入).
  for (const section of buildSettingsSections({
    toggleAttrs, signatureEnabled, stripAttrs, stripTools,
    carrierAttrs, carrierEnabled, channel,
    officialToolCatalog: settings.officialToolCatalog || [],
    officialToolNames: Array.isArray(settings.officialToolNames)
      ? settings.officialToolNames
      : null,
    toolsDisabled: state.me.role !== 'admin',
    onOfficialToolsApply: saveOfficialToolsSetting,
    // 思考强度覆盖: 开关 + 逐模型档位(档位选项来自本地目录行).
    reasoningOverride: settings.reasoningOverride || { enabled: false, models: [] },
    reasoningModels: Array.isArray(settings.reasoningModels) ? settings.reasoningModels : [],
    onReasoningOverride: saveEffortOverride,
    // 编辑器正文: 自定义态用存下的正文, 其余态显示官方原文(否则打开是空白).
    systemPromptText: settings.officialSystemPromptMode === 'custom'
      && typeof settings.officialSystemPromptText === 'string'
      ? settings.officialSystemPromptText
      : (typeof settings.officialSystemPromptDefault === 'string'
        ? settings.officialSystemPromptDefault
        : ''),
    systemPromptDefault: typeof settings.officialSystemPromptDefault === 'string'
      ? settings.officialSystemPromptDefault
      : '',
    promptPlaceholders: Array.isArray(settings.promptPlaceholders) ? settings.promptPlaceholders : [],
    schedMode, concurrency, overflowWaitMs,
    advice, idleReleaseSec, lowBalanceThreshold, maxNewSessions,
    autoSignInAttrs, autoSignInEnabled,
    data, settings,
  })) view.append(section)
}


/**
 - 调度模式说明文案(前端即时预览,保存后由服务端返回的实际值再刷新一次).
 - 这段文字是用户理解"为什么只开了一个号"的关键,措辞要直白.
 */
/**
 *
 *
 - 返回 { sec, why };sec 已夹在 60..600(1 分钟~10 分钟)这个保守区间内.
 */
function idleReleaseAdvice(accounts: any) {
  const pool = accounts.length
  if (!pool) {
    return { sec: 60, why: t('system.adviceNoAccounts') }
  }
  const liveModels = new Set(
    accounts.map((a: any) => a.session && a.session.live && a.session.model).filter(Boolean),
  )
  const distinct = liveModels.size
  const ratio = distinct / pool
  let sec
  let why
  if (distinct === 0) {
    sec = 60
    why = t('system.adviceNoSessions', { pool })
  } else if (ratio >= 0.8) {
    sec = 60
    why = t('system.adviceTight', { pool, distinct })
  } else if (ratio <= 0.5) {
    sec = 300
    why = t('system.adviceRelaxed', { pool, distinct })
  } else {
    sec = 120
    why = t('system.adviceBalanced', { pool, distinct })
  }
  return { sec, why }
}

/** 重算并刷新推荐值区块(保存设置后调用,不整页重建). */
function renderIdleReleaseAdvice() {
  const row = $('#idle-release-advice .advice-actions')
  const text = $('#idle-release-advice-text')
  if (!row || !text) return
  const advice = idleReleaseAdvice(state.accounts)
  text.textContent = advice.why
  row.textContent = ''
  const cur = parseInt($('#idle-release-sec')?.value, 10)
  if (state.me && state.me.role === 'admin' && advice.sec !== cur) {
    row.append(
      el('button', { class: 'primary', style: 'margin-top:8px', onclick: () => applyIdleReleaseAdvice(advice.sec) },
        t('system.adviceApply', { sec: advice.sec })),
    )
  } else if (advice.sec === cur) {
    row.append(el('div', { class: 'muted', style: 'margin-top:6px' }, t('system.adviceInSync')))
  }
}

/** 一键采用推荐值(连同当前的单请求新会话上限一起提交). */
export async function applyIdleReleaseAdvice(sec: any) {
  const budget = $('#max-new-sessions')
  const b = budget ? Math.max(0, Math.min(16, parseInt(budget.value, 10) || 0)) : 2
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ idleReleaseSec: sec, maxNewSessionsPerRequest: b }),
    })
    const input = $('#idle-release-sec')
    if (input) input.value = sec
    toast(t('system.adviceApplied', { sec, max: b || t('common.unlimited') }))
    const hint = $('#idle-release-hint')
    if (hint) {
      hint.textContent = sec > 0
        ? t('system.idleReleaseHintOn', { sec, max: b || t('common.unlimited') })
        : t('system.idleReleaseHintOff', { max: b || t('common.unlimited') })
    }
    renderIdleReleaseAdvice()
  } catch (err) {
    toast(err.message, true)
  }
}

export function schedulingHint(mode: any, concurrency: any, overflowWaitMs: any) {
  const cap = t('system.schedCap', { n: concurrency })
  if (mode === 'spread') {
    return t('system.schedSpread', { cap, wait: overflowWaitMs })
  }
  return t('system.schedSticky', { cap })
}

export async function saveLoadBalanceSettings() {
  const acc = $('#account-concurrency')
  if (!acc) return
  const modeEl = $('#scheduling-mode')
  const waitEl = $('#overflow-wait-ms')
  try {
    const v = Math.max(1, Math.min(16, parseInt(acc.value, 10) || 2))
    const mode = modeEl && modeEl.value === 'spread' ? 'spread' : 'sticky'
    const waitMs = Math.max(
      0,
      Math.min(600000, parseInt((waitEl && waitEl.value) || '15000', 10) || 0),
    )
    const res = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        accountMaxConcurrency: v,
        accountSchedulingMode: mode,
        accountOverflowWaitMs: waitMs,
      }),
    })
    // 用服务端回传的实际生效值刷新控件与文案(夹取/clamp 后的真值)
    const realMode = res.accountSchedulingMode === 'spread' ? 'spread' : 'sticky'
    const realWait = res.accountOverflowWaitMs ?? waitMs
    const realConc = res.accountMaxConcurrency ?? v
    acc.value = realConc
    if (modeEl) modeEl.value = realMode
    if (waitEl) waitEl.value = realWait
    toast(
      realMode === 'spread'
        ? t('system.schedSavedSpread', { n: realConc })
        : t('system.schedSavedSticky', { n: realConc }),
    )
    const hint = $('#scheduling-hint')
    if (hint) {
      hint.textContent =
        schedulingHint(realMode, realConc, realWait) +
        (state.me.role !== 'admin' ? t('system.adminOnly') : '')
    }
  } catch (err) {
    toast(err.message, true)
  }
}

/** 保存[额度保护]设置:空闲自动释放秒数 + 单请求新会话预算(立即生效) */
export async function saveQuotaProtectionSettings() {
  const idle = $('#idle-release-sec')
  const budget = $('#max-new-sessions')
  const lowBal = $('#low-balance-threshold')
  if (!idle || !budget) return
  try {
    const v = Math.max(0, Math.min(86400, parseInt(idle.value, 10) || 0))
    const b = Math.max(0, Math.min(16, parseInt(budget.value, 10) || 0))
    const lb = lowBal ? Math.max(0, Math.min(10000, parseInt(lowBal.value, 10) || 0)) : 15
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        idleReleaseSec: v,
        maxNewSessionsPerRequest: b,
        lowBalanceThreshold: lb,
      }),
    })
    state.lowBalanceThreshold = lb
    toast(v > 0
      ? t('system.quotaSavedOn', { sec: v, max: b || t('common.unlimited') })
      : t('system.quotaSavedOff', { max: b || t('common.unlimited') }))
    // 阈值变了要重画账号分区(低额度分组可能刚被打开/关闭)
    try { await need('refreshAccountsCard')( ) } catch { /* 表未挂载时忽略 */ }
    const hint = $('#idle-release-hint')
    if (hint) {
      hint.textContent = v > 0
        ? t('system.idleReleaseHintOn', { sec: v, max: b || t('common.unlimited') })
        : t('system.idleReleaseHintOff', { max: b || t('common.unlimited') })
    }
    renderIdleReleaseAdvice()
  } catch (err) {
    toast(err.message, true)
  }
}

export async function saveProxyPool() {
  const textarea = $('#proxy-pool')
  if (!textarea) return
  const proxies = textarea.value.split('\n').map((x: any) => x.trim()).filter(Boolean)
  try {
    const r = await api('/api/proxy', { method: 'POST', body: JSON.stringify({ proxies }) })
    toast(r.note || t('toast.saved'))
    // 局部刷新[当前生效代理]文字,不重建页面
    try {
      const pdata = await api('/api/proxy')
      const eff = pdata.effective || []
      // 按[生效代理]这一固定语义锚点找节点:文案本身已随语种变化
      const effNode = [...document.querySelectorAll('#proxy-card .muted')].find(
        (n) => n.textContent.includes(t('proxy.effectivePrefix')),
      )
      if (effNode) {
        effNode.textContent = eff.length
          ? t('proxy.effectiveList', { list: eff.map(need('shortProxy')).join(t('common.listSep')) })
          : t('proxy.notConfiguredDirect')
      }
    } catch { /* ignore */ }
  } catch (err) {
    toast(err.message, true)
  }
}

export async function runProxyTest(proxy: any) {
  const box = $('#proxy-test-result')
  if (!box) return
  box.innerHTML = ''
  box.append(el('span', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [el('span', { class: 'spinner' }), t('proxy.testing')]))
  try {
    const r = await api('/api/proxy/test', {
      method: 'POST',
      body: JSON.stringify(proxy ? { proxy } : {}),
    })
    box.innerHTML = ''
    if (!r.results.length) {
      box.append(el('div', { class: 'muted' }, r.note || t('proxy.notConfiguredDirect')))
      return
    }
    for (const res of r.results) {
      const head = res.ok
        ? el('span', { class: 'badge ok' }, [icon('check', 11), t('proxy.usable')])
        : el('span', { class: 'badge err' }, [icon('x', 11), t('proxy.unusable')])
      const lines = [
        el('div', {}, [
          head,
          el('code', { class: 'mono muted', style: 'margin-left:8px;font-size:12px' }, res.proxy),
        ]),
      ]
      if (res.ok) {
        lines.push(el('div', { class: 'muted' }, [
          t('proxy.egressIp', { ip: res.ip || '?' }),
          res.country ? t('proxy.countryParen', { country: res.country }) : '',
          t('proxy.latencyMs', { ms: res.latencyMs }),
          t('proxy.upstreamStatus', { status: res.codebuffStatus ?? '?' }),
        ].join('')))
      } else {
        lines.push(el('div', { class: 'muted', style: 'color:var(--red)' }, t('proxy.testFailedRow', { msg: res.error || t('proxy.connectFailed'), ms: res.latencyMs })))
        if (res.hint) lines.push(el('div', { class: 'muted', style: 'margin-top:4px' }, res.hint))
      }
      box.append(el('div', { style: 'padding:8px 0;border-bottom:1px solid var(--border)' }, lines))
    }
  } catch (err) {
    box.innerHTML = ''
    box.append(el('div', { class: 'muted', style: 'color:var(--red)' }, t('proxy.testFailed', { msg: err.message })))
  }
}

/**
 * 造三张工具开关卡需要的 attrs(被拒重试 / 工具签名 / 第三方承载).
 *
 * 抽出来只为控制 renderProxySettings 的体量: 三组 attrs 各自三行, 连成一片
 * 会把主流程淹掉, 而它们之间没有任何控制依赖.
 *
 * @param {any} settings /api/settings 回执
 * @returns {any} 三组 attrs 与三个当前开关状态
 */
function buildToolSwitchAttrs(settings: any) {
  const ro = state.me.role !== 'admin'
  const mk = (id: string, onchange: any, enabled: boolean) => {
    const attrs: Record<string, any> = { id, type: 'checkbox', class: 'switch-input', onchange }
    if (enabled) attrs.checked = ''
    if (ro) attrs.disabled = ''
    return attrs
  }
  const signatureEnabled = settings.freeToolSignatureEnabled !== false
  const stripTools = settings.stripToolsOnSchemaRejection === true
  const carrierEnabled = settings.toolCarrierEnabled !== false
  // 自动签到默认关闭: 它要发消息(有成本), 替用户默认打开是错的.
  const autoSignInEnabled = settings.autoSignInEnabled === true
  return {
    signatureEnabled, stripTools, carrierEnabled, autoSignInEnabled,
    toggleAttrs: mk('free-tool-signature', saveFreeToolSignatureSetting, signatureEnabled),
    stripAttrs: mk('strip-tools-on-reject', saveStripToolsSetting, stripTools),
    carrierAttrs: mk('tool-carrier', saveToolCarrierSetting, carrierEnabled),
    autoSignInAttrs: mk('auto-signin', saveAutoSignInSetting, autoSignInEnabled),
  }
}
