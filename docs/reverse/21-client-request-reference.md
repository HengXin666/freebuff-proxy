# 21 — 客户端请求全表：用途 · 顺序 · 头集（对照专用）

> **本文件是对照的唯一真源。** 判断"我方某个请求是否与客户端一致"，
> 一律以此为准 —— **不要只看代码**（代码写的头 ≠ 实际发出的头，见 §21.7）。
>
> 数据来源：两次 mitm 抓包共 **165 条**（`captures/2026-10-03-official-client.jsonl`
> 88 条 + `captures/2026-10-03-e2/...-e2.jsonl` 77 条）。
> 抓取方法见 `19` §19.1。

---

## 21.1 端点总表

| # | Method | Path | 总次数 | 用途 | 是否必需 |
|---|---|---|---|---|---|
| 1 | GET | `/api/v1/freebuff/models` | 1 | **取模型目录**（13 行 + `fetchId` + 句柄） | ✅ 必需 |
| 2 | POST | `/api/v1/freebuff/device-keys` | 1 | 注册 Ed25519 设备公钥 → 拿 `keyId` | ✅ 必需（签名前置） |
| 3 | GET | `/api/v1/freebuff/session` | 17 | 查会话状态 / 额度 / 单价 | ✅ 必需（只读） |
| 4 | POST | `/api/v1/freebuff/session/admission` | 3 | **建会话**（买断一小时） | ✅ 必需 |
| 5 | DELETE | `/api/v1/freebuff/session` | 2 | 释放会话（退槽位） | ✅ 必需 |
| 6 | POST | `/api/v1/agent-runs` | 6 | START / FINISH（desktop 世代 agentId） | ✅ 必需 |
| 7 | POST | `/api/v1/chat/completions` | 8 | **真正的对话**（唯一 chat 端点） | ✅ 必需 |
| 8 | GET | `/api/v1/ads/policy` | 1 | 广告策略 | ⚪ 可免 |
| 9 | GET | `/api/v1/ads/proposal` | 5 | 广告位 | ⚪ 可免 |
| 10 | POST | `/api/v1/ads` | 1 | 广告上报 | ⚪ 可免 |
| 11 | POST | `/api/v1/ads/impression` | 9 | 广告曝光（**其中 7 次 404**） | ⚪ 可免 |
| 12 | POST | `/api/ads` | 2 | 广告（另一 origin 路径） | ⚪ 可免 |
| 13 | POST | `/api/logs` | 7 | 遥测 | ⚪ 可免 |
| 14 | GET | `/api/v1/project-profile` | 1 | 项目画像 | ⚪ 可免 |
| 15 | HEAD | `/` | 18 | 连通性探测 | ⚪ 可免 |

**客户端从未发过的端点**（我方曾误用，已删）：
`GET /api/v1/me`（0 次）、`POST /api/chat/stream`（0 次，web 世代残留）。

---

## 21.2 请求顺序（冷启动 → 登录 → 建会话 → 对话 → 释放）

### 阶段 A：冷启动（第二次抓包，真实时序）

```
[1] GET  /api/v1/freebuff/models          ← 第一个请求，取目录与 fetchId
[2] POST /api/v1/freebuff/device-keys     ← 注册设备公钥（拿到 keyId 后才能签名）
[3] GET  /api/v1/ads/policy
[4] GET  /api/v1/freebuff/session         ← 查当前会话（此时 status: none）
    …（广告曝光 404 ×7、广告位、logs、HEAD / 穿插）
[5] DELETE /api/v1/freebuff/session       ← 释放（清理上一次残留）
```

⚠️ **顺序铁律**：`models` **先于** `device-keys`，`device-keys` **先于** 任何带签名的请求。
因为签名需要 `keyId`，而 `keyId` 来自 `device-keys`；`catalog-fetch` 需要 `fetchId`，
而 `fetchId` 来自 `models`。

### 阶段 B：一次带工具的对话（第一次抓包，真实时序）

```
[1] HEAD /
[2] GET  /api/v1/freebuff/session                 ← 查有无活跃会话
[3] GET  /api/v1/freebuff/session
[4] GET  /api/v1/freebuff/session
[5] POST /api/v1/freebuff/session/admission       ← 没有 → 建会话（买断 1 小时）
[6] POST /api/logs
[7] POST /api/v1/agent-runs        {"action":"START","agentId":"freebuff-desktop-autorun"}
[8] POST /api/v1/chat/completions                 ← manager 层（tools: [decide]）
[9] HEAD /  + GET /api/v1/freebuff/session        ← 心跳
[10] POST /api/v1/chat/completions                ← manager 第 2 轮
[11] POST /api/v1/agent-runs                      ← START worker
[12] POST /api/v1/freebuff/session/admission      ← 换模型时重新 admission
[13] POST /api/v1/agent-runs
[14] POST /api/v1/chat/completions                ← worker 层（37 工具）★ 真正干活
[15] POST /api/logs
[16] …worker 多轮 chat（每轮 llm_step_number 递增）…
[17] POST /api/v1/agent-runs       {"action":"FINISH", ...}   ← 收尾（我们目前缺）
[18] GET /api/v1/project-profile
[19] HEAD /  + GET /api/v1/freebuff/session
```

**关键观察**：
- 一次用户消息 = **manager 决策** + **worker 执行** 两层 chat。
- `admission` 在建会话时发一次；**换模型会再发一次**。
- 多轮 worker chat 之间只穿插 `HEAD /`、`session` 心跳、`logs`、广告。
- 最后必须 `FINISH`，否则 run 在上游悬挂。

---

## 21.3 各端点真实请求头（逐项真值）

去掉 `Host` / `Content-Length`；`Connection: keep-alive`、`User-Agent`、
`Accept: */*`、`Accept-Encoding: gzip, deflate, br, zstd` 是 bun 裸 fetch 的
恒定四件套，**每个请求都有**，下面不再重复列出。

### ① GET /api/v1/freebuff/models（**无签名**）

```
Authorization: Bearer <token>
x-freebuff-catalog-protocol: 1
x-freebuff-client: desktop
```

⚠️ **不带设备签名**。全 165 条里只有 `/api/v1/freebuff/session` 带签名（13 次）。
带了会让目录行数从 13 变 53（`19` §19.9）。
body：无。

### ② POST /api/v1/freebuff/device-keys（**无签名**）

```
Authorization: Bearer <token>
Content-Type: application/json
```
body：`{"publicKey":"<base64url raw Ed25519 32B>","client":"desktop"}`
→ 200 `{"keyId":"YP21Eug4HHmST2REeo2iBn"}`

### ③ GET /api/v1/freebuff/session（**带签名**）

```
Authorization: Bearer <token>
x-fb-timezone: Asia/Shanghai
x-freebuff-catalog-fetch: <fetchId>
x-freebuff-catalog-protocol: 1
x-freebuff-client: desktop
x-freebuff-device-key: <keyId>
x-freebuff-device-sig: <base64url Ed25519>
x-freebuff-device-ts: <ms>
x-freebuff-first-tab-discount: 0
x-freebuff-include-unused-rate-limits: 1
x-freebuff-install-id: <uuid>
x-freebuff-multi-session: 1
```

### ④ POST /api/v1/freebuff/session/admission（**带签名**）

在 ③ 的基础上**增加**：

```
x-freebuff-desktop-attempt-id: <uuid>      ← 每次购买尝试独立生成
x-freebuff-instance-id: <裸 uuid>          ← 整场复用，同一值
x-freebuff-model: <fbm1.句柄>              ← ⚠️ 必须是句柄，不是模型名/key
x-freebuff-purchase-continuity: 1
x-freebuff-wallet-spend-limit: 0
```

### ⑤ DELETE /api/v1/freebuff/session（**带签名**）

```
Authorization: Bearer <token>
x-freebuff-catalog-fetch: <fetchId>
x-freebuff-device-key / -sig / -ts
x-freebuff-instance-id: <uuid>             ← ⚠️ 必带，否则上游 400 instance_required
x-freebuff-multi-session: 1
x-freebuff-purchase-continuity: 1
```

### ⑥ POST /api/v1/agent-runs（**只有 3 个业务头**）

```
Authorization: Bearer <token>
x-freebuff-acting-user-id: <userId>
Content-Type: application/json
```

⚠️ **没有** `x-codebuff-api-key`、**没有** catalog 头、**没有** 设备签名。
body：`{"action":"START","agentId":"freebuff-desktop-autorun","ancestorRunIds":[]}`
worker 层 agentId：`freebuff-desktop-thread-local-v3`

### ⑦ POST /api/v1/chat/completions（**8 个业务头**）

```
Authorization: Bearer <token>
Content-Type: application/json
User-Agent: ai-sdk/openai-compatible/0.0.0-test/codebuff
            ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2     ← 三段，非 Bun/1.4.2
x-freebuff-acting-user-id: <userId>
x-freebuff-catalog-fetch: <fetchId>        ← ⚠️ 只有 -fetch，没有 -protocol
x-freebuff-device-key / -sig / -ts
```

body 顶层恒为 7 键：`model` / `codebuff_metadata` / `provider` / `messages` /
`tools` / `tool_choice` / `stream`。
- `model` = **句柄**（`fbm1.xxx`）
- `run_id` 在 `codebuff_metadata` 里（顶层传必 400）
- `reasoning_effort` 也在 `codebuff_metadata.freebuff_reasoning_effort`（仅 worker 层）
- `stream` 恒 `true`
- manager 层 `provider: {"allow_fallbacks":true}` + `tools:[decide]`
- worker 层 `provider: {"data_collection":"deny"}` + 37 个官方工具

---

## 21.4 设备签名三头的适用面（易错）

| 端点 | 签名 |
|---|---|
| `GET /models` | ❌ 不带 |
| `POST /device-keys` | ❌ 不带 |
| `GET /session` | ✅ 带 |
| `POST /session/admission` | ✅ 带 |
| `DELETE /session` | ✅ 带 |
| `POST /agent-runs` | ❌ 不带 |
| `POST /chat/completions` | ✅ 带 |

签名载荷（官方 `freebuffDeviceSignaturePayload`）：

```
freebuff-device-v1
<METHOD 大写>
<path>
<timestampMs>
<sha256(body) hex>
<fetchId 或空串>
```
六行 `\n` 分隔，Ed25519，base64url。

---

## 21.5 我们当前的对齐状态（截至 2026-10-03）

| 端点 | 状态 | 说明 |
|---|---|---|
| `GET /models` | ✅ **一致** | 走 bun 通道，逐字节相同（`19` §19.10 / note `...catalog-request-via-bun`） |
| `POST /device-keys` | ⚠️ 部分 | 头集/UA/`client:"desktop"` 已对齐；仍走 Node → 多 `accept-language` / `sec-fetch-mode` |
| `GET /session` | ⚠️ 部分 | 头集已对齐（见下）；仍走 Node → 同上两个头 + `accept-encoding` 缺 br/zstd |
| `POST /admission` | ✅ 已对齐 | P0 项，见 `15` |
| `DELETE /session` | ✅ 头集一致 | 与 GET 同源构造；同样受 Node 两个头影响 |

### 2026-10-03 本轮 session / device-keys 的头集修正（对照发现）

用本地镜像抓我方实际发出后，与 `§21.3` 真值逐项 diff：

| 项 | 我方（改前） | 客户端 | 处置 |
|---|---|---|---|
| `x-freebuff-env` | 发（CLI 源码来的） | **0 次** | ❌ 删除 |
| `x-freebuff-compact-session` | 发 | **0 次** | ❌ 停发 |
| `x-freebuff-client` | **缺** | desktop | ✅ 补 |
| `x-freebuff-install-id` | **缺** | 有 | ✅ 补（读登录态 installId） |
| `x-freebuff-include-unused-rate-limits` | 仅在有 instanceId 时发 | 查询形态恒带 | ✅ 改为 GET 恒带 |
| `User-Agent` | `Bun/1.3.14` / `node` | `Bun/1.4.2` | ✅ 改（device-keys 也补了 UA/编码） |

**剩余 3 项属 Node 运行时差异，只能靠 bun 消除**（已做决定性对照实验）：

```
Node 26   → accept-language: * / sec-fetch-mode: cors（forbidden，设不掉）
            UA=node、accept-encoding 缺 br,zstd
Bun 1.4.2 → 只发指定头 + connection/UA=Bun/1.4.2/accept/accept-encoding(含 br,zstd)
```

即：`sec-fetch-mode: cors` 在 Node 下**无解**（显式设空串仍为 cors）。
要彻底一致，session / device-keys 也须改走 bun 通道（catalog 已如此）。
| `POST /agent-runs` | ✅ 已对齐 | 3 个业务头 + desktop 世代 agentId |
| `POST /chat/completions` | ✅ 已对齐 | 8 个业务头，实测 200 + 工具调用（`16`） |

---

## 21.6 抓包复现方法

```bash
# 1) mitm（request 钩子：流式响应拿不到请求体）
mitmdump -s tools/mitm-capture.py -p 8899 \
  --set confdir=~/.mitmfreebuff --set body_size_limit=1m

# 2) 三个必须注意的点
#    a. bun 子进程不认 Electron 的 --proxy-server → 必须用环境变量
#    b. bun 不读 /etc/ssl/certs → 必须给 NODE_EXTRA_CA_CERTS，否则
#       UNABLE_TO_VERIFY_LEAF_SIGNATURE，一条都抓不到
#    c. 客户端空闲 1 分钟会自动装新版重启 → 把
#       ~/.cache/@codebufffreebuff-desktop-updater/pending/* 挪走挂住
env HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899 \
    NODE_EXTRA_CA_CERTS=$HOME/.mitmfreebuff/mitmproxy-ca-cert.pem \
    ./Freebuff-0.0.156-linux-x86_64.AppImage \
    --remote-debugging-port=9333 --ignore-certificate-errors

# 3) 只操作 UI 触发（不发协议请求）
node tools/cdp-ui.mjs click '.agent-trigger'    # 打开模型菜单 → 触发目录刷新
node tools/cdp-ui.mjs send  '.composer-input' '<文本>'
```

---

## 21.7 ⚠️ 方法铁律：代码写的头 ≠ 实际发出的头

判断"是否一致"**必须抓真实报文**。做法：起一个本地镜像，
把 `config.yaml` 的 `api_base` 指向它，打印收到的原始头。

```bash
# 镜像（HTTP 即可，排除 TLS 干扰）
node /tmp/mirror.mjs        # listen 9544，打印 req.headers
# config.yaml: api_base: http://127.0.0.1:9544
```

实测发现的两类坑：

1. **Node 26 内置 fetch 自动加头**（bun 不会）：
   `accept-language: *`（可设空消除）、`sec-fetch-mode: cors`
   （**forbidden header，设不掉**）。→ catalog 因此改走 bun。
2. **配置文件默认读 `./config.yaml`（仓库根）**，不是 `data/config.yaml`
   —— 改错过一次，导致镜像没收到任何请求。

**UA 也要核**：客户端实测 `Bun/1.4.2`；我们 Node 路径曾发 `Bun/1.3.14`。
