# Agent Note: 控制台[日志]页 — 让上游判据不必靠 docker logs 也能看到

Status: implemented

## Problem

上游的故障判据只写进 stdout.典型如地理封锁
(见 [2026-09-30-country-block-reason-in-200.md](../bug-fix/2026-09-30-country-block-reason-in-200.md)):
回执里明明写了 `countryBlockReason: "country_not_allowed"`,但用户看到的是
前端一串 503 —— 因为日志在容器里,看它要 `docker logs`,而容器化部署的用户
根本不该被要求去翻 stdout.

结果是排障只能靠猜:用户看到 503 就去查账号,查额度,而真正的原因是出口 IP
被拒.每一次误判都伴随一轮 admit(一次买断一小时 Freebucks),代价是真钱.

## Decision

**把日志在进程内留一份有界环形缓冲,并在控制台加一个可读,可筛选,可展开的
[日志]页(admin 专属).**

- `src/util/log.js`:新增环形缓冲(默认 500 条)+ `readLogBuffer()`;
  `log()` 在写 stdout 的同时入缓冲.**有界是硬要求** —— 长期运行的实例
  不能被日志吃光内存(早期"日志把服务拖死"的教训),超容量丢最旧的.
- `src/web/api.js`:`GET /api/logs`,支持 `level` / `q` / `limit` / `since`,
  admin 专属.关键词搜索命中**整条 JSON**(不只是 msg),所以能直接搜
  `country`,`banned`,邮箱这类只出现在字段里的值.
- `dashboard/app.js`:新增 `logs` 路由 + 页面,默认只显示 ts/level/msg,
  **点行展开完整字段**并可一键复制;带级别筛选,关键词搜索,自动刷新开关.

### 为什么默认折叠,点开才给完整字段

日志字段很吵(instanceId,runId,各种计数全在里面).全展开会让"扫一眼找异常"
变成不可能,所以默认只给一行摘要,需要钻取时才展开 —— 排障时人先看级别和
msg,锁定了才看字段.

### 为什么是进程内缓冲而不是读日志文件

容器里不一定有可挂载的日志文件(日志可能直接进 docker 的 stdout),读文件
还要处理轮转与权限.缓冲零依赖,零配置,随起随有;代价是重启即清空 ——
这对"看刚刚发生了什么"这个实际用途是可接受的(页面上也明说了这一点).

## Alternatives considered

- **什么都不做,让用户 docker logs** —— 最省事.但它正是这次排障绕远路的
  原因:用户在 GUI 里已经能看到账号,额度,代理,唯独"为什么失败"要跳出
  GUI 去翻终端.GUI 已经承担了诊断职责,缺这一环就断在最后一步.
- **落盘到 data/ 日志文件** —— 能跨重启保留,但引入轮转,权限,磁盘增长
  三个新问题,且本项目铁律是"轻量优先,禁止加无用东西".跨重启保留对
  "刚发生了什么"这个用途价值很低.
- **把错误明细塞进现有账号行(lastProbe)** —— 已有机制,但它只能承载
  "这个账号最近一次探测的成败",装不下全链路(session / agent run / chat /
  代理测试 / 登录流程)的时序.日志页是它的**补充**而非替代.

## Consequences

- 用户不必离开 GUI 就能读到上游完整判据;排障路径从"猜"变成"看".
- 缓冲默认 500 条,进程内,重启清空 —— 页面已明示,避免误以为看全了.
- 只暴露给 admin:日志含邮箱,instanceId,runId 等内部标识.
- 缓冲只增不写盘,长期运行的实例内存占用有上界.

## Evidence

- 本地实例实测:`GET /api/logs` 返回 7 条含完整字段的日志(含
  `warn upstream /api/v1/me check failed` 及其 `error` 字段).
- Playwright 实测页面:导航出现[日志],渲染 7 行,展开后显示
  `{"error": "GET /api/v1/me failed: 401"}`,搜索 "me check" 过滤到 1 条,
  级别切 error 得 0 条,清除筛选恢复 7 条,全程 0 个 JS 错误.
