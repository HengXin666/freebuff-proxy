/* Freebuff Proxy 控制台 — 多语言支持（零依赖）
 *
 * 设计约束（项目铁律：轻量优先）：
 *   - 无构建步骤、无第三方库：字典是普通对象，t() 是普通函数。
 *   - 后端零改动：语言是纯前端偏好，存 localStorage，不进 /data、不进 API。
 *   - 新增文案**必须**走 t('key')，禁止直接写中文字面量 ——
 *     由 scripts/check-i18n.mjs 在 CI 里强制（见 .github/workflows/docker-image.yml
 *     的 i18n job）。红线内容：
 *       1) dashboard/app.js 里出现硬编码 CJK 字面量 → 失败
 *       2) 各语言词条 key 与 zh-CN 不一致（缺/多） → 失败
 *       3) 代码里用到但字典里没有的 key → 失败
 *
 * 语种：zh-CN（基准）/ en。
 * 基准语言是 zh-CN：新增 key 先写进 zh-CN，其它语种缺失会被红线拦下。
 */

export const LOCALES = ['zh-CN', 'en']
export const DEFAULT_LOCALE = 'zh-CN'
const STORAGE_KEY = 'fb_locale'

/**
 * 语种**自己**的名字（语言切换器里显示）。
 *
 * ⚠️ 故意**不翻译**：切换器必须让每个人都能认出自己的语言
 * （中文用户看 "简体中文"、英文用户看 "English"），把 "English" 翻成
 * "英文" 反而害了不懂当前界面语言的用户。这是语言列表的通行做法。
 * 放在 i18n.js 而非 app.js：它是字典元数据，且红线只扫 app.js 的界面文案。
 */
export const LOCALE_LABELS = {
  'zh-CN': '简体中文',
  en: 'English',
}

/**
 * 顶栏按钮上的**极短**标签（中 / EN）。
 * 用全名会把顶栏撑宽（原生下拉与按钮都按最长内容取值），所以按钮只放短码，
 * 全名放在 LOCALE_LABELS（title / aria-label）。
 */
export const LOCALE_SHORT = {
  'zh-CN': '中',
  en: 'EN',
}

/** 字典：key → { 'zh-CN': ..., en: ... } */
const DICT = {
  // ---- 通用 ----
  'common.ok': { 'zh-CN': '正常', en: 'OK' },
  'common.cancel': { 'zh-CN': '取消', en: 'Cancel' },
  'common.save': { 'zh-CN': '保存', en: 'Save' },
  'common.delete': { 'zh-CN': '删除', en: 'Delete' },
  'common.refresh': { 'zh-CN': '刷新', en: 'Refresh' },
  'common.loading': { 'zh-CN': '加载中…', en: 'Loading…' },
  'common.none': { 'zh-CN': '—', en: '—' },
  'common.actions': { 'zh-CN': '操作', en: 'Actions' },
  'common.close': { 'zh-CN': '关闭', en: 'Close' },
  'common.copy': { 'zh-CN': '复制', en: 'Copy' },
  'common.copied': { 'zh-CN': '已复制', en: 'Copied' },
  'common.search': { 'zh-CN': '搜索', en: 'Search' },
  'common.reset': { 'zh-CN': '重置', en: 'Reset' },
  'common.test': { 'zh-CN': '测试', en: 'Test' },
  'common.status': { 'zh-CN': '状态', en: 'Status' },
  'common.times': { 'zh-CN': '{n} 次', en: '{n}' },
  'common.unknown': { 'zh-CN': '未知', en: 'Unknown' },
  'common.unlimited': { 'zh-CN': '不限', en: 'unlimited' },
  'common.on': { 'zh-CN': '已开启', en: 'On' },
  'common.off': { 'zh-CN': '已关闭', en: 'Off' },
  'common.saveApply': { 'zh-CN': '保存并生效', en: 'Save and apply' },
  'common.refreshing': { 'zh-CN': '刷新中…', en: 'Refreshing…' },
  'common.listSep': { 'zh-CN': '、', en: ', ' },

  // ---- 导航 / 顶栏 ----
  'nav.language': { 'zh-CN': '语言', en: 'Language' },
  // 切换器按钮上的短标签：必须**极短**，否则顶栏被撑宽（原生 select 按最长
  // option 撑开的宽度是这里踩过的坑）。用语种短码而非全名。
  'nav.languageSwitchTo': {
    'zh-CN': '切换到 English',
    en: 'Switch to 简体中文',
  },
  'nav.logout': { 'zh-CN': '退出登录', en: 'Log out' },
  'nav.overview': { 'zh-CN': '总览', en: 'Overview' },
  'nav.system': { 'zh-CN': '系统', en: 'System' },
  'nav.usersManagement': { 'zh-CN': '用户管理', en: 'Users' },
  'nav.playground': { 'zh-CN': '测试对话', en: 'Playground' },
  'nav.logs': { 'zh-CN': '日志', en: 'Logs' },
  'nav.me': { 'zh-CN': '我的', en: 'Me' },
  'nav.reconnect': { 'zh-CN': '全部断开重连', en: 'Reconnect all' },
  'nav.reconnectTip': {
    'zh-CN': '比重启更轻量：释放全部 session、清理死任务，下个请求自动重建（不重启进程）',
    en: 'Lighter than a restart: releases every session and clears dead tasks; the next request rebuilds automatically (no process restart)',
  },
  'nav.restart': { 'zh-CN': '重启服务', en: 'Restart service' },
  'nav.restartTip': { 'zh-CN': '彻底解决连接卡死等问题：重启整个代理服务（约几秒）', en: 'Last resort for stuck connections: restarts the whole proxy service (a few seconds)' },
  'nav.repoTip': { 'zh-CN': '开源仓库（版本 v{version}{commit}）', en: 'Open-source repo (version v{version}{commit})' },

  // ---- 登录 ----
  'login.username': { 'zh-CN': '用户名', en: 'Username' },
  'login.password': { 'zh-CN': '密码', en: 'Password' },
  'login.submit': { 'zh-CN': '登录', en: 'Sign in' },
  'login.submitting': { 'zh-CN': '登录中', en: 'Signing in' },
  'login.success': { 'zh-CN': '登录成功', en: 'Signed in' },
  'login.notSignedIn': { 'zh-CN': '未登录', en: 'Not signed in' },
  'login.firstDeployHint': {
    'zh-CN': '首次部署的管理员账号/密码会打印在 docker compose logs 里',
    en: 'On first deploy the admin username/password is printed in `docker compose logs`',
  },

  // ---- 总览 ----
  'overview.accountPool': { 'zh-CN': '账号池', en: 'Account pool' },
  'overview.accountPoolCount': { 'zh-CN': '账号池（{n}）', en: 'Account pool ({n})' },
  'overview.balanceBarTitle': { 'zh-CN': '{email} {pct}%（{used}/{total}）', en: '{email} {pct}% ({used}/{total})' },

  // ---- 账号 ----
  'account.email': { 'zh-CN': '账号', en: 'Account' },
  'account.session': { 'zh-CN': 'Session', en: 'Session' },
  'account.concurrency': { 'zh-CN': '并发', en: 'Concurrency' },
  'account.timeline': { 'zh-CN': '时间轴（导入/更新/调度）', en: 'Timeline (imported/updated/scheduled)' },
  'account.requests': { 'zh-CN': '请求', en: 'Requests' },
  'account.cooldown': { 'zh-CN': '冷却', en: 'Cooldown' },
  'account.freebucks': { 'zh-CN': 'Freebucks', en: 'Freebucks' },
  'account.import': { 'zh-CN': '导入账号', en: 'Import account' },
  'account.credentialTitle': { 'zh-CN': '账号凭证 · {email}', en: 'Credential · {email}' },
  'account.readFailed': { 'zh-CN': '读取失败', en: 'Failed to read' },
  'account.credentialHint': {
    'zh-CN': '凭据 JSON 可直接用于导入到其他 Freebuff Proxy 实例，或重新粘贴到「导入账号」。明文显示，仅供迁移/备份。',
    en: 'This credential JSON can be imported into another Freebuff Proxy instance, or pasted back into "Import account". Shown in plain text for migration/backup only.',
  },
  'account.credentialCopied': { 'zh-CN': '已复制完整凭据 JSON', en: 'Full credential JSON copied' },
  'account.copyJson': { 'zh-CN': '复制 JSON', en: 'Copy JSON' },
  'account.downloadJson': { 'zh-CN': '下载 JSON', en: 'Download JSON' },
  'account.addTitle': { 'zh-CN': '添加 Freebuff 账号（浏览器登录）', en: 'Add Freebuff account (browser sign-in)' },
  'account.requestingLoginUrl': { 'zh-CN': '服务端正在向 Freebuff 申请登录链接…', en: 'Requesting a sign-in URL from Freebuff…' },
  'account.openInBrowser': {
    'zh-CN': '在你自己电脑的浏览器打开下面的链接并完成登录（容器内不会打开浏览器）：',
    en: 'Open the link below in your own browser and finish signing in (no browser is launched inside the container):',
  },
  'account.openLink': { 'zh-CN': '打开链接并登录', en: 'Open link and sign in' },
  'account.autoRefresh': { 'zh-CN': '完成登录后本窗口会自动刷新', en: 'This window refreshes automatically once you finish' },
  'account.waitingCallback': { 'zh-CN': '等待登录回调…', en: 'Waiting for the sign-in callback…' },
  'account.waitingCallbackPolling': { 'zh-CN': '等待登录回调…（服务端正在轮询）', en: 'Waiting for the sign-in callback… (server is polling)' },
  'account.loginStartFailed': { 'zh-CN': '发起登录失败', en: 'Failed to start sign-in' },
  'account.loginSuccess': { 'zh-CN': '登录成功：{email}{id}', en: 'Signed in: {email}{id}' },
  'account.loginIdSuffix': { 'zh-CN': '（ID {id}）', en: ' (ID {id})' },
  'account.addedProbing': { 'zh-CN': '账号 {email} 已添加，正在探测上游…', en: 'Account {email} added; probing upstream…' },
  'account.loginCancelled': { 'zh-CN': '已取消，请重新发起', en: 'Cancelled — please start again' },
  'account.importJsonHint': {
    'zh-CN': '粘贴 credentials JSON（从旧环境导出；proxy 为可选专属出口代理）：',
    en: 'Paste the credentials JSON (exported from a previous setup; proxy is an optional dedicated egress):',
  },
  'account.importedProbing': { 'zh-CN': '导入成功，正在探测上游…', en: 'Imported; probing upstream…' },
  'account.sessionWithModel': { 'zh-CN': '会话（{model}）', en: 'session ({model})' },
  'account.closeSessionConfirm': {
    'zh-CN': '确认关闭 {email} 的{label}？\n\n会立即向上游发起早退 DELETE 停止计费；\n若此刻有回复正在传输，会先等它结束（最多 10 秒），超时才中断。',
    en: 'Close the {label} of {email}?\n\nAn early-release DELETE is sent upstream immediately to stop billing;\nif a reply is still streaming, it waits for it to finish (up to 10s) before cutting it off.',
  },
  'account.refundSuffix': { 'zh-CN': '，退款 {n} FB', en: ', refunded {n} FB' },
  'account.interrupted': { 'zh-CN': '（在途回复被中断）', en: ' (in-flight reply interrupted)' },
  'account.sessionClosed': { 'zh-CN': '✅ 已关闭 {email} 的会话{extra}{cut}', en: '✅ Closed the session of {email}{extra}{cut}' },
  'account.sessionCloseFailed': {
    'zh-CN': '⚠️ 会话未关闭成功：{msg}（句柄已记录，服务重启时会自动重试退款）',
    en: '⚠️ Could not close the session: {msg} (the handle is recorded; the refund is retried on service restart)',
  },
  'account.upstreamRejected': { 'zh-CN': '上游拒绝', en: 'upstream rejected' },
  'account.cooldownCleared': { 'zh-CN': '已解除冷却', en: 'Cooldown cleared' },
  'account.deleteConfirm': { 'zh-CN': '确认删除账号 {email}？', en: 'Delete account {email}?' },
  'account.deleted': { 'zh-CN': '已删除', en: 'Deleted' },
  'account.emptyNoFreebuff': { 'zh-CN': '还没有 Freebuff 账号。', en: 'No Freebuff accounts yet.' },
  'account.section.banned.label': { 'zh-CN': '已被封禁', en: 'Suspended' },
  'account.section.banned.hint': { 'zh-CN': '上游已封号，不会再被调度', en: 'Banned upstream; will never be scheduled again' },
  'account.section.exhausted.label': { 'zh-CN': '额度不足', en: 'Out of quota' },
  'account.section.exhausted.hint': { 'zh-CN': 'Freebucks 买不起当前模型，等池子刷新或加号', en: 'Not enough Freebucks for the current model; wait for the pool to refresh or add accounts' },
  'account.section.warning.label': { 'zh-CN': '出现警告', en: 'Warning' },
  'account.section.warning.hint': { 'zh-CN': '限流 / 风控 / 探测失败，但还没封号', en: 'Rate limited / risk control / probe failure, but not banned yet' },
  'account.section.lowbalance.label': { 'zh-CN': '低额度', en: 'Low balance' },
  'account.section.lowbalance.hint': { 'zh-CN': '余额已接近见底——仍会被正常调度，只是提前提醒你该补号了', en: 'Balance is nearly drained — still scheduled normally, just an early heads-up to add accounts' },
  'account.section.active.label': { 'zh-CN': '正在调度', en: 'Active' },
  'account.section.active.hint': { 'zh-CN': '有活跃会话或已被选中过', en: 'Has a live session or has already been picked' },
  'account.section.fresh.label': { 'zh-CN': '从未使用', en: 'Unused' },
  'account.section.fresh.hint': { 'zh-CN': '还没被调度过（干净号，尽量别浪费）', en: 'Never scheduled yet (clean accounts — avoid burning them)' },
  'account.quotaHeader': { 'zh-CN': '额度（今日 · FB/h）', en: 'Quota (today · FB/h)' },
  'account.countsTip': {
    'zh-CN': '买过 {admits} 条会话（每条实付一整小时），复用 {reuses} 次',
    en: 'Bought {admits} sessions (each billed as a full hour), reused {reuses} times',
  },
  'account.countsRate': { 'zh-CN': ' · 复用率 {rate}%', en: ' · reuse rate {rate}%' },
  'account.countsTipTail': {
    'zh-CN': '。复用发生在已买断的一小时内，不再产生任何扣费。',
    en: '. Reuse happens inside the already purchased hour and costs nothing more.',
  },
  'account.noActiveSession': { 'zh-CN': '无活跃', en: 'No active session' },
  'account.boughtReuse': {
    'zh-CN': '买 {admits} · 复用 {reuses}（省 {rate}%）',
    en: 'Bought {admits} · reused {reuses} (saved {rate}%)',
  },
  'account.bought': { 'zh-CN': '买 {admits}', en: 'Bought {admits}' },
  'account.bannedShort': { 'zh-CN': '已封禁', en: 'Banned' },
  'account.coolingUntil': { 'zh-CN': '冷却至 {until}', en: 'Cooling until {until}' },
  'account.unavailable': { 'zh-CN': '不可用', en: 'Unavailable' },
  'account.statusTipBanned': {
    'zh-CN': '上游已封禁该账号（不可自行恢复，只能换号或等平台解封）',
    en: 'Upstream banned this account (not self-recoverable — swap it or wait for upstream to lift the ban)',
  },
  'account.statusTipUnavailable': {
    'zh-CN': '上游暂时拒付/限流（冷却到期自动恢复；会话句柄保留，已购时段不受影响）',
    en: 'Upstream is temporarily refusing or rate-limiting (auto-recovers when cooldown ends; the session handle is kept and the paid window is unaffected)',
  },
  'account.statusTipOk': { 'zh-CN': '正常：可参与调度', en: 'Healthy: eligible for scheduling' },
  'account.probeTitle': {
    'zh-CN': '检测该账号（只读拉取状态/模型列表，不占额度）',
    en: 'Check this account (read-only: pulls status and model list, spends no quota)',
  },
  'account.closeSessionTitle': {
    'zh-CN': '关闭这个上游会话（立即早退 DELETE，停止按占用时长计费；有回复在传输时会先等它结束）',
    en: 'Close this upstream session (immediate early DELETE, stops time-based billing; waits for an in-flight reply to finish first)',
  },
  'account.clearCooldownTitle': { 'zh-CN': '解除冷却', en: 'Clear cooldown' },
  // 按钮 title（无变量）；弹窗标题用 account.credentialTitle（带 {email}）
  'account.credentialButtonTitle': { 'zh-CN': '查看/复制凭证', en: 'View / copy credentials' },
  'account.deleteTitle': { 'zh-CN': '删除账号', en: 'Delete account' },
  'account.lastUsed': { 'zh-CN': '最近使用', en: 'Recently used' },
  'account.unknownReason': { 'zh-CN': '未知原因', en: 'Unknown reason' },
  'account.probeCountryBlocked': { 'zh-CN': '出口风控', en: 'Egress block' },
  'account.probeCountryBlockedTip': {
    'zh-CN': '国家/出口 IP 风控：{msg}',
    en: 'Country / egress IP risk control: {msg}',
  },
  'account.probeBannedTip': { 'zh-CN': '账号被封禁：{msg}', en: 'Account banned: {msg}' },
  'account.probeIpCapped': { 'zh-CN': 'IP 上限', en: 'IP cap' },
  'account.probeIpCappedTip': { 'zh-CN': 'IP 达上限：{msg}', en: 'IP limit reached: {msg}' },
  'account.probeRateLimited': { 'zh-CN': '限流', en: 'Rate limited' },
  'account.probeRateLimitedTip': { 'zh-CN': '账号限流/额度：{msg}', en: 'Account rate / quota limited: {msg}' },
  'account.probeInvalidCred': { 'zh-CN': '凭证无效', en: 'Invalid credentials' },
  'account.probeInvalidCredTip': {
    'zh-CN': '凭据失效（需重新登录）：{msg}',
    en: 'Credentials expired (sign in again): {msg}',
  },
  'account.probeFailed': { 'zh-CN': '探测失败', en: 'Probe failed' },
  'account.refreshed': { 'zh-CN': '账号状态已刷新', en: 'Account status refreshed' },
  'account.probeOk': { 'zh-CN': '✅ {email} 可用 · {n} 个模型', en: '✅ {email} available · {n} models' },
  'account.probeModelList': { 'zh-CN': '：{list}', en: ': {list}' },
  'account.probeAbnormal': {
    'zh-CN': '⚠️ {email} 检测异常：{label} — {tip}',
    en: '⚠️ {email} check abnormal: {label} — {tip}',
  },
  'account.probeFail': { 'zh-CN': '检测失败: {msg}', en: 'Check failed: {msg}' },
  'account.refreshOk': { 'zh-CN': '✅ {n} 个正常', en: '✅ {n} healthy' },
  'account.refreshBanned': { 'zh-CN': '⛔ {n} 个已封禁', en: '⛔ {n} banned' },
  'account.refreshAbnormal': {
    'zh-CN': '⚠️ {n} 个异常（限流/风控/凭证）',
    en: '⚠️ {n} abnormal (rate limit / risk control / credentials)',
  },
  'account.refreshModels': { 'zh-CN': '模型 {n} 个', en: '{n} models' },
  'account.refreshReadOnly': {
    'zh-CN': '（只读，已购时段不受影响）',
    en: ' (read-only; purchased windows are unaffected)',
  },
  'account.probing': { 'zh-CN': '探测中', en: 'Probing…' },
  'account.probeDoneFail': {
    'zh-CN': '探测完成，{n} 个失败（点击行内检测图标看详情）',
    en: 'Probe finished, {n} failed (click the inline check icon for details)',
  },
  'account.probeDone': { 'zh-CN': '探测完成（只读，不占额度）', en: 'Probe finished (read-only, no quota spent)' },
  'account.pendingLogins': { 'zh-CN': '等待中的登录', en: 'Pending sign-ins' },
  'account.startedAt': { 'zh-CN': '发起于 {time}', en: 'Started at {time}' },
  'account.openLoginLink': { 'zh-CN': '打开登录链接', en: 'Open sign-in link' },
  'account.round': { 'zh-CN': '本轮 {dur}', en: 'this round {dur}' },
  'account.last': { 'zh-CN': '上次 {time}', en: 'last {time}' },
  'account.notScheduled': { 'zh-CN': '未调度', en: 'not scheduled' },
  'account.importedAt': { 'zh-CN': '导入：{at}', en: 'Imported: {at}' },
  'account.neverUpdated': { 'zh-CN': '从未更新', en: 'never updated' },
  'account.credentialUpdatedAt': { 'zh-CN': '凭证更新：{at}', en: 'Credential updated: {at}' },
  'account.totalScheduled': { 'zh-CN': '累计调度：{dur}', en: 'Total scheduled: {dur}' },
  'account.roundSince': { 'zh-CN': '本轮自：{at}', en: 'Current round since: {at}' },
  'account.importedShort': { 'zh-CN': '导入 {at}', en: 'imported {at}' },
  'account.updatedShort': { 'zh-CN': '更新 {at}', en: 'updated {at}' },
  'account.scheduledShort': { 'zh-CN': '调度 {dur}', en: 'scheduled {dur}' },

  // ---- 额度 ----
  'quota.free': { 'zh-CN': '免费', en: 'Free' },
  'quota.dailyPool': { 'zh-CN': '每日池', en: 'Daily pool' },
  'quota.pacificMidnight': { 'zh-CN': '太平洋午夜', en: 'Pacific midnight' },
  'quota.exempt': { 'zh-CN': '服务端配额豁免', en: 'Server-side quota exempt' },
  'quota.noDataTip': {
    'zh-CN': '尚无额度数据：账号首次 admit（发起对话/创建 session）后上游才会返回；可点行内「检测」查看',
    en: 'No quota data yet: upstream only returns it after the account\'s first admit (a chat or session creation); use "Check" in the row to fetch it',
  },
  'quota.priceTip': {
    'zh-CN': '单价 {price} FB/小时（一次 admit 买断一小时，时段内复用不额外计费）',
    en: 'Price {price} FB/hour (one admit buys a full hour; reuse within the window is not charged again)',
  },
  'quota.priceTipBilling': {
    'zh-CN': '单价 {price} FB/小时（按会话实际占用时长结算）',
    en: 'Price {price} FB/hour (billed on actual session occupancy)',
  },
  'quota.noPriceTip': { 'zh-CN': '上游未返回该模型单价（freebucks.prices 无此模型）', en: 'Upstream did not return a price for this model (absent from freebucks.prices)' },
  'quota.noPriceShort': { 'zh-CN': '上游未返回该模型单价', en: 'Upstream did not return a price for this model' },
  'quota.pricePerHour': { 'zh-CN': '{price} FB/h', en: '{price} FB/h' },
  'quota.poolLeftTip': {
    'zh-CN': '今日池余额 {left} FB → ≈ 可用 {dur}',
    en: 'Remaining today {left} FB → ≈ {dur} available',
  },
  'quota.requestQuotaTip': {
    'zh-CN': '上游另有请求额度 {used}/{limit}（{pool}）',
    en: 'Upstream request quota {used}/{limit} ({pool})',
  },
  'quota.resetLine': { 'zh-CN': '重置 {at} · {in}', en: 'Resets {at} · {in}' },
  'quota.poolEmpty': { 'zh-CN': ' · 池空', en: ' · pool empty' },
  'quota.resetSoon': { 'zh-CN': '即将重置', en: 'resetting now' },
  'quota.resetLocalWithUpstream': { 'zh-CN': '{local}（上游 {upstream}）', en: '{local} (upstream {upstream})' },
  'quota.balanceAmount': { 'zh-CN': '余额 {amount} Freebucks', en: 'Balance {amount} Freebucks' },
  'quota.availablePrice': {
    'zh-CN': '≈ 可用 {dur}（{model} 单价 {price}/h）',
    en: '≈ {dur} available ({model} at {price}/h)',
  },
  'quota.dailyPoolLeft': {
    'zh-CN': '每日池 剩余 {left}/{limit} Freebucks',
    en: 'Daily pool {left}/{limit} Freebucks left',
  },
  'quota.approx': { 'zh-CN': ' ≈ {dur}', en: ' ≈ {dur}' },
  'quota.resetAtParen': { 'zh-CN': '（重置 {at}）', en: '(resets {at})' },
  'quota.billingExpiresAt': {
    'zh-CN': '计费方式：一次 admit = 买断一小时（整小时单价当场预扣，回执带 expiresAt）',
    en: 'Billing: one admit buys a full hour (the full hourly price is charged upfront; the receipt carries expiresAt)',
  },
  'quota.reusableNotCredited': {
    'zh-CN': '付费时段内可无限复用，边际成本 0；早退 DELETE 只回 pending，实测未到账',
    en: 'Unlimited reuse inside the paid window at marginal cost 0; an early DELETE only returns pending, which in testing never arrived',
  },
  'quota.walletAmount': { 'zh-CN': '钱包 {amount}', en: 'Wallet {amount}' },
  'quota.lastRefund': {
    'zh-CN': '上次早退回执：Freebucks 退回 {refund}（期望 {expected}）',
    en: 'Last early-release receipt: {refund} Freebucks refunded (expected {expected})',
  },
  'quota.balanceShort': { 'zh-CN': '{amount} FB', en: '{amount} FB' },
  'quota.priceShort': { 'zh-CN': ' · {price}/h', en: ' · {price}/h' },
  'quota.approxShort': { 'zh-CN': ' · ≈{dur}', en: ' · ≈{dur}' },
  'quota.todayLeftShort': {
    'zh-CN': '今日剩余 {left}/{limit} FB',
    en: '{left}/{limit} FB left today',
  },
  'quota.approxParen': { 'zh-CN': '（≈{dur}）', en: '(≈{dur})' },

  // ---- 模型 ----
  'model.syncUpstream': { 'zh-CN': '同步上游模型', en: 'Sync from upstream' },
  'model.syncHint': {
    'zh-CN': '内置目录 + 上游实时 + 自定义覆盖。上游新模型不用等发版——点「同步上游模型」自动拉取并更新 agent，或手动添加。',
    en: 'Built-in catalog + live upstream + custom overrides. New upstream models need no release — click "Sync from upstream" or add manually.',
  },
  'model.syncDone': { 'zh-CN': '已同步上游（自定义 {n} 条，内置按 catalog 为准）', en: 'Synced ({n} custom entries; built-ins follow the catalog)' },
  'model.syncFail': { 'zh-CN': '同步失败: {msg}', en: 'Sync failed: {msg}' },
  'model.fetchFail': { 'zh-CN': '拉取上游失败: {msg}', en: 'Failed to fetch upstream: {msg}' },
  'model.noneUpstream': { 'zh-CN': '上游暂无可用模型', en: 'No models available upstream' },
  'model.hideConfirm': {
    'zh-CN': '确定隐藏模型 {id}？\n（内置模型隐藏后可恢复；重新同步上游会按最新列表拉回）',
    en: 'Hide model {id}?\n(A hidden built-in can be restored; syncing pulls the latest list back)',
  },
  'model.pool': { 'zh-CN': '池', en: 'Pool' },
  'model.available': { 'zh-CN': '可用', en: 'Available' },
  'model.management': { 'zh-CN': '模型管理', en: 'Models' },
  'model.id': { 'zh-CN': '模型 id', en: 'Model id' },
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

  // ---- 代理 ----
  'proxy.cardTitle': { 'zh-CN': '代理设置（全局代理池）', en: 'Proxy settings (global pool)' },
  'proxy.cardHint': {
    'zh-CN': '填一个或多个代理，保存立即生效；账号出口由系统内部分配（同一账号固定同一出口），无需逐个配置',
    en: 'Add one or more proxies — changes take effect on save. Egress is assigned internally per account (one account keeps one exit), so no per-account setup is needed.',
  },
  'proxy.poolPlaceholder': {
    'zh-CN': '一行一个代理，例如：\nhttp://user:pass@172.17.0.1:7890\nsocks5://127.0.0.1:1080\n（留空保存 = 清除全局池，走环境变量/直连）',
    en: 'One proxy per line, e.g.:\nhttp://user:pass@172.17.0.1:7890\nsocks5://127.0.0.1:1080\n(Saving empty clears the global pool — env vars / direct connection are used instead)',
  },
  'proxy.testPlaceholder': { 'zh-CN': '测试单个代理，如 http://172.17.0.1:2334', en: 'Test a single proxy, e.g. http://172.17.0.1:2334' },
  'proxy.testConfigured': { 'zh-CN': '测试已配置', en: 'Test configured' },
  'proxy.effectiveList': { 'zh-CN': '当前生效代理：{list}', en: 'Currently effective proxies: {list}' },
  'proxy.effectivePrefix': { 'zh-CN': '当前生效代理', en: 'Currently effective proxies' },
  'proxy.testing': { 'zh-CN': '测试中…（最多 ~12s/个）', en: 'Testing… (up to ~12s each)' },
  'proxy.notConfiguredDirect': { 'zh-CN': '当前未配置代理（直连）', en: 'No proxy configured (direct)' },
  'proxy.usable': { 'zh-CN': '可用', en: 'Usable' },
  'proxy.unusable': { 'zh-CN': '不可用', en: 'Unusable' },
  'proxy.egressIp': { 'zh-CN': '出口 IP: {ip}', en: 'Egress IP: {ip}' },
  'proxy.latencyMs': { 'zh-CN': ' · 延迟 {ms}ms', en: ' · latency {ms}ms' },
  'proxy.upstreamStatus': { 'zh-CN': ' · 上游状态 {status}', en: ' · upstream status {status}' },
  'proxy.testFailedRow': { 'zh-CN': '失败: {msg}（{ms}ms）', en: 'Failed: {msg} ({ms}ms)' },
  'proxy.countryParen': { 'zh-CN': '（{country}）', en: '({country})' },
  'proxy.connectFailed': { 'zh-CN': '连接失败', en: 'Connection failed' },
  'proxy.testFailed': { 'zh-CN': '测试失败: {msg}', en: 'Proxy test failed: {msg}' },

  // ---- 系统设置 ----
  'system.freeQuotaPolicy': { 'zh-CN': '免费额度策略', en: 'Free quota policy' },
  'system.toolSignatureHint': {
    'zh-CN': '工具签名兼容（补齐官方真签名工具，避免被上游判作第三方客户端而降级）',
    en: 'Tool signature compatibility (fills in upstream’s real signed tools, so requests are not downgraded as third-party clients)',
  },
  'system.toolSignatureOn': {
    'zh-CN': '工具签名兼容已开启（转发时会补齐官方签名工具）',
    en: 'Tool signature compatibility enabled (upstream signed tools are filled in on forward)',
  },
  'system.toolSignatureOff': {
    'zh-CN': '工具签名兼容已关闭（带工具的请求可能被判第三方并降级）',
    en: 'Tool signature compatibility disabled (tool-bearing requests may be treated as third-party and downgraded)',
  },
  'system.toolFallback': { 'zh-CN': '工具请求兜底', en: 'Tool request fallback' },
  'system.toolFallbackHint': {
    'zh-CN': '工具被拒时去掉工具重试（上游对 tools 做指纹比对，带工具会被回 404 No endpoints found；开着才能出文本回答，关掉则错误原样透传）',
    en: 'Retry without tools when tools are rejected (upstream fingerprints tools and answers 404 No endpoints found; keep this on to still get a text answer, off passes the error through as-is)',
  },
  'system.toolFallbackOn': { 'zh-CN': '工具兜底重试已开启', en: 'Tool fallback retry enabled' },
  'system.toolFallbackOff': { 'zh-CN': '工具兜底重试已关闭', en: 'Tool fallback retry disabled' },
  'system.blockPremiumOn': { 'zh-CN': '已屏蔽收费模型（列表与调度已排除）', en: 'Paid models blocked (excluded from the list and from scheduling)' },
  'system.blockPremiumOff': { 'zh-CN': '已显示收费模型', en: 'Paid models shown again' },
  'system.scheduling': { 'zh-CN': '账号调度', en: 'Account scheduling' },
  'system.schedulingHint': {
    'zh-CN': '粘性优先 = 请求集中到尽可能少的账号（换号 = 新买一条 Freebucks 计费行，能复用就复用）；并发优先 = 账号满员就换号，不再让请求在一个号上干等。两种模式都优先复用同模型热 session、都让从未用过的账号排最后。',
    en: 'Sticky-first: concentrate requests on as few accounts as possible (switching accounts buys a new Freebucks billing line, so reuse whenever you can). Spread-first: move on as soon as an account is full instead of queuing on it. Both modes still reuse a warm session for the same model first, and both rank never-used accounts last.',
  },
  'system.schedulingMode': { 'zh-CN': '调度模式', en: 'Scheduling mode' },
  'system.modeSticky': { 'zh-CN': '粘性优先（最少换号，默认）', en: 'Sticky-first (fewest switches, default)' },
  'system.modeSpread': { 'zh-CN': '并发优先（满员即换号）', en: 'Spread-first (switch when full)' },
  'system.accountConcurrency': { 'zh-CN': '每账号并发（单账号同时几路流）', en: 'Per-account concurrency (streams at once)' },
  'system.overflowWait': { 'zh-CN': '溢出排队上限（毫秒，仅并发优先）', en: 'Overflow queue limit (ms, spread-first only)' },
  'system.adminOnly': { 'zh-CN': '（管理员可调）', en: '(admin only)' },
  'system.quotaProtection': { 'zh-CN': '额度保护（买断一小时，用满它）', en: 'Quota protection (one admit buys an hour — use it fully)' },
  'system.twoLedgers': {
    'zh-CN': '上游 2026-09 改版：一笔会话**同时**扣两本账——session_units（时长额度，recentCount/limit，小数）与 Freebucks（单价 N FB/小时，按整小时预扣）。两者是**并行的两道闸门**，任一不足都会被上游拒掉。',
    en: 'Upstream reworked billing in 2026-09: one session is charged against **two ledgers at once** — session_units (time quota, recentCount/limit, fractional) and Freebucks (N FB per hour, pre-charged for the whole hour). They are **two parallel gates**: running short on either one gets the request rejected.',
  },
  'system.admitBuysHour': { 'zh-CN': '一次 admit = 买断一小时', en: 'One admit buys a full hour' },
  'system.admitBody1': {
    'zh-CN': '：POST 当场扣满整小时单价（实测 Freebucks 5 → 0，回执带 expiresAt）。所以这一小时内继续发请求的',
    en: ': the POST charges the full hourly price upfront (measured: Freebucks 5 → 0, with expiresAt on the receipt). So within that hour, sending more requests has a',
  },
  'system.admitMarginalZero': { 'zh-CN': '边际成本是 0', en: 'marginal cost of 0' },
  'system.admitBody2': {
    'zh-CN': '，而 DELETE 之后那一小时就作废、重开 = 重新买一整小时。',
    en: '; after a DELETE the hour is forfeited and reopening buys another full hour.',
  },
  'system.admitNoIdleRelease': { 'zh-CN': '因此付费时段内不再因空闲释放', en: 'So idle time never triggers a release inside the paid window' },
  'system.admitBody3': {
    'zh-CN': '——只有必须腾槽位给别的模型时才早退。空闲自动释放改成「付费时段结束之后」的时长。',
    en: ' — an early release only happens when a slot must be freed for another model. Idle auto-release now measures the time **after** the paid window ends.',
  },
  'system.refundAsymmetric': {
    'zh-CN': '早退 DELETE 的退款**两本账不对称**（一手实测）：',
    en: 'Refunds on an early DELETE are **asymmetric across the two ledgers** (first-hand measurements):',
  },
  'system.refundUnits': { 'zh-CN': 'session_units 当场按实际占用比例退还', en: 'session_units are refunded on the spot, pro-rated to actual usage' },
  'system.refundUnitsBody': {
    'zh-CN': '（实测 1.1 → 0.2，小数、无取整）；',
    en: ' (measured 1.1 → 0.2, fractional, no rounding);',
  },
  'system.refundFreebucks': { 'zh-CN': 'Freebucks 只回 freebucksRefundPending', en: 'Freebucks only returns freebucksRefundPending' },
  'system.refundFreebucksBody': {
    'zh-CN': '，实测 25s 后早退、重放 DELETE ×2、观察 2 分钟**仍未到账**。而实测 24 个「账号 × 模型」组合里',
    en: ', and after releasing 25s in, replaying DELETE twice and watching for 2 minutes it still **never landed**. Across the 24 measured "account × model" combinations,',
  },
  'system.refundFreebucksFirst': { 'zh-CN': '22 个是 Freebucks 先见底', en: '22 ran out of Freebucks first' },
  'system.refundConclusion': {
    'zh-CN': '，所以早退等于拿稀缺的账去省不稀缺的账。',
    en: ', so an early exit trades a scarce ledger for a plentiful one.',
  },
  'system.refundSources': {
    'zh-CN': '依据：docs/freebucks-strategy.html、docs/account-scheduling-and-refund.md §3（2026-09-14 结论）、docs/evidence/ledger-session-units-vs-freebucks.json',
    en: 'Sources: docs/freebucks-strategy.html, docs/account-scheduling-and-refund.md §3 (2026-09-14 findings), docs/evidence/ledger-session-units-vs-freebucks.json',
  },
  'system.idleRelease': { 'zh-CN': '空闲自动释放（秒，0 = 关闭；最小 5）', en: 'Idle auto-release (sec, 0 = off; min 5)' },
  'system.lowBalanceThreshold': { 'zh-CN': '低额度分组阈值（FB，0 = 关闭）', en: 'Low-balance group threshold (FB, 0 = off)' },
  'system.maxNewSessions': { 'zh-CN': '单请求新会话上限（个）', en: 'New sessions per request (max)' },
  'system.idleReleaseHintOn': {
    'zh-CN': '当前：会话空闲 {sec}s 后释放（付费时段内不释放，买断的一小时用满）· 一个请求最多新建 {max} 个上游会话',
    en: 'Current: a session is released after {sec}s idle (never inside the paid window — the purchased hour is used in full) · at most {max} new upstream sessions per request',
  },
  'system.idleReleaseHintOff': {
    'zh-CN': '当前：空闲不释放（会话留到自然过期，最省 admit；代价是换模型要等释放）· 一个请求最多新建 {max} 个上游会话',
    en: 'Current: no idle release (sessions live until they expire — fewest admits, but switching models means waiting for a release) · at most {max} new upstream sessions per request',
  },
  'system.adviceTitle': { 'zh-CN': '推荐值（按当前账号池实时算）', en: 'Recommended (computed live from the current pool)' },
  'system.adviceApply': { 'zh-CN': '采用推荐值 {sec}s', en: 'Apply recommended {sec}s' },
  'system.adviceInSync': { 'zh-CN': '✅ 当前设置已与推荐值一致', en: '✅ Current setting already matches the recommendation' },
  'system.adviceAdminHint': { 'zh-CN': '（管理员可一键采用）', en: '(an admin can apply it in one click)' },
  'system.adviceNoAccounts': {
    'zh-CN': '还没有账号，先给默认值 1 分钟。导入账号后这里会按真实模型分布重新计算。',
    en: 'No accounts yet — defaulting to 1 minute. It is recomputed from the real model distribution once you import accounts.',
  },
  'system.adviceNoSessions': {
    'zh-CN': '当前 {pool} 个账号都没有活跃会话，无从判断模型分布，先用默认值 1 分钟。有会话后会自动重算。',
    en: 'None of the {pool} accounts has an active session, so the model distribution is unknown — using the 1 minute default. It recalculates once sessions appear.',
  },
  'system.adviceTight': {
    'zh-CN': '{pool} 个账号上正在跑 {distinct} 种不同模型（模型数已接近账号数），会话槽位很紧：保持 1 分钟，让换模型时能尽快拿到槽位；同时早退会把未用时长退回来。',
    en: '{pool} accounts are running {distinct} different models (model count is close to account count), so session slots are tight: keep 1 minute so a model switch gets a slot quickly; an early release also refunds the unused time.',
  },
  'system.adviceRelaxed': {
    'zh-CN': '{pool} 个账号上只跑 {distinct} 种模型（模型集中在少数账号，热会话复用充分），可以放宽到 5 分钟：减少 admit 往返，又不会让空闲会话挂太久白计费。',
    en: 'Only {distinct} models run across {pool} accounts (models concentrate on a few accounts and hot sessions are reused well), so 5 minutes is safe: fewer admit round-trips without idling a session long enough to waste the paid hour.',
  },
  'system.adviceBalanced': {
    'zh-CN': '{pool} 个账号上正在跑 {distinct} 种模型，分布适中，2 分钟是兼顾「少 admit 往返」和「不为空闲时长付费」的平衡点。',
    en: '{distinct} models run across {pool} accounts — a balanced spread, so 2 minutes balances "fewer admit round-trips" against "not paying for idle time".',
  },
  'system.adviceApplied': {
    'zh-CN': '已采用推荐值：空闲 {sec}s 后释放 · 单请求最多 {max} 个新会话',
    en: 'Recommendation applied: release after {sec}s idle · at most {max} new sessions per request',
  },
  'system.schedCap': { 'zh-CN': '每账号 {n} 路并发', en: '{n} concurrent streams per account' },
  'system.schedSpread': {
    'zh-CN': '当前：并发优先 · {cap}。账号满员就立刻换到下一个有空闲槽位的账号（最多先等 {wait} ms），不会再出现"设了并发 2 却只开 1 个号"。已用过的账号仍优先于从未用过的账号。',
    en: 'Current: spread-first · {cap}. A full account switches immediately to the next one with a free slot (waiting at most {wait} ms), so "concurrency 2 but only 1 account opens" no longer happens. Previously used accounts still outrank never-used ones.',
  },
  'system.schedSticky': {
    'zh-CN': '当前：粘性优先 · {cap}。并发请求先挤同一账号（超过上限就在该账号排队，超时才溢出到下一个），最少换号 = 最少新建计费会话。想让并发铺开多个账号，把模式改成「并发优先」。',
    en: 'Current: sticky-first · {cap}. Concurrent requests pack onto one account (beyond the cap they queue there, overflowing only on timeout) — fewest switches means fewest billable sessions. To spread concurrency across accounts, switch the mode to "spread-first".',
  },
  'system.schedSavedSpread': { 'zh-CN': '调度已更新：并发优先 · 每账号 {n} 路（满员即换号）', en: 'Scheduling updated: spread-first · {n} streams per account (switches when full)' },
  'system.schedSavedSticky': { 'zh-CN': '调度已更新：粘性优先 · 每账号 {n} 路（先排队，超时才换号）', en: 'Scheduling updated: sticky-first · {n} streams per account (queue first, switch on timeout)' },
  'system.quotaSavedOn': {
    'zh-CN': '额度保护已更新：空闲 {sec}s 后释放（付费时段内不释放）· 单请求最多 {max} 个新会话',
    en: 'Quota protection updated: release after {sec}s idle (never inside the paid window) · at most {max} new sessions per request',
  },
  'system.quotaSavedOff': {
    'zh-CN': '已关闭空闲释放（会话留到自然过期）· 单请求最多 {max} 个新会话',
    en: 'Idle release disabled (sessions live until they expire) · at most {max} new sessions per request',
  },

  // ---- 提示 ----
  'toast.saved': { 'zh-CN': '已保存', en: 'Saved' },
  'toast.copyFailSelect': { 'zh-CN': '复制失败，请手动选中文本', en: 'Copy failed — please select the text manually' },
  'toast.copyFailSelectShort': { 'zh-CN': '复制失败，请手动选中', en: 'Copy failed — select manually' },
  'toast.commandCopied': { 'zh-CN': '已复制处置命令', en: 'Command copied' },

  // ---- 总览 ----
  'overview.poolTitle': { 'zh-CN': '账号池（{n}）', en: 'Account pool ({n})' },
  'overview.poolSubtitle': { 'zh-CN': '上游 {apiBase} · 模型 {models} · 数据目录 {dataDir}', en: 'Upstream {apiBase} · models {models} · data dir {dataDir}' },
  'overview.oneClickRefresh': { 'zh-CN': '一键刷新', en: 'Refresh all' },
  'overview.probeRefresh': { 'zh-CN': '探测刷新', en: 'Re-probe' },
  'overview.probeOnlyTip': { 'zh-CN': '只重新探测账号（不刷新模型目录）', en: 'Re-probe accounts only (does not refresh the model catalog)' },
  'overview.probeReadOnlyTip': { 'zh-CN': '只重新探测账号（只读，不占额度）', en: 'Re-probe accounts only (read-only, consumes no quota)' },
  'overview.addAccount': { 'zh-CN': '添加账号', en: 'Add account' },
  'overview.addFirstAccount': { 'zh-CN': '立即添加第一个账号', en: 'Add your first account' },
  'overview.askAdminForAccount': { 'zh-CN': '请联系管理员添加账号。', en: 'Ask an administrator to add accounts.' },
  'overview.statTotal': { 'zh-CN': '账号总数', en: 'Total accounts' },
  'overview.statAvailable': { 'zh-CN': '可用账号', en: 'Available' },
  'overview.statBanned': { 'zh-CN': '已封禁', en: 'Banned' },
  'overview.statBannedTip': {
    'zh-CN': '上游封禁 = 不可恢复，只能换号或等平台解封。与"冷却中"（限流/额度，到期自愈）区分开。',
    en: 'Banned upstream is not self-healing: swap the account or wait for the platform. Distinct from "cooling down" (rate limit/quota, recovers automatically).',
  },
  'overview.statCooling': { 'zh-CN': '冷却中', en: 'Cooling down' },
  'overview.statCoolingTip': {
    'zh-CN': '暂时被上游拒付/限流（rate_limited / spend_limited / ip_capped / 风控）。冷却到期自动恢复；刷新不会动会话句柄，已购时段不受影响。',
    en: 'Temporarily refused or rate limited upstream (rate_limited / spend_limited / ip_capped / risk control). Clears automatically when the cooldown ends; refreshing does not touch session handles, so paid windows are unaffected.',
  },
  'overview.statInFlight': { 'zh-CN': '在途请求', en: 'In-flight' },
  'overview.statInFlightQueued': { 'zh-CN': '在途请求（排队 {n}）', en: 'In-flight ({n} queued)' },
  'overview.statReuseRate': { 'zh-CN': '会话复用率', en: 'Session reuse rate' },
  'overview.statReuseTip': {
    'zh-CN': '买过 {admits} 条会话，复用 {reuses} 次。\n一次 admit = 买断一小时，复用发生在这小时内 → 边际成本 0。\n复用率 = 省掉的重买比例。',
    en: 'Bought {admits} sessions, reused {reuses} times.\nOne admit buys a full hour; reuse inside that hour costs nothing extra.\nReuse rate = the share of re-buys you avoided.',
  },
  'overview.statReuseEmpty': {
    'zh-CN': '还没有请求记录：有请求后这里会显示复用（省钱）比例。',
    en: 'No requests yet — once there are, this shows the reuse (cost-saving) rate.',
  },
  'overview.loadBalance': { 'zh-CN': '负载均衡 · 共 {n} 次选号 · 热 session 优先复用', en: 'Load balanced · {n} picks · hot sessions reused first' },
  'overview.noRequestsYet': { 'zh-CN': '尚无请求记录', en: 'No requests recorded yet' },
  'overview.shareBarTip': { 'zh-CN': '{email} {pct}%（{req}/{total}）', en: '{email} {pct}% ({req}/{total})' },

  // ---- 系统（数据文件自检 / 服务操作）----
  'system.reconnectConfirm': {
    'zh-CN': '确定要全部断开重连吗？\n\n将释放所有账号的 session（正在传输的 SSE 可能被中断），下一个请求会自动重建新 session。',
    en: 'Reconnect everything?\n\nThis releases every account session (in-flight SSE streams may be cut) and the next request rebuilds a fresh session.',
  },
  'system.reconnectDone': { 'zh-CN': '已全部断开重连，下个请求自动重建', en: 'Reconnected all; the next request rebuilds automatically' },
  'system.reconnectPartial': { 'zh-CN': '已断开重连，{n} 个账号失败', en: 'Reconnected, {n} accounts failed' },
  'system.restartConfirm': {
    'zh-CN': '确定要重启服务吗？\n\n重启会中断当前所有连接约几秒，期间请勿发送新请求。',
    en: 'Restart the service?\n\nAll current connections drop for a few seconds; do not send new requests during the restart.',
  },
  'system.restarting': { 'zh-CN': '正在重启服务…', en: 'Restarting service…' },
  'system.restartDone': { 'zh-CN': '服务已重启完成', en: 'Service restarted' },
  'system.restartTimeout': { 'zh-CN': '等待重启超时，请刷新页面确认服务状态', en: 'Timed out waiting for the restart — reload the page to confirm service status' },
  'system.dataSelfCheck': { 'zh-CN': '数据文件自检', en: 'Data file self-check' },
  'system.dataDirSummary': { 'zh-CN': '{dir} · 共 {n} 个 JSON（{summary}）', en: '{dir} · {n} JSON files ({summary})' },
  'system.filesBroken': { 'zh-CN': '{n} 个损坏', en: '{n} corrupt' },
  'system.filesDirty': { 'zh-CN': '{n} 个含非法条目（已自动丢弃）', en: '{n} with invalid entries (auto-dropped)' },
  'system.filesPending': { 'zh-CN': '{n} 条上游会话待结算', en: '{n} upstream sessions pending settlement' },
  'system.invalidHint': {
    'zh-CN': '⚠ 损坏的文件会让对应功能降级（配置回落默认值 / 账号履历丢失 / 会话退款索引丢失）。停服后把文件移走再启动即可自动重建；下面的命令可直接照做。',
    en: '⚠ Corrupt files degrade the matching feature (config falls back to defaults / account history lost / session refund index lost). Stop the service, move the file away, start again — it rebuilds automatically. The commands below are ready to copy.',
  },
  'system.dirtyHint': {
    'zh-CN': '⚠ 有文件里混进了结构非法的记录（null / 缺关键字段）。这类文件**本身没坏**，新版本会逐条丢弃并留证，不影响启动——但请核对丢掉的原文，必要时从备份恢复。',
    en: '⚠ Some files contain structurally invalid records (null / missing key fields). The files themselves are fine: the current version drops those entries one by one, keeps evidence, and still starts — but review what was dropped and restore from backup if needed.',
  },
  'system.statusBroken': { 'zh-CN': '损坏', en: 'Corrupt' },
  'system.statusMissing': { 'zh-CN': '尚未生成', en: 'Not created yet' },
  'system.statusDirtyCount': { 'zh-CN': '脏条目 ×{n}', en: 'Bad entries ×{n}' },
  'system.statusPendingCount': { 'zh-CN': '待结算 ×{n}', en: 'Pending ×{n}' },
  'system.descDirty': { 'zh-CN': '含非法条目', en: 'Contains invalid entries' },
  'system.descBackup': { 'zh-CN': '；原文: {name}', en: '; original: {name}' },
  'system.descPendingHandles': {
    'zh-CN': '{n} 条上游会话句柄尚未结算（每条都占着对应账号的会话槽位；启动扫尾 / 释放流程会继续 DELETE，不是故障、无需手工删文件）',
    en: '{n} upstream session handles not settled yet (each holds a session slot on its account; startup cleanup and the release flow keep DELETE-ing them — not a fault, no manual file deletion needed)',
  },
  'system.descAutoCreate': { 'zh-CN': '首次启动会自动创建', en: 'Created automatically on first start' },
  'system.actionBackupThenMove': { 'zh-CN': '先备份再移走（真源文件，删了就找不回）', en: 'Back it up before moving (source of truth — deleting it is unrecoverable)' },
  'system.actionNoneNeeded': { 'zh-CN': '无需处置（已自动丢弃）', en: 'No action needed (already dropped)' },
  'system.colFile': { 'zh-CN': '文件', en: 'File' },
  'system.colDesc': { 'zh-CN': '说明', en: 'Details' },
  'system.colAction': { 'zh-CN': '处置', en: 'Action' },
  'system.copyCommand': { 'zh-CN': '复制这条命令', en: 'Copy this command' },

  // ---- 日志 ----
  'logs.copyJson': { 'zh-CN': '复制 JSON', en: 'Copy JSON' },
  'logs.empty': {
    'zh-CN': '没有匹配的日志。缓冲只保留最近若干条（进程内，重启即清空）。',
    en: 'No matching log entries. The buffer keeps only a bounded tail (in-process; cleared on restart).',
  },
  'logs.meta': { 'zh-CN': '{n} 条 · 服务端时间 {time}', en: '{n} entries · server time {time}' },
  'logs.inProcessTitle': { 'zh-CN': '进程内日志', en: 'In-process logs' },
  'logs.auto': { 'zh-CN': '自动刷新', en: 'Auto-refresh' },
  'logs.stopAuto': { 'zh-CN': '停止自动刷新', en: 'Stop auto-refresh' },
  'logs.levelAll': { 'zh-CN': '全部级别', en: 'All levels' },
  'logs.levelInfo': { 'zh-CN': 'info 及以上', en: 'info and above' },
  'logs.levelWarn': { 'zh-CN': 'warn 及以上', en: 'warn and above' },
  'logs.levelError': { 'zh-CN': '仅 error', en: 'error only' },
  'logs.searchPlaceholder': {
    'zh-CN': '搜索（命中完整字段，如 country / banned / 503 / 邮箱）',
    en: 'Search (matches full fields, e.g. country / banned / 503 / email)',
  },
  'logs.clearFilters': { 'zh-CN': '清除筛选', en: 'Clear filters' },
  'logs.expandHint': {
    'zh-CN': '点任意一行展开完整字段（含上游原始判据），可一键复制。缓冲为进程内有界环形队列，重启即清空。',
    en: 'Click any row to expand the full fields (including raw upstream verdicts) and copy them in one click. The buffer is a bounded in-process ring, cleared on restart.',
  },

  // ---- 时长单位 ----
  'dur.seconds': { 'zh-CN': '{n} 秒', en: '{n}s' },
  'dur.minutes': { 'zh-CN': '{n} 分钟', en: '{n}m' },
  'dur.hoursMinutes': { 'zh-CN': '{h} 小时 {m} 分', en: '{h}h {m}m' },
  'dur.hours': { 'zh-CN': '{h} 小时', en: '{h}h' },
  'dur.minutesSeconds': { 'zh-CN': '{m} 分 {s} 秒', en: '{m}m {s}s' },
  'dur.hoursMinutesShort': { 'zh-CN': '{h} 时 {m} 分', en: '{h}h {m}m' },
  'dur.daysHoursAfter': { 'zh-CN': '{d} 天 {h} 小时后', en: 'in {d}d {h}h' },
  'dur.hoursMinutesAfter': { 'zh-CN': '{h} 小时 {m} 分后', en: 'in {h}h {m}m' },

  // ---- 用户管理 ----
  'user.management': { 'zh-CN': '用户管理', en: 'Users' },
  'user.softRefresh': { 'zh-CN': '局部刷新', en: 'Refresh in place' },
  'user.info': { 'zh-CN': '我的信息', en: 'My profile' },
  'user.username': { 'zh-CN': '用户名', en: 'Username' },
  'user.selfBadge': { 'zh-CN': '(我)', en: '(me)' },
  'user.role': { 'zh-CN': '角色', en: 'Role' },
  'user.roleAdmin': { 'zh-CN': '管理员', en: 'Admin' },
  'user.roleUser': { 'zh-CN': '普通用户', en: 'Regular user' },
  'user.apiKey': { 'zh-CN': 'API Key', en: 'API Key' },
  'user.apiKeyBearer': { 'zh-CN': 'API Key（下游 Bearer token）', en: 'API Key (downstream Bearer token)' },
  'user.copyFullKey': { 'zh-CN': '复制完整 Key', en: 'Copy full key' },
  'user.keyCopied': { 'zh-CN': '已复制完整 Key', en: 'Full key copied' },
  'user.resetKeyConfirm': { 'zh-CN': '重置 {name} 的 API Key？旧 Key 立即失效', en: 'Reset the API Key of {name}? The old key stops working immediately' },
  'user.newKey': { 'zh-CN': '新 Key: {key}', en: 'New key: {key}' },
  'user.changePassword': { 'zh-CN': '改密', en: 'Change password' },
  'user.changePasswordTitle': { 'zh-CN': '修改 {name} 的密码', en: 'Change the password of {name}' },
  'user.newPassword': { 'zh-CN': '新密码', en: 'New password' },
  'user.passwordUpdated': { 'zh-CN': '密码已更新', en: 'Password updated' },
  'user.deleteConfirm': { 'zh-CN': '删除用户 {name}？', en: 'Delete user {name}?' },
  'user.newUser': { 'zh-CN': '新建用户', en: 'New user' },
  'user.initialPassword': { 'zh-CN': '初始密码', en: 'Initial password' },
  'user.passwordPlaceholder': { 'zh-CN': '≥6 位', en: '≥6 characters' },
  'user.created': { 'zh-CN': '已创建 {name}，API Key: {key}', en: 'Created {name}; API Key: {key}' },
  'user.create': { 'zh-CN': '创建用户', en: 'Create user' },
  'user.scheduling': { 'zh-CN': '会话调度', en: 'Session scheduling' },
  'user.schedulingValue': {
    'zh-CN': '热会话优先：同模型请求复用现有会话，故障时自动切换账号',
    en: 'Hot session first: requests for the same model reuse the live session, and failover switches accounts automatically',
  },
  'user.downstreamHint': {
    'zh-CN': '下游 Agent 接入：把上面 API Key 作为 Bearer token，base_url 指向本服务，例如',
    en: 'Downstream agents: use the API Key above as a Bearer token and point base_url at this service, e.g.',
  },

  // ---- 测试对话 ----
  'playground.title': { 'zh-CN': '测试对话', en: 'Playground' },
  'playground.subtitle': { 'zh-CN': '经 /v1/chat/completions 真实转发（流式）', en: 'Real streaming proxy through /v1/chat/completions' },
  'playground.modelSelect': { 'zh-CN': '模型（{n} 个可选{extra}）', en: 'Model ({n} available{extra})' },
  'playground.modelQuotaSuffix': { 'zh-CN': ' · 上游当前给额度 {n} 个', en: ' · {n} currently granted quota upstream' },
  'playground.reloadModels': { 'zh-CN': '刷新模型列表', en: 'Reload model list' },
  'playground.checkMark': { 'zh-CN': '✅ = 上游此刻给了该模型额度', en: '✅ = upstream is granting quota for this model right now' },
  'playground.catalogEmpty': { 'zh-CN': '上游目录为空：请确认账号已导入并完成一次探测', en: 'Upstream catalog is empty: import an account and run a probe first' },
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

/** 当前语种（模块级缓存，避免每次读 localStorage）。 */
let current = DEFAULT_LOCALE

function normalize(locale) {
  if (typeof locale !== 'string') return null
  const lower = locale.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en'
  return null
}

/** 初始化语种：localStorage > 浏览器语言 > 默认。 */
export function initLocale() {
  let saved = null
  try {
    saved = localStorage.getItem(STORAGE_KEY)
  } catch {
    // 隐私模式下 localStorage 可能不可用
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : null
  current = normalize(saved) || normalize(nav) || DEFAULT_LOCALE
  return current
}

/** 返回当前语种。 */
export function getLocale() {
  return current
}

/** 切换语种并持久化；返回新语种。 */
export function setLocale(locale) {
  const next = normalize(locale) || DEFAULT_LOCALE
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 存不下也要能切（本次会话内有效）
  }
  return next
}

/**
 * 取文案。支持 {name} 占位符替换。
 * 缺 key 时返回 key 本身 —— 界面上会露出一个可读的 key，
 * 而不是空白（红线脚本会在 CI 里拦下真正缺失的 key）。
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 */
export function t(key, vars) {
  const entry = DICT[key]
  if (!entry) return key
  let text = entry[current] ?? entry[DEFAULT_LOCALE] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(String(v))
    }
  }
  return text
}

/** 暴露字典给红线脚本（CI 校验各语种 key 一致性）。 */
export function dictKeys() {
  return Object.keys(DICT)
}

export function localeKeys(locale) {
  return Object.keys(DICT).filter((k) => typeof DICT[k]?.[locale] === 'string')
}
