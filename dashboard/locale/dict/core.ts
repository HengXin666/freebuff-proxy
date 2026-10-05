/**
 * core 域的词条表 -- 从 dashboard/i18n.js 的 DICT 按域切出.
 *
 * 为什么按域切: DICT 原本 815 行单文件(超前端每文件 500 行上限), 而它全部是
 * "key -> { 'zh-CN': ..., en: ... }" 的数据行, 没有任何逻辑. 按域切之后
 * 每种语言的新增文案只改一个文件, 而不是在 800 行里定位.
 *
 * 口径: 纯切分, key 与文案逐字节不变.
 */
export default {
  // ---- 通用 ----
  'common.ok': { 'zh-CN': '正常', en: 'OK' },
  'common.cancel': { 'zh-CN': '取消', en: 'Cancel' },
  'hooks.notFunction': { 'zh-CN': 'registerHooks: {name} 不是函数(传进来的是 {type})', en: 'registerHooks: {name} is not a function (got {type})' },
  'hooks.notRegistered': { 'zh-CN': '跨视图回调未注册: {name}(检查装配层的 registerHooks)', en: 'Cross-view callback not registered: {name} (check registerHooks wiring)' },
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

  // ---- 提示 ----
  'toast.saved': { 'zh-CN': '已保存', en: 'Saved' },
  'toast.copyFailSelect': { 'zh-CN': '复制失败，请手动选中文本', en: 'Copy failed — please select the text manually' },
  'toast.copyFailSelectShort': { 'zh-CN': '复制失败，请手动选中', en: 'Copy failed — select manually' },
  'toast.commandCopied': { 'zh-CN': '已复制处置命令', en: 'Command copied' },

  // ---- 时长单位 ----
  'dur.seconds': { 'zh-CN': '{n} 秒', en: '{n}s' },
  'dur.minutes': { 'zh-CN': '{n} 分钟', en: '{n}m' },
  'dur.hoursMinutes': { 'zh-CN': '{h} 小时 {m} 分', en: '{h}h {m}m' },
  'dur.hours': { 'zh-CN': '{h} 小时', en: '{h}h' },
  'dur.minutesSeconds': { 'zh-CN': '{m} 分 {s} 秒', en: '{m}m {s}s' },
  'dur.hoursMinutesShort': { 'zh-CN': '{h} 时 {m} 分', en: '{h}h {m}m' },
  'dur.daysHoursAfter': { 'zh-CN': '{d} 天 {h} 小时后', en: 'in {d}d {h}h' },
  'dur.hoursMinutesAfter': { 'zh-CN': '{h} 小时 {m} 分后', en: 'in {h}h {m}m' },

}
