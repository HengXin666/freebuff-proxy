# Agent Note: 「凭证失效」误报的三处链路缺口（设备签名缺席 / 时区头缺失 / 401 静默重打）

Status: implemented

## Problem

用户提交一份**确认可用**的凭据（id `6199d6e9-…`，邮箱 `llh282000500@gmail.com`），
控制台检测显示「凭证失效」。用户判断"账号绝对可用，是 API 或请求链路有问题"——
这个判断是对的，但真因不止一处，且有一处是**我们自己的凭据没落盘**。

只读盘查实（本轮未发任何上游请求），共四条相互独立的成因：

### 成因 1：磁盘上的凭据是旧值（用户侧可自查，但接口无法自证）

`data/credentials/6199d6e9-….json` 里 `authToken` 是 `73a96d08-…`、
`fingerprintHash` 是 `e52edbcc-…`，与用户提交的新值**均不一致**。旧 token
已被上游轮换，打上游必然 401，而 `probeReason()` 把 `auth_unauthorized`
直译成「凭证失效」——**提示是对的，被探测的对象是错的**。

又因 `data/credentials/` 里 `6199d6e9…` 与 `91c61f1e…`（官方桌面客户端当前
登录态）**邮箱相同**，账号表两行长得一模一样，用户在控制台上无法确认自己
点的是哪一行。

而导入接口只回 `{ok:true, account, key}`，**不回显任何落盘证据**，
用户没有任何办法判断"到底写进去没有"。

### 成因 2：设备密钥从未落到账号名下（链路真缺陷）

`data/device-keys/` 30 个文件全是调试残留（`a.json` / `probe-401.json` /
`fake-401.json` …），**唯独没有两个在用账号的密钥文件**。

后果链：`buildRpcCfg()` 读 `data/device-keys/<key>.json` → 读不到 →
`keyId = null` → bun 侧 `signHeaders()` 返回 `{}` → session GET **不带设备
签名**发出。

而抓包真值（docs/reverse/21 §21.3、§21.2）：全 165 条里**只有
`/api/v1/freebuff/session` 带签名**（13 次），`/models` 与 `/device-keys`
反而不带。也就是说我们恰好在**唯一的必签端点**上裸奔。

官方客户端已注册的那份密钥就在 `~/.config/freebuff-desktop/
state.json.device-key.json`，`registrations` 里明摆着
`https://www.codebuff.com user:91c61f1e-…` → `YP21Eug4HHmST2REeo2iBn`
——代码从不读它。

### 成因 3：bun 侧 session GET 漏了 `x-fb-timezone`

`cli-bridge/upstream.mjs` 的 `admit()` 在补 `x-fb-timezone`（443 行），
`getSession()` 没补。客户端真值（21 文档 §21.3）GET /session 带此头。
这是"客户端有而我们没有"的**缺失项**，不是多余项。

### 成因 4：401 被打两次且真因被掩盖

`makeSessionViaBun` 在 `r?.ok === false` 时一律 `return null` → 静默回落
Node 实现 → 再发一次 → 再吃一个 401 → 才抛 `auth_unauthorized`。
一次「检测」= 上游收到**两次** 401，且日志只留 Node 那一跳，
bun 那跳的关键字段被吞掉。

docs/reverse/21 §21.5 自己写着「通道接上 ≠ 通道生效，失败会静默回落」——
这是同一条纪律在 401 路径上的复现。

## Decision

**四条分别修，各自独立成立、独立可验证。**

### 一、`buildRpcCfg()` 兜底复用官方客户端已注册的 keyId（改 `official-rpc.js`）

账号自己的密钥未注册时，读 `~/.config/freebuff-desktop/
state.json.device-key.json`，按**同一个 scope 格式**（`<host> user:<userId>`）
取 keyId + 私钥。scope 格式与本项目约定一致，因此可逐字复用，
**无需再发一次 device-keys 注册请求**。

只在账号自己那份未注册时兜底：账号自己的密钥一旦注册成功即优先，
绝不拿别人的 keyId 覆盖自己的。

⚠️ **兜底块必须写在读主密钥的 `try` 之外。** 第一版写在 `try` 内 ——
主密钥文件不存在时 `readFile` 直接抛，整个兜底被 `catch` 跳过，
实测 keyId 仍为 null，等于没写。这正是 §21.5 那条教训的复现：
**兜底自己失败时也要看得见，绝不与主路径共用同一个 catch。**

### 二、`getSession()` 补 `x-fb-timezone`（改 `cli-bridge/upstream.mjs`）

与 `admit()` 同源取值：`cfg.timeZone` → `Intl` 解析 → `'UTC'`。

### 三、bun 通道 401 不再静默回落（改 `upstream/client.js`）

`r.status === 401` 时**直接抛** `UpstreamError(code:'auth_unauthorized')`，
不再 `return null`。401 语义确定（上游不认这个 token），换运行时重试不会
改变它，只会多制造一次被拒记录。

`cause` 标注本次 `cfg.keyId` 是否存在（`signed` / `unsigned`）——
它是 401 的第一分流判据：**签名齐全仍 401 = token 真坏；
没签名就 401 = 先查设备密钥注册**。

其余失败（网络 / bun 挂了 / 非 401）保持回落 Node：可用性优先。

### 四、导入与查看接口回显落盘证据（改 `web/api.js`）

`POST /api/accounts/import` 与 `GET /api/accounts/:key/credential` 各回显三样
**都不暴露完整 token** 的证据：

- `path`：写到哪个文件（多 id 同邮箱时尤其关键）
- `tokenFingerprint`：落盘 token 的 sha256 前 12 位
- `tokenTail`：末 6 位

用户一比即可定案：不一致 = 这次导入没生效（或被别处覆盖）；
一致 = token 本身被上游吊销。

## Alternatives considered

- **什么都不做（让用户自己删掉旧凭据重导）** —— 能解成因 1，但成因 2/3/4
  依旧在：设备签名仍缺席（唯一必签端点仍裸奔）、401 仍被打两次、
  下次换号还会以同样的「凭证失效」形态复现。用户报的是"链路有问题"，
  只修数据不修链路等于没修。
- **让主服务重新注册设备密钥（发一次 POST /device-keys）** —— 功能上可行，
  但那是**上游写操作**：本轮用户明确要求不发送请求，且注册本身也是
  "客户端在某时才做的事"。复用官方已注册的 keyId 是**纯本地读**，
  零上游流量、零额度消耗，风险更低。将来若要支持全新账号，
  再走惰性注册（现在 `DeviceSigner` 已实现惰性注册）。
- **把官方客户端密钥文件整份复制进 `data/device-keys/`** —— 也能生效，
  但会把别人的私钥**落盘到项目数据目录**（多一份明文私钥副本，
  且混淆了"哪些注册是我们的"）。只读引用官方原文件、
  仅在运行时取出 keyId/私钥，不产生第二份落盘副本。
- **把 401 也加进 `ACCOUNT_LEVEL_SESSION_STATUSES` 走冷却换号** ——
  语义错：401 是凭据失效，换号不会恢复（换的是另一个号）。
  同 [2026-10-04-log-account-context-and-401-normalization.md](
  ./2026-10-04-log-account-context-and-401-normalization.md) 的裁决。
- **回显完整 token 方便比对** —— 凭据会进日志与响应体，等于泄露。
  短指纹 + 末 6 位足以定案，不足以复用。

## Consequences

- **兜底引入一个只读文件路径依赖**：官方客户端未安装时
  `readOfficialDeviceKey()` 返回 null（best-effort），行为与修前一致（不签名）。
  Docker 部署下 `homedir()` 通常是 `/root`，无此文件 → 兜底不生效，
  回落到既有惰性注册路径。
- **401 不再双发**：账号侧看到的被拒次数减半；控制台「检测」
  的单次语义变准（此前一次点击 = 两次上游 401）。
- **导入接口响应体变大**（多 3 个字段）。不含完整 token，
  日志/响应体均无凭据泄露风险。
- **`cause: 'unsigned'` 是新字段**：它只在 401 上出现，
  不在任何按 code 匹配的集合里（`SLOT_BUSY_CODES` /
  `UNAVAILABLE_COOLDOWN_CODES` / `EXHAUST_CODES`），不会误命中既有判据。
- **本次同步落盘了用户的新 token**（旧文件留 `.bak-20261004`）。

## Evidence

- 凭据不一致（只读盘）：文件 `authToken=73a96d08-…` vs 用户提交
  `3adf3e8e-…`；`fingerprintHash=e52edbcc-…` vs `abd67087-…`。
- 设备密钥缺席（只读盘）：`ls data/device-keys/` 30 项，
  无 `6199d6e9*.json`、无 `91c61f1e*.json`；官方客户端文件内含
  `https://www.codebuff.com user:91c61f1e-…` → `YP21Eug4HHmST2REeo2iBn`。
- 修后 `buildRpcCfg()` 实测：`91c61f1e…` → `keyId=YP21Eug4HHmST2REeo2iBn`；
  `8fe4e4e0…` → 同上；`6199d6e9…` → `null`（官方客户端未注册过该号，符合预期）。
- 私钥可用性实测：兜底取到的私钥能被 `createPrivateKey({format:'der',
  type:'pkcs8'})` 导入并完成 Ed25519 签名（6 行载荷，签名 86 字符 base64url）。
- 门禁：`npm run typecheck` 通过；`npm test` smoke ok + 目录验证 13 条通过；
  `npm run check:contract` 通过（7 端点 / 19 头，无裸字面量、无废弃头回潮）。
- 本轮**未发送任何上游请求**（用户明确要求）。
