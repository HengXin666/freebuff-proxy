import { t } from '../../locale/index.js'
import { $, el, icon } from '../../lib/dom.js'
import { need } from '../../lib/hooks.js'
import { state } from '../../lib/state.js'

/**
 * 代理设置页的六张卡片(纯渲染,无副作用).
 *
 * 为什么单独成文件:这六张卡合计 240 行节点树,与[保存/校验/读设置]的控制逻辑
 * 挤在同一文件会双双超过 500 行硬标准.这里只保留[给数据 -> 出节点],所有事件
 * 回调仍然直接引用同目录 index.js 的保存函数 ---- 那是模块内的正常引用,不存在
 * 循环依赖(index.js 只引用本文件的构建函数,本文件不引用它).
 *
 * 本文件所有函数都只做 DOM 构造:不发请求,不写 state,不弹提示.
 */

/** 免费额度策略卡:官方工具签名兼容开关. */
export function buildFreeToolSignatureCard(toggleAttrs, signatureEnabled) {
  return el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.freeQuotaPolicy')),
      el('span', { class: 'muted' }, t('system.toolSignatureHint')),
    ]),
    el('label', { class: 'switch', for: 'free-tool-signature' }, [
      el('input', toggleAttrs),
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      el('span', { class: 'switch-status' }, signatureEnabled ? t('common.on') : t('common.off')),
    ]),
  ])
}

/** 工具请求兜底卡:被拒时是否剥离 tools 重试. */
export function buildStripToolsCard(stripAttrs, stripTools) {
  return el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.toolFallback')),
      el('span', { class: 'muted' }, t('system.toolFallbackHint')),
    ]),
    el('label', { class: 'switch', for: 'strip-tools-on-reject' }, [
      el('input', stripAttrs),
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      el('span', { class: 'switch-status' }, stripTools ? t('common.on') : t('common.off')),
    ]),
  ])
}

/** 上游请求链路卡:legacy 已废弃(禁用但可见),official 是唯一有效值. */
export function buildUpstreamChannelCard(channel) {
  return el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.upstreamChannel')),
      el('span', { class: 'muted' }, t('system.upstreamChannelHint')),
    ]),
    el('div', { class: 'row' }, [
      el('select', {
        id: 'upstream-channel',
        style: 'width:320px',
        onchange: need('saveUpstreamChannelSetting'),
        ...(state.me.role === 'admin' ? {} : { disabled: '' }),
      }, [
        // legacy 已废弃:保留选项但禁用,让用户看得见"曾经有过,现在不能用",
        // 而不是凭空消失造成困惑.
        el('option', { value: 'legacy', disabled: '' }, t('system.upstreamChannelLegacy')),
        el('option', { value: 'official', ...(channel === 'official' ? { selected: '' } : {}) }, t('system.upstreamChannelOfficial')),
      ]),
    ]),
  ])
}

/** 负载均衡卡:调度模式 / 账号并发上限 / 溢出等待. */
export function buildLoadBalanceCard(schedMode, concurrency, overflowWaitMs) {
  return el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('system.scheduling')),
        el('span', { class: 'muted' }, t('system.schedulingHint')),
      ]),
    ]),
    el('div', { class: 'row', style: 'margin-top:12px;gap:24px;flex-wrap:wrap' }, [
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.schedulingMode')),
        el('div', { class: 'row' }, [
          el('select', {
            id: 'scheduling-mode',
            style: 'width:210px',
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }, [
            el('option', { value: 'sticky', ...(schedMode === 'sticky' ? { selected: '' } : {}) }, t('system.modeSticky')),
            el('option', { value: 'spread', ...(schedMode === 'spread' ? { selected: '' } : {}) }, t('system.modeSpread')),
          ]),
        ]),
      ]),
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.accountConcurrency')),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'account-concurrency',
            type: 'number',
            min: 1,
            max: 16,
            style: 'width:70px',
            value: concurrency,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
        ]),
      ]),
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.overflowWait')),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'overflow-wait-ms',
            type: 'number',
            min: 0,
            max: 600000,
            step: 1000,
            style: 'width:110px',
            value: overflowWaitMs,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
        ]),
      ]),
      state.me.role === 'admin'
        ? el('div', { style: 'align-self:flex-end' }, el('button', { class: 'primary', onclick: need('saveLoadBalanceSettings') }, t('common.saveApply')))
        : null,
    ]),
    el('div', { class: 'muted', id: 'scheduling-hint', style: 'margin-top:8px' }, need('schedulingHint')(schedMode, concurrency, overflowWaitMs) + (state.me.role !== 'admin' ? t('system.adminOnly') : '')),
  ])
}

/** 额度保护卡:空闲释放 + 单请求新会话预算 + 低额度阈值 + 推荐值. */
export function buildQuotaProtectionCard(advice, idleReleaseSec, lowBalanceThreshold, maxNewSessions) {
  return el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('system.quotaProtection')),
        el('span', { class: 'muted' }, t('system.twoLedgers')),
      ]),
    ]),
    ...buildQuotaLedgerNotes(),
    el('div', { class: 'row', style: 'margin-top:12px;gap:24px;flex-wrap:wrap' }, [
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.idleRelease')),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'idle-release-sec',
            type: 'number',
            min: 0,
            max: 86400,
            style: 'width:90px',
            value: idleReleaseSec,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
        ]),
      ]),
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.lowBalanceThreshold')),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'low-balance-threshold',
            type: 'number',
            min: 0,
            max: 10000,
            style: 'width:90px',
            value: lowBalanceThreshold,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
        ]),
      ]),
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.maxNewSessions')),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'max-new-sessions',
            type: 'number',
            min: 0,
            max: 16,
            style: 'width:90px',
            value: maxNewSessions,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
          state.me.role === 'admin'
            ? el('button', { class: 'primary', onclick: need('saveQuotaProtectionSettings') }, t('common.saveApply'))
            : null,
        ]),
      ]),
    ]),
    el('div', { class: 'muted', id: 'idle-release-hint', style: 'margin-top:8px' },
      idleReleaseSec > 0
        ? t('system.idleReleaseHintOn', { sec: idleReleaseSec, max: maxNewSessions || t('common.unlimited') })
        : t('system.idleReleaseHintOff', { max: maxNewSessions || t('common.unlimited') })),
    el('div', { id: 'idle-release-advice', style: 'margin-top:10px;padding:10px;border-radius:8px;background:rgba(255,196,0,.08);border:1px solid rgba(255,196,0,.25)' }, [
      el('div', { style: 'font-weight:600;margin-bottom:4px' }, t('system.adviceTitle')),
      el('div', { class: 'muted', id: 'idle-release-advice-text' }, advice.why),
      el('div', { class: 'advice-actions' }, [
        state.me.role === 'admin' && advice.sec !== idleReleaseSec
          ? el('button', { class: 'primary', style: 'margin-top:8px', onclick: () => need('applyIdleReleaseAdvice')(advice.sec) }, t('system.adviceApply', { sec: advice.sec }))
          : el('div', { class: 'muted', style: 'margin-top:6px' }, advice.sec === idleReleaseSec ? t('system.adviceInSync') : t('system.adviceAdminHint')),
      ]),
    ]),
  ])
}

/** 计费口径说明:一次 admit 买断一小时 / 退款不对称(units 退, Freebucks 不退). */
export function buildQuotaLedgerNotes() {
  return [
    el('div', { class: 'muted', style: 'margin-top:6px;line-height:1.6' }, [
      el('b', {}, t('system.admitBuysHour')),
      t('system.admitBody1'),
      el('b', {}, t('system.admitMarginalZero')),
      t('system.admitBody2'),
      el('b', {}, t('system.admitNoIdleRelease')),
      t('system.admitBody3'),
    ]),
    el('div', { class: 'muted', style: 'margin-top:6px;line-height:1.6' }, [
      t('system.refundAsymmetric'),
      el('b', {}, t('system.refundUnits')),
      t('system.refundUnitsBody'),
      el('b', {}, t('system.refundFreebucks')),
      t('system.refundFreebucksBody'),
      el('b', {}, t('system.refundFreebucksFirst')),
      t('system.refundConclusion'),
    ]),
    el('div', { class: 'muted', style: 'margin-top:6px' }, t('system.refundSources')),
  ]
}

/** 全局代理池卡:一行一个代理 + 测试入口 + 当前生效列表. */
export function buildProxyPoolCard(data) {
  return el('div', { id: 'proxy-card', class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('proxy.cardTitle')),
        el('span', { class: 'muted' }, t('proxy.cardHint')),
      ]),
      el('button', { class: 'primary', onclick: need('saveProxyPool') }, [icon('globe', 14), t('common.saveApply')]),
    ]),
    el('textarea', {
      id: 'proxy-pool',
      rows: 3,
      class: 'mono',
      style: 'margin-top:8px',
      placeholder: t('proxy.poolPlaceholder'),
    }, (data.proxies || []).join('\n')),
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('input', {
        id: 'proxy-test-url',
        placeholder: t('proxy.testPlaceholder'),
        class: 'mono',
        style: 'flex:1',
      }),
      el('button', { onclick: () => need('runProxyTest')($('#proxy-test-url').value.trim() || null) }, [icon('zap', 14), t('common.test')]),
      el('button', { class: 'muted', onclick: () => need('runProxyTest')(null) }, t('proxy.testConfigured')),
    ]),
    el('div', { id: 'proxy-test-result', style: 'margin-top:8px' }),
    data.effective && data.effective.length
      ? el('div', { class: 'muted', style: 'margin-top:8px' }, t('proxy.effectiveList', { list: data.effective.map(need('shortProxy')).join('、') }))
      : null,
  ])
}
