# Agent Note: 日志必须有账号归属，且 401 不得被宽匹配成「凭证无效」

Status: implemented

## Problem

用户在控制台「日志」页同时撞到三件事，且三件事的根因是**同一个**：日志的
`account` 字段在绝大多数路径上根本没被写入。

1. **不能按账号筛选。** 后端 `readLogBuffer({ account })` 早已实现，但日志
   里 `account` 为空，筛选永远返回 0 条 —— 功能存在却不可用。
2. **显示的是"奇奇怪怪的东西"。** `createUpstreamClient called` /
   `DeviceSigner constructed` / `device key registered` 这类日志成批无主出现：
   它们发生在 `SessionManager` 被创建**之前**，不在任何账号上下文里。
3. **"凭证无效"是误报。** 用户贴的凭据实测**完全可用**（三条独立路径均
   HTTP 200）：裸 `curl`、bun 通道、Node 回落通道，上游返回
   `{"status":"none", freebucks:{balance:20}}`。但控制台显示「凭证无效」。

第 3 条是独立的第二个 bug：上游 401 的回执是
`{"error":"unauthorized","message":"Invalid API key"}`，客户端把它原样抛成
`code: 'unauthorized'`；前端 `probeReason()` 用
`c.includes('unauthorized') || c.includes('invalid') || c.includes('401')`
**宽匹配**命中「凭证无效」。于是任何含这些子串的失败都被判成"这个号要重新
登录" —— 而「重新登录导入」是成本最高的处置动作，用户照着错的提示白折腾。

## Decision

**两处分别修，不合并成一条。**

### 一、日志上下文按账号固定注入（改 `app-context.js` + `session-manager.js`）

账号上下文此前**只在 chat 路径**上写（`proxy.js` 的 `patchLogContext`），
探测 / 刷新 / 选号 / 空闲释放 / runtime 创建全部无主。现在在两处补上：

- `AccountRuntimes.get()` 把 `createUpstreamClient(...)` 整段包进
  `runWithLogContext({ account: email, key })` —— 覆盖 runtime 创建期的日志；
- `SessionManager` 新增 `logContext` 构造参数，**在 `withLock()` 里**包住锁内
  执行段 —— refresh / admit / release / 退款追问全走 `withLock`，一处覆盖全部。

之所以在 `withLock` 而不是逐个方法包：`withLock` 是这些异步操作的**唯一公共
入口**，逐个方法包会漏掉将来新增的方法，也会漏掉 `withLock` 内调用链深处
（如 `_releaseUnlocked`）产生的日志。

`SessionManager` 自己不知道邮箱（只拿到 `accountKey`，而 key 可能是 UUID），
所以由上层把可读邮箱传进去 —— 日志里显示**完整邮箱**，不是本地部分。
（此前前端还把邮箱 `split('@')[0]` 只剩前缀，于是 `a@gmail.com` 与
`a@outlook.com` 在页面上长得一模一样。）

### 二、401 归一成 `auth_unauthorized`（改 `upstream/client.js` + 前端判定）

在 session 回执解析处把 `res.status === 401` **单独成类**，`code` 固定为
`auth_unauthorized`，并把上游原文（`Invalid API key` /
`Missing or invalid Authorization header`）带进 `message` 与 `body`。

前端 `probeReason()` 改为按精确 code 命中，并把上游原文与**处置动作**写进
tip：「用浏览器重新登录该账号并重新导入凭据；这不是限流，等待不会恢复」——
只写"凭证无效"用户只能猜，而"重新登录"与"等等再看"是两条成本完全不同的动作。

### 三、日志页补清空与账号下拉（改 `app.js` + `api.js` + `i18n.js`）

- `DELETE /api/logs` 清空**内存缓冲**（不动任何落盘数据、不重启进程）；
- 账号筛选下拉，选项 = 账号池邮箱 ∪ 缓冲里出现过的账号（后者覆盖已删除 /
  尚未刷进 `state.accounts` 的号）；
- 时间戳改成本地 `MM-DD HH:mm:ss`（原先是 UTC ISO 串，与用户墙钟差 8 小时）。

## Alternatives considered

- **什么都不做（继续靠搜索框手打邮箱）** —— 最省事，但 `account` 字段是空的，
  手打也没有任何东西可命中；且用户得先知道拼法。日志页的账号维度等于不存在。
- **只在 `SessionManager` 构造里存 email、由各 logger 调用点手动带上** ——
  要改几十个 `logger.*` 调用，且将来新增调用必然漏带（这正是当初 `account`
  为空的成因：靠调用方自觉）。在 `withLock` 一处包上下文是**结构性**的，不会漏。
- **把 401 也归进 `ACCOUNT_LEVEL_SESSION_STATUSES` 走冷却换号** —— 看着统一，
  但语义错了：401 是**凭据**失效，换号不会让它恢复（换的是另一个号，失效的
  还是失效的），而冷却换号会掩盖"这个号需要重新登录"。它是账号生命周期事件，
  不是调度层故障。
- **保留 `includes('unauthorized')` 宽匹配、只改文案** —— 文案改对了，判定
  仍然会把非鉴权类的 401 判成凭证失效，用户依旧按错误提示白折腾。判定与文案
  必须一起改。
- **清空日志改成重启进程** —— 重启会连带丢掉热会话现场（一次 admit 买断
  一整小时，见 [2026-09-14-paid-hour-hold.md](../architecture/2026-09-14-paid-hour-hold.md)），
  代价远大于清缓冲。

## Consequences

- **每条日志多带两个字段**（`account` / `key`）。日志体变大约几十字节，
  环形缓冲容量不变（默认 500 条），所以内存上界不变。
- **`withLock` 包了一层上下文**：锁内所有日志现在都有归属。代价是
  `AsyncLocalStorage` 在每个锁段多一次 `run()` —— 每次会话操作一次，
  相对上游往返（数百毫秒）可忽略。
- **`auth_unauthorized` 是新 code**，不在 `ACCOUNT_COOLDOWN_CODES` /
  `ACCOUNT_LEVEL_SESSION_STATUSES` 里，因此**不触发冷却、不触发换号**：
  这是刻意的（见 Alternatives considered）。控制台上它表现为账号状态徽章
  「凭证失效」而非「冷却中」。
- **前端下拉选项来自两个来源**（账号池 + 缓冲里出现过的账号）。已删除的
  账号仍会出现在下拉里 —— 这是有意的：它的日志还在缓冲里，不给选项就筛不到。
- **`DELETE /api/logs` 只清内存**：重启后不会"保持清空"（日志会重新累积），
  这是环形缓冲的既有语义，不是持久化开关。

## Evidence

- 凭据可用性（2026-10-04）：裸 curl / bun 通道 / Node 回落**三条路径均 HTTP 200**，
  `freebucks: {balance: 20, daily: {limit: 20}}`。
- 401 真值（单变量对照）：无效 token → 401 `Invalid API key`；
  无 token → 401 `Missing or invalid Authorization header`；有效 token → 200。
- 修后探测：有效账号 `ok=true`；无效账号
  `ok=false, code=auth_unauthorized, status=401, error="Invalid API key"`。
- 修后日志归属：全部条目带 `account`，按账号筛选 `fake401@example.com` 命中 4 条、
  另一账号 0 条（此前均为 0 条）。
- `DELETE /api/logs` 实测：清空前 18 条 → 清空后 1 条（`log buffer cleared by admin`）。
- 回归测试：`test/smoke.mjs` 两条 —— 401 归一（code / message / body）、
  日志清空与按账号过滤（含大小写不敏感与级别过滤不被挤掉）。
