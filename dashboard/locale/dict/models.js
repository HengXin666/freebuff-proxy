/**
 * models 域的词条表 -- 从 dashboard/i18n.js 的 DICT 按域切出.
 *
 * 为什么按域切: DICT 原本 815 行单文件(超前端每文件 500 行上限), 而它全部是
 * "key -> { 'zh-CN': ..., en: ... }" 的数据行, 没有任何逻辑. 按域切之后
 * 每种语言的新增文案只改一个文件, 而不是在 800 行里定位.
 *
 * 口径: 纯切分, key 与文案逐字节不变.
 */
export default {
  // ---- 模型 ----
  'model.syncUpstream': { 'zh-CN': '同步上游模型', en: 'Sync from upstream' },
  'model.syncHint': {
    'zh-CN': '内置目录 + 上游实时 + 自定义覆盖。上游新模型不用等发版——点「同步上游模型」自动拉取并更新 agent，或手动添加。',
    en: 'Built-in catalog + live upstream + custom overrides. New upstream models need no release — click "Sync from upstream" or add manually.',
  },
  // ── 同步后的对齐报告(2026-10-04)────────────────────────────
  // 旧文案只报[自定义 {n} 条]:数字越大看着越成功,而那批自定义里
  // 绝大部分上游目录根本没有,调用必失败.改成按上游目录三向对账.
  'model.syncReportTitle': { 'zh-CN': '模型已对齐上游', en: 'Models aligned with upstream' },
  'model.syncReportAligned': { 'zh-CN': '上游可用 {n} 个', en: '{n} available upstream' },
  'model.syncReportAdded': { 'zh-CN': '本次新增 {n} 个', en: '{n} added' },
  'model.syncReportStale': { 'zh-CN': '上游已无 {n} 个', en: '{n} no longer upstream' },
  'model.syncReportBody': {
    'zh-CN': '列表已按上游实时目录对齐：只有出现在上游目录里的模型，你的账号才真正调得动。',
    en: 'The list is aligned with the live upstream catalog: only models present upstream can your account actually call.',
  },
  'model.syncReportStaleHint': {
    'zh-CN': '另有 {n} 个不在上游目录里（内置或手动添加的残留），调用必然失败，建议清理。',
    en: '{n} more are not in the upstream catalog (leftover built-ins or manual entries) and will always fail — consider pruning them.',
  },
  'model.syncReportPrune': { 'zh-CN': '清理这 {n} 个', en: 'Prune these {n}' },
  // ── 模型管理页的[账号可用]标记 ─────────────────────────────
  'model.liveHeader': { 'zh-CN': '账号可用', en: 'Usable' },
  'model.liveYes': { 'zh-CN': '可用', en: 'yes' },
  'model.liveNo': { 'zh-CN': '不可用', en: 'no' },
  'model.liveYesTitle': {
    'zh-CN': '上游目录里有这个模型，你的账号可以调用',
    en: 'Present in the upstream catalog — your account can call it',
  },
  'model.liveNoTitle': {
    'zh-CN': '上游目录里没有这个模型（内置残留或手动添加），调用必然失败；可隐藏或移除',
    en: 'Not in the upstream catalog (stale built-in or manual entry) — calls will always fail; hide or remove it',
  },
  'model.liveCount': { 'zh-CN': '上游可用 {n} 个', en: '{n} usable upstream' },
  'model.staleCount': { 'zh-CN': '{n} 个调不了', en: '{n} unusable' },
  'model.staleHint': {
    'zh-CN': '灰显且标「不可用」的不在上游目录里，你的账号调了必失败',
    en: 'Rows greyed out and marked unusable are absent upstream; calls from your account will always fail',
  },
  'model.prune': { 'zh-CN': '清理 {n} 个', en: 'Prune {n}' },
  'model.pruneTitle': {
    'zh-CN': '隐藏/移除所有不在上游目录里的模型（内置可恢复，手动添加的彻底移除）',
    en: 'Hide or remove every model absent upstream (built-ins are restorable; manual entries are removed for good)',
  },
  'model.pruned': { 'zh-CN': '已清理 {n} 个不可用的模型', en: 'Pruned {n} unusable models' },
  'model.pruneFail': { 'zh-CN': '清理失败: {msg}', en: 'Prune failed: {msg}' },
  'model.syncFail': { 'zh-CN': '同步失败: {msg}', en: 'Sync failed: {msg}' },
  'model.fetchFail': { 'zh-CN': '拉取上游失败: {msg}', en: 'Failed to fetch upstream: {msg}' },
  'model.noneUpstream': { 'zh-CN': '上游暂无可用模型', en: 'No models available upstream' },
  'model.catalogFail': { 'zh-CN': '未能拿到上游目录: {msg}', en: 'Could not fetch upstream catalog: {msg}' },
  'model.hideConfirm': {
    'zh-CN': '确定隐藏模型 {id}？\n（内置模型隐藏后可恢复；重新同步上游会按最新列表拉回）',
    en: 'Hide model {id}?\n(A hidden built-in can be restored; syncing pulls the latest list back)',
  },
  'model.pool': { 'zh-CN': '池', en: 'Pool' },
  'model.available': { 'zh-CN': '可用', en: 'Available' },
  'model.management': { 'zh-CN': '模型管理', en: 'Models' },
  'model.id': { 'zh-CN': '模型 id', en: 'Model id' },
  'model.idHint': {
    'zh-CN': '对外模型名（catalogId 优先，其次上游显示名）。悬停可看服务端目录 key',
    en: 'The public model name (catalogId first, then upstream display name). Hover for the server-side catalog key',
  },
  'model.displayName': { 'zh-CN': '显示名', en: 'Display name' },
  'model.quotaHeader': { 'zh-CN': '额度（今日 · FB/h）', en: 'Quota (today · FB/h)' },
  'model.agentBase2': { 'zh-CN': 'agent (base2)', en: 'agent (base2)' },
  'model.fallbackAgentBase3': { 'zh-CN': '兜底 agent (base3)', en: 'fallback agent (base3)' },
  'model.source': { 'zh-CN': '来源', en: 'Source' },
  'model.sourceUpstream': { 'zh-CN': '上游', en: 'upstream' },
  'model.sourceBuiltin': { 'zh-CN': '内置', en: 'built-in' },
  'model.deleteTitle': { 'zh-CN': '删除该模型（从列表与调度中移除）', en: 'Delete this model (removed from the list and from scheduling)' },
  'model.blockPremium': {
    'zh-CN': '屏蔽收费模型（pool=premium 如 gpt-5.6-luna / kimi / -max：免费账号用不了，从列表与调度彻底排除，避免占额度/触风控）',
    en: 'Block paid models (pool=premium, e.g. gpt-5.6-luna / kimi / -max: unusable on free accounts, fully excluded from the list and from scheduling to avoid burning quota or tripping risk control)',
  },
  'model.upstreamCatalog': {
    'zh-CN': '上游实时目录（{n} 个）· 当前 accessTier: {tier}',
    en: 'Live upstream catalog ({n}) · current accessTier: {tier}',
  },
  'model.customLabel': {
    'zh-CN': '自定义模型（添加/编辑即自动保存，留空字段自动推导）',
    en: 'Custom models (adding or editing saves automatically; blank fields are derived)',
  },
  'model.add': { 'zh-CN': '添加模型', en: 'Add model' },
  'model.overrideHint': {
    'zh-CN': '同 id 会覆盖内置目录的显示名 / 池 / agent；agent 留空时按命名规则自动推导（base2-free-<模型名>）',
    en: 'Reusing an id overrides the catalog display name / pool / agent; leave agent blank to derive it by naming convention (base2-free-<model-name>)',
  },
  'model.hiddenArea': {
    'zh-CN': '已删除的模型（{n}）— 点击可恢复，恢复后重新出现在列表并可调度',
    en: 'Deleted models ({n}) — click to restore; they reappear in the list and can be scheduled again',
  },
  'model.hiddenAreaShort': { 'zh-CN': '已删除的模型 — 点击可恢复', en: 'Deleted models — click to restore' },
  'model.restoreTitle': { 'zh-CN': '恢复该模型', en: 'Restore this model' },
  'model.removeConfirm': {
    'zh-CN': '确定移除自定义模型 {id}？\n（这是彻底删除，将回退到内置目录）',
    en: 'Remove custom model {id}?\n(This is permanent and falls back to the built-in catalog)',
  },
  'model.hidden': { 'zh-CN': '已隐藏模型 {id}', en: 'Model {id} hidden' },
  'model.removed': { 'zh-CN': '已移除自定义模型 {id}', en: 'Custom model {id} removed' },
  'model.restored': { 'zh-CN': '已恢复模型 {id}', en: 'Model {id} restored' },
  'model.saveFail': { 'zh-CN': '保存模型失败: {msg}', en: 'Failed to save models: {msg}' },
  'model.emptyCustom': { 'zh-CN': '还没有自定义模型——点「添加模型」开始', en: 'No custom models yet — click "Add model" to start' },
  'model.idPlaceholder': { 'zh-CN': 'z-ai/glm-5.3-flash', en: 'z-ai/glm-5.3-flash' },
  'model.displayNamePlaceholder': { 'zh-CN': '显示名（可选）', en: 'Display name (optional)' },
  'model.poolDefault': { 'zh-CN': '池（默认）', en: 'Pool (default)' },
  'model.agentPlaceholder': { 'zh-CN': 'base2-free-…（留空自动推导）', en: 'base2-free-… (blank = derived)' },
  'model.fallbackAgentPlaceholder': { 'zh-CN': 'base3-free-…（兜底，可选）', en: 'base3-free-… (fallback, optional)' },
  'model.poolPremium': { 'zh-CN': '高级', en: 'Premium' },
  'model.poolDaily': { 'zh-CN': '每日', en: 'Daily' },
  'model.poolReferral': { 'zh-CN': '邀请', en: 'Referral' },
  'model.poolLimitedOffer': { 'zh-CN': '限时', en: 'Limited offer' },
  'model.poolGlmV53Flash': { 'zh-CN': 'GLM 5.3', en: 'GLM 5.3' },

  // ---- 测试对话 ----
  'playground.title': { 'zh-CN': '测试对话', en: 'Playground' },
  'playground.subtitle': { 'zh-CN': '经 /v1/chat/completions 真实转发（流式）', en: 'Real streaming proxy through /v1/chat/completions' },
  'playground.modelSelect': { 'zh-CN': '模型（{n} 个可选{extra}）', en: 'Model ({n} available{extra})' },
  'playground.modelQuotaSuffix': { 'zh-CN': ' · 上游当前给额度 {n} 个', en: ' · {n} currently granted quota upstream' },
  'playground.reloadModels': { 'zh-CN': '刷新模型列表', en: 'Reload model list' },
  'playground.checkMark': { 'zh-CN': ' = 上游此刻给了该模型额度', en: ' = upstream is granting quota for this model right now' },
  'playground.catalogEmpty': { 'zh-CN': '上游目录为空：请确认账号已导入并完成一次探测', en: 'Upstream catalog is empty: import an account and run a probe first' },
  'playground.notProbed': { 'zh-CN': '尚未探测上游目录（服务不会自动探测）：请到「账号」点「一键刷新」', en: 'Upstream catalog not probed yet (no auto-probe): click "Refresh all" under Accounts' },
  'playground.catalogLoadFail': {
    'zh-CN': '模型列表加载失败：{msg}（可点总览页「一键刷新」后重试）',
    en: 'Failed to load the model list: {msg} (retry after "Refresh all" on the Overview page)',
  },
  'playground.apiKey': { 'zh-CN': 'API Key（默认用你的）', en: 'API Key (defaults to yours)' },
  'playground.message': { 'zh-CN': '消息（一行一条，user/assistant 前缀可选）', en: 'Messages (one per line; user/assistant prefix optional)' },
  'playground.messagePlaceholder': { 'zh-CN': '你好，介绍一下你自己', en: 'Hello, introduce yourself' },
  'playground.send': { 'zh-CN': '发送', en: 'Send' },
  'playground.modelsReloaded': { 'zh-CN': '模型列表已刷新（{n} 个{extra}）', en: 'Model list reloaded ({n}{extra})' },
  'playground.modelsReloadedSuffix': { 'zh-CN': '，上游给额度 {n} 个', en: ', {n} granted quota upstream' },
  'playground.errorPrefix': { 'zh-CN': '错误: ', en: 'Error: ' },
}
