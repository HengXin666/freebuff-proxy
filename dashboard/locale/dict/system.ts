/**
 * system 域的词条表 -- 从 dashboard/i18n.js 的 DICT 按域切出.
 *
 *
 * 口径: 纯切分, key 与文案逐字节不变.
 */
export default {
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
  'system.upstreamChannel': { 'zh-CN': '上游请求链路', en: 'Upstream request channel' },
  'system.upstreamChannelHint': {
    'zh-CN': '照抄官方客户端抓包（官方工具集 + 官方 system + desktop 世代 agent）；切换后立即生效',
    en: 'Mirror the official client capture (official toolset + system + desktop-generation agent); takes effect immediately',
  },
  'system.upstreamChannelLegacy': {
    'zh-CN': 'legacy（已废弃，不可选）',
    en: 'legacy (deprecated, unavailable)',
  },
  'system.upstreamChannelOfficial': {
    'zh-CN': 'official（官方抓包照抄，2026-10-03 实测 200 + 工具调用）',
    en: 'official (mirrors the capture; verified 200 + tool call on 2026-10-03)',
  },
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
    'zh-CN': '仅在明确接受无工具回答时开启：上游拒绝工具请求后会去掉 tools 重试；关闭时保留上游错误和工具请求语义。',
    en: 'Enable only when a text-only answer is acceptable: retries without tools after an upstream rejection. When off, preserves the upstream error and tool-request semantics.',
  },
  'system.toolFallbackOn': { 'zh-CN': '工具兜底重试已开启', en: 'Tool fallback retry enabled' },
  'system.toolFallbackOff': { 'zh-CN': '工具兜底重试已关闭', en: 'Tool fallback retry disabled' },
  'system.toolCarrier': { 'zh-CN': '第三方工具承载', en: 'Third-party tool carrier' },
  'system.toolCarrierHint': {
    'zh-CN': '开启后：官方工具集里没有等价物的下游工具（记忆、知识库、自定义脚本等）会包成官方自定义工具的形态发出，上游返回时再拆回下游原名；下行与上行名字一一对应，客户端仍按自己的名字派发。',
    en:
      'Client tools with no official equivalent (memory, knowledge base, custom scripts) travel '
      + 'upstream in the shape upstream supports for client-defined tools, then are unpacked back '
      + 'to the original names on the way down. Names stay one-to-one in both directions, so '
      + 'clients still dispatch on their own names.',
  },
  'system.toolCarrierOn': {
    'zh-CN': '第三方工具承载已开启（无官方等价物的工具会包装发出）',
    en: 'Third-party tool carrier enabled (tools without an official equivalent are carried upstream)',
  },
  'system.toolCarrierOff': {
    'zh-CN': '第三方工具承载已关闭（下游工具原样发出）',
    en: 'Third-party tool carrier disabled (client tools are sent as-is)',
  },
  'system.officialTools': { 'zh-CN': '官方工具注入', en: 'Official tool injection' },
  'system.officialToolsHint': {
    'zh-CN':
      '官方工具集是上游识别客户端形态的一部分。未配置时按[下游本次声明]自动裁剪：'
      + '只注入回程能还原成下游真的声明过的那些名字。没有对应工具的工具'
      + '（浏览器预览、写文档、提议后续提问等）一旦注入，模型选中后下游只会报 unknown tool。'
      + '勾选并保存即改为按名单注入，全不选则是 [一个都不注入]。',
    en:
      'The official tool set is part of how upstream identifies the client. While unconfigured it is '
      + 'auto-trimmed to the tools whose names can be mapped back to what the client actually declared. '
      + 'Injected tools without a client counterpart (browser preview, doc writing, follow-up suggestions) '
      + 'make the client fail with unknown tool when the model picks them. Saving a selection switches to '
      + 'injecting exactly that list; clearing every box means nothing is injected.',
  },
  'system.officialToolsGroupCommon': {
    'zh-CN': '可派发（下游有对应工具，建议保持勾选）',
    en: 'Dispatchable (a downstream counterpart exists; keep checked)',
  },
  'system.officialToolsGroupOrphan': {
    'zh-CN': '不可派发（下游没有对应工具，勾选后模型选中会导致 unknown tool）',
    en:
      'Not dispatchable (no downstream counterpart; if checked and the model picks it, '
      + 'the client fails with unknown tool)',
  },
  'system.officialToolsApply': { 'zh-CN': '应用勾选', en: 'Apply selection' },
  'system.officialToolsSelectAll': { 'zh-CN': '全选', en: 'Select all' },
  'system.officialToolsSelectNone': { 'zh-CN': '全不选', en: 'Select none' },
  'system.officialToolsSaved': {
    'zh-CN': '官方工具注入已更新（下一个请求生效）',
    en: 'Official tool injection updated (applies to the next request)',
  },
  'system.officialSystem': { 'zh-CN': '官方系统提示词', en: 'Official system prompt' },
  'system.phTitle': { 'zh-CN': '可用占位符（点一下插入）', en: 'Placeholders (click to insert)' },
  'system.phHint': {
    'zh-CN': '这些占位符在每次请求时会被替换成真值，写了就能用；灰底的那些取值在客户端本机，'
      + '本代理取不到，会被替换成空。语法与官方一致。',
    en: 'These are replaced with real values on every request. Grey ones come from the client machine '
      + 'and cannot be resolved here, so they become empty. Syntax matches the official client.',
  },
  'system.phUnavailable': { 'zh-CN': '本代理取不到，会替换成空', en: 'Not resolvable here; becomes empty' },
  'system.officialSystemWrap': { 'zh-CN': '自动换行', en: 'Wrap' },
  'system.officialSystemWrapHint': {
    'zh-CN': '长行折到窗口宽度内显示；关掉则横向滚动看原始行.',
    en: 'Fold long lines to the window; turn off to scroll horizontally.',
  },
  'system.officialSystemAutoSaved': {
    'zh-CN': '编辑后自动保存', en: 'Auto-saved as you type',
  },
  'system.officialSystemRestored': {
    'zh-CN': '已恢复官方原文并保存', en: 'Official text restored and saved',
  },
  'system.officialSystemHint': {
    'zh-CN':
      '官方模板明文要求模型调用 suggest_prompts、写待办、申请提权、操作浏览器预览等工具。'
      + '其中下游没有对应物的那些，模型照着提示词去调就会报 unknown tool。'
      + '这里可以换成你自己的指令，或整段不带官方提示词。改动作用于之后的请求。',
    en:
      'The official template explicitly tells the model to call suggest_prompts, write todos, '
      + 'request elevation, drive the browser preview and more. Those without a client counterpart '
      + 'fail with unknown tool when the model follows the prompt. Replace it with your own '
      + 'instructions, or drop the official prompt entirely. Applies to later requests.',
  },
  'system.officialSystemPlaceholder': {
    'zh-CN': '选择[使用下面的自定义正文]后可在此编辑…',
    en: 'Select "custom text" to edit here…',
  },
  'system.officialSystemDirty': { 'zh-CN': '有未保存的改动', en: 'Unsaved changes' },
  'system.officialSystemRestore': { 'zh-CN': '恢复官方原文', en: 'Restore the official text' },
  'system.officialToolsSearchHint': {
    'zh-CN':
      'code_search（按正则搜索代码）回家的名字在各客户端不一致：'
      + 'dsh 自带同名工具 code_search，参数却是 search_term + search_folder_absolute_uri'
      + '（两者都必填，后者必须是会话工作目录下的绝对路径）；没有同名工具的客户端落到 grep。'
      + '前一种情况里搜索目录不在上游请求里，需要到[高级]区填「下游搜索目录（绝对路径）」，'
      + '填的应当是本机那个会话的工作目录；留空时该调用会因缺字段失败。',
    en:
      'code_search lands on different client tools: dsh ships its own code_search whose parameters '
      + 'are search_term + search_folder_absolute_uri (both required, the latter an absolute path '
      + 'inside the session working directory); clients without that name fall back to grep. '
      + 'The search folder is not part of the upstream request, so set "downstream search folder '
      + '(absolute path)" in the Advanced section to the session working directory on this machine; '
      + 'left empty, that call fails on the missing field.',
  },
  'system.officialToolsEmptyWarn': {
    'zh-CN':
      '注意：一个都不注入时，上游会因为工具集不完整而直接拒绝请求（返回 503）。'
      + '所以这种配置不会生效 —— 保存后会自动回退成按下游声明自动注入。',
    en:
      'Warning: injecting nothing makes upstream reject the request outright (503), because the tool set '
      + 'is then incomplete. Such a configuration does not take effect: it falls back to auto-injection.',
  },
  'system.officialToolsStatusAuto': {
    'zh-CN': '未配置（自动）',
    en: 'Unconfigured (automatic)',
  },
  'system.officialToolsStatusNone': {
    'zh-CN': '已配置：一个都不注入',
    en: 'Configured: nothing is injected',
  },
  'system.officialToolsStatusCount': {
    'zh-CN': '已配置：注入 {n} 个',
    en: 'Configured: {n} injected',
  },
  'system.officialToolsWhen': {
    'zh-CN': '改动作用于之后的请求，已在途的请求不受影响。',
    en: 'Changes apply to later requests; requests already in flight are unaffected.',
  },
  'system.officialToolsCountLabel': { 'zh-CN': '已勾选', en: 'Checked' },
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
    'zh-CN': '依据：docs/design/freebucks-strategy.html、docs/design/account-scheduling-and-refund.md §3（2026-09-14 结论）、docs/evidence/ledger-session-units-vs-freebucks.json',
    en: 'Sources: docs/design/freebucks-strategy.html, docs/design/account-scheduling-and-refund.md §3 (2026-09-14 findings), docs/evidence/ledger-session-units-vs-freebucks.json',
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
  'system.adviceInSync': { 'zh-CN': ' 当前设置已与推荐值一致', en: ' Current setting already matches the recommendation' },
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

  // ---- 系统设置:可调项(config.yaml 里除 host/port 外的项)----
  'tunables.title': { 'zh-CN': '全部配置项', en: 'All configuration' },
  'tunables.hint': {
    'zh-CN': '除监听地址与端口外的全部配置项，保存在 /data/settings.json。留空 = 不改这一项。',
    en: 'Every setting except the listen address/port, saved to /data/settings.json. '
      + 'Leave a field empty to keep it unchanged.',
  },
  'tunables.readonlyHint': {
    'zh-CN': '除监听地址与端口外的全部配置项（只读：需要管理员权限才能修改）。',
    en: 'Every setting except the listen address/port (read-only: admin rights are required to change them).',
  },
  'tunables.restartNote': {
    'zh-CN': '本区改动需重启服务后生效（保存不会立即应用）',
    en: 'Changes in this section take effect after a restart (saving does not apply them immediately)',
  },
  'tunables.hintZeroMeansOff': {
    'zh-CN': '填 0 = 关闭该功能',
    en: '0 = disabled',
  },
  'tunables.secretPlaceholderSet': {
    'zh-CN': '已设置（不回显；留空保持原样）',
    en: 'Already set (never displayed; leave empty to keep it)',
  },
  'tunables.hintSecretSet': {
    'zh-CN': '出于安全，已设置的值不会回显到这里。留空 = 保持不变，填写 = 整体替换。',
    en: 'For safety the current value is never sent to the browser. Empty keeps it, filling in replaces it.',
  },
  'tunables.hintSecretUnset': {
    'zh-CN': '当前未设置。填写后需重启服务才生效。',
    en: 'Not set. Filling it in takes effect after a restart.',
  },
  'tunables.hintLoginBase': {
    'zh-CN': '浏览器登录的站点地址',
    en: 'Site used for browser sign-in',
  },
  'tunables.savedNeedRestart': {
    'zh-CN': '已保存；重启服务后生效',
    en: 'Saved; takes effect after restarting the service',
  },
  'tunables.groupUpstream': { 'zh-CN': '上游', en: 'Upstream' },
  'tunables.groupSession': { 'zh-CN': '会话', en: 'Session' },
  'tunables.groupLimits': { 'zh-CN': '限额', en: 'Limits' },
  'tunables.groupLogging': { 'zh-CN': '日志', en: 'Logging' },
  'tunables.groupWeb': { 'zh-CN': '控制台', en: 'Console' },
  'tunables.groupUsers': { 'zh-CN': '用户', en: 'Users' },
  'tunables.groupServer': { 'zh-CN': '服务', en: 'Server' },
}
