# Agent Note: 缺持有心跳 + 冷启动未归一化 → 购买被上游退款作废

Status: implemented

## Problem

用户远程部署上「花了钱、请求失败、积分归零、账号进冷却」，反复复现。
本次通过**逆向官方 AppImage（0.0.158）** + **读远程日志**定位到两个独立缺陷。

### 缺陷一：从不发「持有心跳」

官方客户端在 admission 成功后**立刻**发一次心跳 GET、之后每 **45 秒**一次
（`orchestrator.js:208905-208957` 的 `syncHeartbeatTimer`；
常量 `FREEBUFF_SESSION_HEARTBEAT_INTERVAL_MS = 45000`）。
形态（`orchestrator.js:207945-207957` 的 `getSession(auth, instanceId, heartbeat)`）：

```
GET /api/v1/freebuff/session
  x-freebuff-instance-id: <该会话>
  x-freebuff-heartbeat: 1                    ← 与 include-unused-rate-limits 二选一
  （心跳**不带** x-fb-timezone：官方是 ...!heartbeat ? timeZoneHeaders() : {}）
```

抓包实证：admission（line 8）→ 首个心跳（line 17）间隔 **20.5 秒**。

而我们**一次都没发过**：`makeSessionViaBun()` 的返回函数签名是 `async () => {}`，
**不接收参数** → 调用方传的 `opts.instanceId` 在 GET 路径被静默丢弃 →
bun 侧 `getSession()` 也不构造这两个头。

后果与远程日志吻合：admission（11:25:16）后 **25 秒**就收到
`409 session_superseded` + `"This model purchase was refunded"` ——
时间尺度正好落在官方首个心跳窗口（≤20.5s）之后。

### 缺陷二：冷启动时未归一化模型名

`resolveModelAlias()` 把可读名（"MiMo 2.6 Flash"）落回目录 key 靠的是**已抓到的
目录**（`CatalogHolder.keyForName`）。而目录是懒加载的，**冷启动后第一个请求**
在归一化时目录还是空的 → 归一化失败、原样返回可读名 → 一路传到 admission 的
`x-freebuff-model` → 上游回：

```
400 {"error":"invalid_request","message":"Unknown model. Update Freebuff Desktop or choose a supported model."}
```

实测（2026-10-04 12:15）三个账号全部 400，日志里
`x-freebuff-model: "MiMo 2.6 Flash"` —— 本应是句柄 `fbm1.xxx`。
这是上一轮"模型名三层重构"引入的回归：归一化被放在了目录加载**之前**。

## Decision

### 一、补上持有心跳（三处接线）

- `cli-bridge/upstream.mjs` 的 `getSession(opts)`：接收 `instanceId` / `heartbeat`，
  按官方三元构造头（心跳不带时区、带 `x-freebuff-heartbeat: 1`）。
- `official-rpc.js` 的 `rpcSession`：透传 `instanceId` / `heartbeat` 到 bun。
- `client.js` 的 `makeSessionViaBun`：改签名收 `opts` 并透传（**此前静默丢弃**）。
- `session-manager.js`：新增 `_sendHoldHeartbeat()`，在 **admit 成功后立刻**调用
  （fire-and-forget）；轮询 `refresh({heartbeat: true})` 走心跳形态保活。
  控制台「检测/刷新」仍走普通形态（要拿额度/单价）。

### 二、把「目录加载」提到「归一化」之前，且让它在冷启动时真的能抓

`proxy.js`：在 `resolveModelAlias()` **之前**加一步「目录为空则先
`refreshCatalogs({force:false})`」。该请求本来就必须抓目录（admission 要句柄），
与零自动探测不冲突（§20.3 禁的是启动/导入/首访模型表时空跑）。

⚠️ **但这一步在冷启动时是空转的**（容器端到端实测发现）：`refreshCatalogs()`
遍历的是 `this.byKey`（**已创建的 runtime**），而 runtime 是懒创建的 ——
新部署的 `byKey` 为空 → **一次都不抓** → 目录永远空 → 全部模型
`model_not_allowed`（400）。
所以 `refreshCatalogs()` 开头补一步「按凭据文件列表 `this.get(row.key)` 先把
runtime 建出来」。这与零自动探测同样不冲突：调用方只在请求路径上走到它。

### 三、`purchase_claim_released` 改为「换新 instanceId 重试」

官方语义（`orchestrator.js:208166-208177`）：

```
命中 → recovery.finish(attempt)                    // 结束失败尝试
     → releasePurchaseClaim()  = DELETE /session   // 删掉那条作废的 claim
     → host.forget(instanceId) + crypto.randomUUID()
     → 重试一次（rotated 保证只一次）
```

我们此前把它当"槽位忙"跳过（在 `SLOT_BUSY_CODES`）→ **永远卡在同一个作废 id 上**
（实测连续三个模型全部失败，含单价 0 的模型 → 证明卡的不是钱）。
现在在 `_admitUnlocked` 内部完成轮换，并把它从 `SLOT_BUSY_CODES` 移出。

### 四、429 错误体逐账号列出（修我上一版引入的误导）

上一版取"余额最小"的一份当代表 → 用户看到页面显示 A 号有 10 FB，
而错误体报的是 B 号的账（`balance 0 / dailyLimit 25`），于是"明明有钱却说额度不足"。
现在给 `accounts: [...]` 一一对应 failures，顶层平铺字段保留为兼容汇总。

## Alternatives considered

- **只补心跳、不管归一化顺序** —— 两个缺陷独立：心跳解决"买了被退款"，
  归一化解决"admission 拿不到句柄、直接 400"。少修任何一条都仍然不可用。
- **心跳也走普通形态（带时区、带 include-unused-rate-limits）** ——
  官方三元明确区分两者；普通形态会多拿一份额度快照，与官方不符。
- **在 `resolveModelAlias` 里 await 加载目录** —— 那是个同步函数（被多处
  同步调用），改成 async 会扩散到所有调用点。在 proxy 的 async 路径上提前
  加载，改动面最小且语义正确。
- **`purchase_claim_released` 继续当"槽位忙"跳过** —— 已被实测证伪：
  跳过 = 永远卡在作废 id 上，直到 expiresAt。
- **把 `session_superseded` 也改成换 ID 重试** —— 官方明确它是
  `endsTheSession: true`（`179517`）且**不走续用分支**（`isLapsedWindowGate`
  只含 `session_expired` / `waiting_room_required`），所以保持"结束会话"语义。

## Consequences

- **每个账号多一次 GET /session**（admit 成功后一次）；轮询本就是 GET，
  只是换了头形态，不增加请求数。
- **心跳可能失败**（网络抖动）：fire-and-forget + 只记日志，绝不影响 admit 返回。
- **`purchase_claim_released` 会多一次 DELETE + 一次 POST**（换 ID 重试），
  只发生一次。
- **429 响应体多了 `accounts` 数组**；顶层平铺字段仍保留（兼容既有消费方）。

## Evidence

- 真实 5 轮连跑（用户账号 `loli@woa.qzz.io`，25/25 额度）：
  **HTTP 200 ×5**，一条会话（`expiresAt 13:17`）撑住全部 5 轮。
- **容器端到端 5 轮**（最接近远程环境的验证，冷启动首个请求即发）：
  **HTTP 200 ×5**；日志里 `official channel: rpc result` ×5、
  `hold heartbeat sent` ×1、`freebuff session active` ×1、
  `superseded`/`refunded` **×0**。
- 关键机制逐项验证（本地日志）：
  - `x-freebuff-model: "fbm1.AAEAAUPrFd6jDLqK..."`（句柄，不再是可读名）
  - `hold heartbeat sent ... status: active`（此前 0 次）
  - 5 轮内**无** `session_superseded` / `refunded`（此前 admission 后 25 秒必现）
- 新增测试（`test/smoke.mjs`）：
  - `purchase_claim_released` 换 ID 重试 + **5 轮复用热 session**
  - 持有心跳：admit 后必发一次；轮询走心跳形态；普通刷新不得被替代
  - 反向探针实证可证伪：去掉 `_sendHoldHeartbeat` 调用 → 断言红
    （`admission 成功后必须立刻发一次持有心跳，got ["GET","POST"]`）；
    去掉换 ID（`instanceId = newRawInstanceId()`）→ 断言红
- 门禁：typecheck 过；`npm test` 全绿；`check:contract` / `check-config-consistency` 过。
- ⚠️ 真实 5 轮跑在**本地**（有 bun）。远程需升级后复测。
