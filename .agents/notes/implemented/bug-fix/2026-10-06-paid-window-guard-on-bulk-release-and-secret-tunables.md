# Agent Note: 付费时段保护扩到批量释放路径与启动扫尾;凭据值不进响应体

Status: implemented

## Problem

用户三条指正,前两条都指向同一个结构性问题: **"付费时段内不释放"这条判据
只写在调度层,而释放动作有几条完全不同的入口**,于是同一小时在一条路径上被
保护,在另一条上被直接扔掉.

### 一,重启/退出/断开全部 会当场烧掉已买断的一小时

实测链路(面板点[重启服务]):

```
POST /api/system/restart
  -> releaseBeforeRestart() -> runtimes.releaseAllStrict()
     -> 每账号 rt.sessions.releaseStrict()      <- 不看 expiresAt
        -> _releaseUnlocked() -> DELETE /session
  -> lifecycle.shutdown(strict) -> runtimes.shutdown({strict:true}) -> 同一批 DELETE
```

`proxy/routes/auth.ts` 的 `releaseSessionUnlessPaid` 是"唯一允许的释放入口",
但它只覆盖 **7 处换号/重试路径**;`releaseStrict` / `releaseAllStrict` /
`releaseWhenIdle` / `session.shutdown` / `cleanupOrphans` 这五条都绕开了它.

`releaseWhenIdle` 尤其危险:它是**代理切换 / 账号信息变更**的收尾路径
(`_disposeRuntime`),也就是说"改了代理池"这一个动作,就会把全池正在跑的
已付费会话逐个 DELETE 掉.

### 二,启动扫尾会把仍在计费窗口内的会话删掉

`sweeps.cleanupOrphans` 对本进程之外遗留的每个句柄直接 DELETE. 而
`handles/load.ts` 把上一次进程的 `sessions` **全部**倒进 `orphans`
(注释原话: "要么还有效要 DELETE, 要么已过期 DELETE 无害"). 前一半是错的:
"有效"里包含**仍在已付费时段内**的那些 ---- 进程被杀后重启, 那一小时还在,
新进程完全可以 `holderFor` 接管复用, 却被启动扫尾当场删掉.

### 三,设置页把服务凭据明文回显给浏览器

`GET /api/settings` 回 `tunables[server.apiKeys]` 与
`tunables[users.defaultAdminPassword]` 的**真值**,前端再把它们渲染进控件.
本节第一条来自用户原话:

> 另外你这个是什么意思?你这样子直接把用户的内容全部都暴露了,根本就不应该存在这种东西

(`server.apiKeys` 在设置页的标签当时叫"超级 API Key".)

## Decision

### 一 . 判据下沉:释放层自己判付费时段,`force` 是唯一的显式出口

`session/core/lease.ts` 新增 `inPaidWindowFor(session)` ---- 与
`inPaidWindow` 同一判据,但收会话对象而不是 `this`,给不持有 SessionManager
的调用方(启动扫尾 / 路由层)用.

三条批量路径全部加闸:

- `releaseStrict(opts)` / `releaseWhenIdle(opts)`: 付费时段内返回
  `{ok:true, skippedPaidWindow:true}`(**不是失败** ---- 调用方据此分开报),
  `opts.force === true` 才真删.
- `session.shutdown()`: `releaseOnShutdown` 之外再叠一层 `!inPaidWindow()`
  (句柄已落盘,不删不等于找不回来).
- `cleanupOrphans(opts)`: 付费时段内且**未被上游确认结束**的句柄计进
  `deferred` 并保留;`opts.includePaid` 是显式强删口(测试用).

`force` 的合法调用方只有两处,都是"用户看着面板按了按钮":
`web/routes/inventory/accounts/actions.ts` 的 `closeSession`(关闭单条会话)
与 `context/ops/account-ops.ts` 的 `reconnectAll`([断开全部连接]).
`releaseAllStrict` 转发 `opts` 但**默认不带 force**,所以[重启服务]不删.

### 二 . 待结算退款句柄不受这条保护

`cleanupOrphans` 里多一个 `refundOnly` 集合: `pendingRefunds` 队列里的
instanceId 都是**已经拿到上游 ended 回执**的(会话不在了, 只是钱还没算完),
保留它们没有"复用"可言,必须继续重放追问. 这一条与"可能还活着的遗留会话"
必须分开,否则加保护会把退款追问一起冻住.

### 三 . 凭据项在真源那一层就不出值

`TunableSpec` 新增 `secret?: boolean`;`server.apiKeys` 与
`users.defaultAdminPassword` 标上. 然后:

- `snapshotTunables()` 对 secret 项**一律写 null** ----
  "明文凭据绝不进响应体"因此是这一层的性质,任何新增的快照消费方
  (日志导出/调试接口/第三个前端)都自动受保护,不靠调用方自觉.
- `redactTunables(values)` 抹 POST 回执(它回的是刚写盘的原值).
- `secretsFromValues` / `secretsEffective` 只回**布尔**"有没有设置" ----
  前端需要它才能把"从没设过"与"设过但我不回显"分开.
  `secretsEffective` 以**盘上保存值**优先: 可调项要重启才合并进 config,
  只看 config 会让刚保存的 Key 显示成"未设置".
- 前端用 `type=password` + 空值 + `placeholder`,语义是"留空 = 不改,
  填写 = 整串替换". 没有"显示/隐藏"开关 ---- 那只是把明文再摆一遍.

标签也从"超级 API Key"改为"下游访问 Key": 它是一把**服务凭据**,
任何拿到它的人都能读写整个代理面,不是密码;文档同步写明这一点.

## Alternatives considered

- **什么都不做(保持只保护调度层)** ---- 最强理由是:现状自洽,
  `releaseSessionUnlessPaid` 已覆盖主流程,且"重启就重启"看起来符合直觉.
  被否决是因为**实测代价是钱**:重启一次 = 每账号扔掉一小时;
  而"重启"恰恰是用户解决幽灵连接最常用的动作(面板上就有按钮).
  安全的方向不对称 ---- 少删一次只是留一条会自然过期的会话,
  多删一次是不可逆的付费损失.
- **在 7 处调用点继续加 `releaseSessionUnlessPaid`** ---- 与 2026-10-04
  那次收敛同一结论: 散在各处的判据一定会漏(那次是 7 处漏了 3 处).
  判据必须在**释放层**内部, 这样新加的调用路径自动受保护.
- **让 `releaseAllStrict` 默认 force(保持重启就清空的旧行为)** ----
  行为兼容,升级不改观感. 被否决: 这正是要修的那条路径; 而且
  "清空"在买断计费下不是运维收益,只是烧钱.
- **启动扫尾改成"只删过期的"但不区分退款句柄** ---- 更简单.
  被否决: 会把仍在 pending 的退款追问一起冻住(那些句柄的会话已结束,
  没有过期时间可判), 那笔预扣就永远拿不回来.
- **在前端屏蔽凭据显示(控件改成 password 但后端照回真值)** ----
  改动面最小(只动一个前端文件). 被否决: 明文仍在响应体里,一次截图/
  一个浏览器插件/一次代理日志就够抄走; 而且后端 GET 本来就对非 admin 开放,
  等于把服务凭据发给任何已登录用户. 屏蔽必须在真源.
- **把凭据项从可调项表里删掉(前端不给看也不给改)** ---- 更彻底.
  被否决: "除 host/port 外全部可调"是用户裁决; 删掉会让改 Key 只能改文件,
  与[一切配置走前端]冲突. 保留可调性,只去掉回显,是它的正确读法.

## Consequences

- **重启/退出/代理切换/账号变更不再删除付费时段内的会话**. 代价: 那些会话
  在旧进程里没了 `instanceId`,新进程要等下一次请求经 `holderFor(model)` +
  takeover 才能接管(或到点自然过期). 这是**跨重启复用**, 由上游清单支撑,
  见 2026-10-04-session-inventory-from-upstream.md.
- **`releaseAllStrict` 的返回值多了 `skippedPaid`**,`released` 只数真正删掉的
  (且要求 `attempts > 0`,本来就没会话的账号不再被算进去).
  重启回执文案相应改成三段式(已释放/保留在付费时段内/取消失败) ----
  把"跳过"说成"已释放"会让用户以为钱退回来了.
- **测试断言改了 4 处**,全部因为原断言钉的是**已被推翻的行为**:
  `drain` / `forward-proxy` 的"代理切换后旧 session 优雅释放"改为
  "不得删除";`queue` / `waiting-room` / `delete-refund` 的测试清场显式带
  `force`(它们测的不是付费时段保护);`delete-refund` (6) 新增一组对照
  (不带 force 跳过 / 带 force 删除).
- **`GET /api/settings` 的值对凭据项恒为 null**,前端据此渲染密码框.
  新增一个可调项时若忘了标 `secret`,值是照常回显的 ----
  所以测试钉住了"这两个必须标 secret"与"普通项不得标 secret"两条.

## Evidence

- 新增 `test/suites/entries/smoke/parts/webapi/probe/tunables-secrets.ts`:
  对**整体 JSON 文本**搜凭据 canary(不是挑字段判定),覆盖 GET / POST 两个
  回执 + 非 admin 身份 + 盘上真值仍在;并验 `secrets` 布尔与 `secret` 声明.
- `delete-refund` (6) 与 (7) 新增判据,各自钉住一个方向:
  - 不带 force 时 `sessionDeletes === 0` 且 `deferred === 1`(核心修复);
  - 带 force 时照常删除且 `skippedPaid === 0`;
  - 启动扫尾默认不删付费时段内的遗留句柄,句柄仍在文件里.
- `drain` / `forward-proxy` 两处改为断"零 DELETE"(反向前提),原断言在改动后
  立即变红,证明它确实钉住了旧行为.
- 门禁 17/17 全绿;`npm run typecheck` 过;`npm test`(smoke)全绿.
- **未做**: 真实上游的端到端复测(重启后 takeover 接管的实测). 本轮改动
  全部落在"要不要发 DELETE"这一层,上游调用形态未变;接管路径已由
  2026-10-04 的 5 轮实测覆盖,但"重启后接管"这一具体时序仍未实测.

## 附带修复: REFUND-COPY 守卫漏扫 .ts

`copy-sweep.ts` 的扫描扩展名集合是 `js|mjs|cjs|md|yaml|json` ----
全仓转 TS 之后这些实现文件**整段隐形**. 实测它确实漏了:本轮在
`src/session/release/release.ts` 的注释里发现"按实际占用时长退还 Freebucks
未用部分"(正是该守卫存在的理由)因扩展名而不被扫到.
已把扩展名扩到 `ts|tsx|css|html`,并就地改正那条注释.
