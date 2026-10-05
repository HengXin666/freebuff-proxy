/**
 * views 域的词条表 -- 从 dashboard/i18n.js 的 DICT 按域切出.
 *
 *
 * 口径: 纯切分, key 与文案逐字节不变.
 */
export default {
  // ---- 总览 ----
  'overview.accountPool': { 'zh-CN': '账号池', en: 'Account pool' },
  'overview.accountPoolCount': { 'zh-CN': '账号池（{n}）', en: 'Account pool ({n})' },
  'overview.balanceBarTitle': { 'zh-CN': '{email} {pct}%（{used}/{total}）', en: '{email} {pct}% ({used}/{total})' },

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

  // ---- 系统(数据文件自检 / 服务操作)----
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
    'zh-CN': ' 损坏的文件会让对应功能降级（配置回落默认值 / 账号履历丢失 / 会话退款索引丢失）。停服后把文件移走再启动即可自动重建；下面的命令可直接照做。',
    en: ' Corrupt files degrade the matching feature (config falls back to defaults / account history lost / session refund index lost). Stop the service, move the file away, start again — it rebuilds automatically. The commands below are ready to copy.',
  },
  'system.dirtyHint': {
    'zh-CN': ' 有文件里混进了结构非法的记录（null / 缺关键字段）。这类文件**本身没坏**，新版本会逐条丢弃并留证，不影响启动——但请核对丢掉的原文，必要时从备份恢复。',
    en: ' Some files contain structurally invalid records (null / missing key fields). The files themselves are fine: the current version drops those entries one by one, keeps evidence, and still starts — but review what was dropped and restore from backup if needed.',
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
  'logs.export': { 'zh-CN': '导出', en: 'Export' },
  'logs.exportTitle': {
    'zh-CN': '把当前筛选结果导出为 .jsonl 文件（每行一个 JSON，可直接交给别人分析）',
    en: 'Export the current filter result as a .jsonl file (one JSON per line)',
  },
  'logs.exported': { 'zh-CN': '已导出 {n} 条 → {name}', en: 'Exported {n} entries → {name}' },
  'logs.exportEmpty': { 'zh-CN': '当前筛选没有可导出的日志', en: 'Nothing to export for the current filter' },
  'logs.empty': {
    'zh-CN': '没有匹配的日志。缓冲只保留最近若干条（进程内，重启即清空）。',
    en: 'No matching log entries. The buffer keeps only a bounded tail (in-process; cleared on restart).',
  },
  'logs.meta': { 'zh-CN': '{n} 条 · 服务端时间 {time}', en: '{n} entries · server time {time}' },
  'logs.accountHint': { 'zh-CN': '发起该请求的账号', en: 'Account that issued this request' },
  'logs.reqIdHint': {
    'zh-CN': '请求 id：点击只看该请求的全链路日志',
    en: 'Request id: click to filter this request’s whole trace',
  },
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
  // 只清内存里的日志缓冲:不动任何落盘数据,也不影响在途请求
  'logs.clear': { 'zh-CN': '清空', en: 'Clear' },
  'logs.clearConfirm': {
    'zh-CN': '清空进程内日志缓冲？只清显示的日志，不影响账号/会话/配置等任何落盘数据，也不会重启服务。',
    en: 'Clear the in-process log buffer? Only the displayed logs are cleared — no persisted data (accounts / sessions / config) is touched and the service is not restarted.',
  },
  'logs.cleared': { 'zh-CN': '日志缓冲已清空', en: 'Log buffer cleared' },
  'logs.accountAll': { 'zh-CN': '全部账号', en: 'All accounts' },
  'logs.accountFilterHint': {
    'zh-CN': '只看某个账号（点日志里的账号徽章也可直接筛选）',
    en: 'Filter by account (or click the account badge on a log row)',
  },
  'logs.expandHint': {
    'zh-CN': '点任意一行展开完整字段（含上游原始判据），可一键复制。缓冲为进程内有界环形队列，重启即清空。',
    en: 'Click any row to expand the full fields (including raw upstream verdicts) and copy them in one click. The buffer is a bounded in-process ring, cleared on restart.',
  },

  // ---- 日志颗粒度与事件类型(与 src/util/log-kinds.ts 的 EVENTS 一一对应)----
  'logs.kindRequest': { 'zh-CN': '请求', en: 'Request' },
  'logs.kindHint': { 'zh-CN': '按一次下游请求聚合（同 reqId 为一组）', en: 'Grouped by one downstream request (same reqId)' },
  'logs.eventHint': { 'zh-CN': '独立事件（与具体请求无关）', en: 'Standalone event (not tied to a request)' },
  'logs.event.quotaRefresh': { 'zh-CN': '额度刷新', en: 'Quota refresh' },
  'logs.event.accountProbe': { 'zh-CN': '账号探测', en: 'Account probe' },
  'logs.event.modelFetch': { 'zh-CN': '模型获取', en: 'Model fetch' },
  'logs.event.catalogSync': { 'zh-CN': '目录同步', en: 'Catalog sync' },
  'logs.event.accountImport': { 'zh-CN': '账号导入', en: 'Account import' },
  'logs.event.accountDelete': { 'zh-CN': '账号删除', en: 'Account delete' },
  'logs.event.loginFlow': { 'zh-CN': '登录流程', en: 'Login flow' },
  'logs.event.sessionAdmit': { 'zh-CN': '会话建立', en: 'Session admit' },
  'logs.event.sessionRelease': { 'zh-CN': '会话释放', en: 'Session release' },
  'logs.event.sessionRefund': { 'zh-CN': '退款结算', en: 'Refund settle' },
  'logs.event.sessionHeartbeat': { 'zh-CN': '会话保活', en: 'Session heartbeat' },
  'logs.event.deviceKey': { 'zh-CN': '设备密钥', en: 'Device key' },
  'logs.event.proxyTest': { 'zh-CN': '代理测试', en: 'Proxy test' },
  'logs.event.settingsChange': { 'zh-CN': '设置变更', en: 'Settings change' },
  'logs.event.dataFile': { 'zh-CN': '数据文件', en: 'Data file' },
  'logs.event.system': { 'zh-CN': '系统', en: 'System' },
  'logs.event.telemetry': { 'zh-CN': '遥测上报', en: 'Telemetry' },
}
