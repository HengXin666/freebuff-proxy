# Agent Note: 控制台刷新必须如实说明"本次没真问上游"

Status: implemented

受影响代码: `src/session/observe/probe.ts`, `src/session/observe/snapshot.ts`,
`src/session/state.ts`, `src/context/ops/account-list.ts`,
`src/web/routes/inventory/accounts/{refresh,actions}.ts`,
`dashboard/views/overview/accounts/{refresh,row}.ts`,
`dashboard/locale/dict/accounts.ts`

## Problem

用户报告: 账号池的显示"永远有点偏差", 而且能同时看到**两种版本** ----
首屏加载时一种, 刷新后另一种, 从别的页面切回来又是另一种.

实测(本地 mock 上游 + 真实 server, 单变量对照)定位到三个独立缺陷:

1. **在途期间的刷新是静默空转.** `refresh()` 第一句就是
 `if (this._inFlight > 0) return this.session` ---- 有回复在传流时跳过探测
 (必须跳过: 服务端同一账号只允许一个客户端在线, 探测会顶掉活跃会话),
 但它**返回旧快照且不留下任何痕迹**, 而调用方(`/probe` / `/refresh`)
 照样报 `ok: true`. 实测: 注入 `_inFlight=2` 后连点四次刷新, 四次都返回
 完全相同的值(98/2)且全部报成功 ---- 用户看到的就是"刷了但数字没变".
 在途请求是常态(每次 chat 都在途), 所以这不是边缘情形.

2. **统计卡与账号表可能来自两份快照.** `probeAllAccounts` 只用返回的
 `accounts` 去刷统计卡(`refreshSnapshotExtras({ accounts })`), 而那个函数还要
 `slots` / `accountCount` / `models` ---- 缺了就退化成用 accounts 现算的局部数字.
 而 `POST /api/accounts/probe` 当时**根本不返回**这些字段(只有 `ok/results/accounts`).
 于是"探测刷新"之后: 账号表是新值, 统计卡是另一套口径 ----
 同一屏两个版本.

3. **刷新提示里"异常账号数"从来不显示.** `soft` 是数字
 (`failed.length - banned.length`), 却被写成 `soft.length` -> 恒为 `undefined`
 -> `if (soft.length)` 永不成立. 这条与本次诉求同源: 刷新后的界面本就说不清
 发生了什么.

## Decision

**把"没真问上游"变成显式状态, 并让同一屏的所有数字同源.**

### 1) `refresh()` 记录跳过现场

在途早退时写 `lastProbeSkipped = { at, inFlight }`, 真探测成功时清空.
`getSnapshot()` 与账号行(`AccountRuntimes.list()`)把它作为 `probeSkipped` 带出,
于是"这份额度是刚问到的"与"这是上次快照"在数据上可区分 ---- 不再依赖用户猜.

保留原有的跳过语义(绝不因在途去发探测): 改的只是**可观测性**, 不是探测时机.

### 2) 三处出口如实回报

`/api/accounts/refresh` / `/api/accounts/probe` 的每账号结果加 `skipped`;
单账号 `/api/accounts/:key/probe` 同样带出.

### 3) 前端在数据点旁边说明, 而不是只弹一句 toast

- 额度列上方加 `[上次快照]` 徽章(悬停给出跳过时刻), 让"为什么这个数字没变"就地可读;
- 一键刷新/探测的 toast 追加"n 个账号有回复在途, 本次未重新探测";
- 单账号探测成功时也带上同一句说明.

### 4) `probe` 端点补齐统计卡需要的字段

`POST /api/accounts/probe` 现在返回 `accountCount` / `modelNames` / `slots`,
前端把它整份交给 `refreshSnapshotExtras`, 与一键刷新走**同一个数据源** ----
同一屏不可能再出现两套口径.

### 5) 顺手修掉 `soft.length`

它是数字, 不是数组. 改成 `if (soft)`.

## Alternatives considered

- **什么都不做, 只把行为写进文档.** 最强理由: 跳过探测是正确设计, 数字没变本身
 不是 bug, 解释它属于"体验优化". 否决原因: 用户报的是"两种版本"这个**困惑**,
 而困惑的来源正是界面把旧快照当新值展示; 本仓已有"配置改了不生效却毫无线索"
 这类教训(见 config-passthrough), 让界面说谎的代价远高于加一个徽章.

- **在途时也强行探测, 只是排到在途结束之后.** 最强理由: 用户点刷新就该拿到新值,
 排队比"告诉他没刷"更符合直觉. 否决原因: 那会让一次点击的**耗时不可预期**
 (长回复可能几十分钟), 用户会以为界面卡死; 而且排队的探测在长流期间会
 反复堆积. 跳过 + 如实说明, 是"行为确定 + 信息透明"的取舍.

- **让 `refresh()` 在途时抛错, 让调用方显式处理.** 最强理由: 最不容易被忽略
 (失败一定可见). 否决原因: 在途跳过**不是错误** ---- 它是设计行为, 抛错会让
 一键刷新在正常使用时频繁报红, 用户反而会去追一个并不存在的故障.
 状态标记比异常更贴合语义.

- **统计卡改读 `/api/overview`, 不在 probe 响应里补字段(让前端多打一次).**
 最强理由: 复用既有端点, 后端零改动. 否决原因: 那就是**两次请求 = 两个时刻的
 快照**, 探测刚更新完账号表, 紧接着的 overview 又是另一个瞬间, 时序窗口本身
 就是"两套数字"的来源. 一次响应给全, 才是同一屏同源.

- **只修 `probe` 端点, 不做跳过标记.** 最强理由: 改动最小, 且能解决用户报的
 "两个版本"里较明显的那一半. 否决原因: 在途跳过是**每次 chat 都在发生**的常态,
 不标记它等于让最常见的那个滞后永远无法解释; 而用户明确说了"缓存总是有滞后性",
 被跳过的那份快照正是他说的缓存.

## Consequences

- `refresh()` 多一个字段写入, 探测时机与跳过语义**完全未变**(仍绝不顶掉活跃会话).
- 账号行多一个可选字段 `probeSkipped`(老前端忽略它即可, 不影响渲染).
- `POST /api/accounts/probe` 的响应体变大(多 3 个字段), 向后兼容.
- 统计卡在"探测刷新"后与账号表同源, 不再出现同屏两套数字.
- 刷新提示恢复显示"异常账号数"(修掉 `soft.length` 后该分支才可能成立).
