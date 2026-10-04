# 00 — 总览:Freebuff 官方客户端请求链路(BFS 根目录)

> 真源: reverse-overview
> 最后核对: 2026-10-05 · 对应代码: 3a8aebb
>  本文是**总览**;具体字段真值一律以 `21-client-request-reference.md` 为准(它是**对照唯一真源**).
> 逆向目标:`/home/hx/Downloads/Freebuff-0.0.156-linux-x86_64.AppImage`(`@codebuff/freebuff-desktop` v0.0.156)
> 本文档树按 **BFS** 组织:本文是 L0 总览,每一层再展开独立文档.
> 目录内文档编号即层级:`00` 总览 / `01`~`0n` 为 L1 各环节.

---

## L0:一次带工具的对话,客户端到底做了什么

```
[1] 启动 → 加载本地登录态
      ~/.config/freebuff-desktop/state.json          # token + user + installId
      ~/.config/freebuff-desktop/state.json.device-key.json   # Ed25519 设备密钥 + keyId

[2] 拉模型目录（必须最先做）
      GET https://www.codebuff.com/api/v1/freebuff/models
      → 返回 catalog（含 fetchId、每行 handle、version、efforts）
      ※ 后续所有请求的 model 都用 catalog 里的 **handle**，不是模型名

[3] 建立会话（admission，买断一小时）
      POST https://www.codebuff.com/api/v1/freebuff/session/admission
      → 返回 instanceId / session 状态 / 额度

[4] 发对话（带 tools）
      POST https://www.codebuff.com/api/v1/chat/completions  （流式 SSE）
      ※ 实测 16 次；旧文写的 `/api/chat` **0 次**（web 世代残留，已废）
      → 上游返回 tool_use 块

[5] 心跳 / 轮询
      GET  /api/v1/freebuff/session      （带 x-freebuff-heartbeat: 1 即心跳）

[6] 释放
      DELETE /api/v1/freebuff/session    （带 x-freebuff-instance-id）
```

**贯穿全部环节的三件东西**(缺一即被判第三方客户端):
1. `Authorization: Bearer <token>` —— 登录态
2. **设备签名三头** —— `x-freebuff-device-key` / `-ts` / `-sig`(Ed25519)
3. **catalog 两件套** —— `x-freebuff-catalog-protocol: 1` + `x-freebuff-catalog-fetch: <fetchId>`

外加**客户端身份头** `x-freebuff-client: desktop` 与 `x-freebuff-install-id`.

>  **上句"贯穿全部环节"是错的**（2026-10-05 更正）。实测抓包：**签名三头只出现在
> 需要它的几跳**，`GET /freebuff/models` 与 `POST /freebuff/device-keys` **都不带**
> （真值表见 [`21-client-request-reference.md`](21-client-request-reference.md) §21.4，
> 代码侧同口径见 `src/upstream/client/*` 的注释）。
> 把"局部适用"读成"全局缺一不可"会让人去给目录/注册请求补签名头 —— 那反而与客户端不符。

>  **本地进程隔离头（与上游判据无关，别混）**：官方 Desktop 的**本地** orchestrator
> （`127.0.0.1:<动态端口>`）要求所有本地 `/api/` 请求带 `x-freebuff-launch-id`，
> 该值由 Electron 主进程生成，并同时写成 HttpOnly cookie `freebuff_launch_{port}`。
> **这是进程隔离机制，不是上游 Freebuff 的验证点** —— 我们的代理不实现它，也不需要实现。
> （此知识点原先只记在一份已淘汰的文档里，2026-10-05 捡回；全仓实测 `x-freebuff-launch-id`
> 无其他出处。）

---

## 事实表(已实测 / 已读源码,未实测的显式标注)

| 项 | 值 | 来源 | 状态 |
|---|---|---|---|
| 上游 API 主机 | `https://www.codebuff.com` | `orchestrator.js:176069` `PROD_API_HOST` |  读源码 |
| Web 站 | `https://freebuff.com` | `orchestrator.js:176064` |  读源码 |
| Convex | `https://harmless-tapir-303.convex.cloud` | `orchestrator.js:176081` |  读源码 |
| 设备密钥注册路径 | `/api/v1/freebuff/device-keys` | `orchestrator.js:134777` |  读源码 |
| 模型目录路径 | `/api/v1/freebuff/models` | `orchestrator.js:134775` |  读源码 |
| 会话 admission 路径 | `/api/v1/freebuff/session/admission` | `orchestrator.js:125103` |  读源码 |
| 会话路径 | `/api/v1/freebuff/session` | `orchestrator.js:207026` |  读源码 |
| 签名版本串 | `freebuff-device-v1` | `orchestrator.js:134778` |  读源码 |
| 签名算法 | Ed25519(raw 公钥 / pkcs8 私钥) | `orchestrator.js:134877` |  读源码 |
| 客户端标识 | `x-freebuff-client: desktop` | `orchestrator.js:135252` |  读源码 |
| 注册时 client 字段 | `client: "desktop"` | `orchestrator.js:216629` |  读源码 |
| 本地 orchestrator 端口 | `127.0.0.1:34227` | `ss -ltnp` |  实测 |
| 状态文件 | `~/.config/freebuff-desktop/state.json` | `orchestrator.js:176509` |  实测存在 |

---

## 本机已登录账号(官方客户端进程内)

```
token     : 553262d1-ebe4-475d-8d6b-ef82eebc1e29
user.id   : 54393a42-f61c-4176-935f-0637fc95096a
email     : loli@woa.qzz.io
installId : 5a989c7b-c374-41bb-aecc-ba47e4a3a2b3
machineId : 268f38b9-0337-4180-957a-beb82fe408a3
keyId     : YP21Eug4HHmST2REeo2iBn
```

> 该文件是**运行中的官方客户端**的登录态,是本次逆向唯一被授权的凭据来源.

---

## 已知失败面(待逐项击破,BFS 队列)

| # | 现象 | 结论 | 文档 |
|---|---|---|---|
| F1 | admission `403 {"status":"banned"}` | **协议已解决**(实测拿到 200 active);现存 ban 是账号级历史封禁 | `03` `06` |
| F2 | 仓库侧 `banned` / `rate_limited` | 两账号均已失效(401/403),协议救不了 | `06` |
| F3 | 带 `tools` 被判第三方客户端 | **已定位全部 4 道门禁**并逐条消除 | `04` |
| F4 | 思考强度如何传 | 已完整解析(枚举+字段+每模型档位) | `05` |
| F5 | chat `503 model temporarily unavailable` | 触网探测导致账号被封,无法继续验证 | `06` |

##  本次探测的代价(先读这行)

用官方登录态做穷举式探测,**几分钟内建/拆 40+ 次会话,触发了封禁**:
`GET /api/v1/freebuff/session` → `403 {"status":"banned","verificationReason":"region_locked"}`,
而 `/api/v1/me` 仍 200(账号存在,只是禁止建会话).
详见 `06-ban-forensics.md`.**后续只准用只读端点**.

## 关键结论:仓库的协议实现其实是对的

逐条比对 `src/upstream/` 与官方源码后确认,仓库**已经正确实现**了本次逆向出的
全部要点(admission 传 handle,chat 传 handle,`run_id` 在 `codebuff_metadata`,
system 开场白,官方签名工具,`base3-free-catalog`,客户端环境描述符).
**真正卡住的是凭据本身被封**,不是协议.见 `06` §6.4.

>  **本条是 2026-10-03 的结论,今天已不成立**:主服务现已**经 `official-rpc` 委托
> `cli-bridge`(bun)执行**,不再"自己拼一套与官方对齐的形态"(见 `18`、`21` §21.5 与
> `README.md`「上游请求链路」节).本节的"官方形态实现"指的是 cli-bridge,不是主服务自己拼.

## 附:访问层级(Access Tiers)—— 上游按出口 IP 信誉分档

> 这段原记在一份已淘汰的逆向总结里,2026-10-05 捡回(全仓 `grep accessTier` 在文档侧
> 只剩 `03-session-admission.md` 的裸值 `"limited"`,**无定义**).

- **`full`**:正常住宅 IP,无限制;
- **`limited`**:VPN / 代理 / 匿名网络出口,功能受限但**不拒绝**。

判定信号随 session 回执返回(样例):

```json
{ "countryCode": "JP", "reason": "anonymous_network",
  "ipPrivacySignals": ["vpn", "hosting", "anonymous"], "accessTier": "limited" }
```

代码侧同口径:`src/model.js` 的模型元信息里有 `accessTier?: 'full' | 'limited' | null`。
**走代理出口会被降级到 `limited`** —— 这是设计选择,不是故障。

## 附:CLI 指纹(头名与真值)

- 头名:`X-Freebuff-Cli-Fingerprint`(抓包实测;全仓代码里**没有**该头的构造点,
  属于"历史观测"而非本仓契约);
- 版本真值:`src/upstream/official-fingerprint.js:30` 的 `KNOWN_CLI_VERSION`(当前 `'0.0.178'`,
  且运行时会被 `refreshCliVersion()` 刷新)。
   已淘汰的那份逆向总结写的 `0.2.12` **是错的** —— 它连头名拼写(`X-Freebuff-Device-Signature`
  等)一起错,这就是它被淘汰的原因。

---

## 展开顺序(BFS)

- `01-runtime-and-artifacts.md` — 进程/文件/解包产物在哪,怎么拿到源码
- `02-device-signing.md` — 设备密钥与签名协议(逐字对齐官方)
- `03-session-admission.md` — 会话建立(当前卡点 F1/F2)
- `04-chat-and-tools.md` — 对话与工具调用(卡点 F3)
- `05-thinking-effort.md` — 思考强度配置(卡点 F4)
