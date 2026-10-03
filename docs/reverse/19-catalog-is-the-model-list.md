# 19 — 模型列表的唯一真源是「目录」，不是 session 回执

> 2026-10-03 第二轮抓包（`captures/2026-10-03-e2/`）。
> 起因：用户报「远程请求模型返回没有任何可用模型」，而账号额度是满的、未封禁。
> 本章全程**只观察客户端**，仅用掉 **1 次**主动请求做形态验证。

---

## 19.0 一句话结论

```
模型清单 = GET /api/v1/freebuff/models 的 rows（13 行，权威）
额度/单价 = GET /api/v1/freebuff/session 的 rateLimitsByModel / freebucks.prices（只挂元数据）
```

把模型清单建在 session 回执上，是本次「没有任何可用模型」的**根因**。

---

## 19.1 方法（可复现）

```bash
# 1) mitm（request 钩子：流式响应拿不到请求体，必须在 request 阶段读）
mitmdump -s tools/mitm-capture.py -p 8899 \
  --set confdir=~/.mitmfreebuff --set body_size_limit=1m

# 2) ⚠️ 两个坑，缺一抓不到
#    a. bun 子进程不认 Electron 的 --proxy-server，必须用环境变量
#    b. bun 不读 /etc/ssl/certs，只认 NODE_EXTRA_CA_CERTS → 否则
#       UNABLE_TO_VERIFY_LEAF_SIGNATURE，一个 codebuff 请求都抓不到
env HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899 \
    NODE_EXTRA_CA_CERTS=$HOME/.mitmfreebuff/mitmproxy-ca-cert.pem \
    ./Freebuff-0.0.156-linux-x86_64.AppImage \
    --remote-debugging-port=9333 --ignore-certificate-errors

# 3) 只操作 UI 触发请求（tools/cdp-ui.mjs），不发任何协议请求
node tools/cdp-ui.mjs click '.agent-trigger'   # 打开模型菜单 = 触发目录刷新
```

⚠️ **第三个坑**：客户端空闲一分钟会自动装 0.0.158 并重启，抓包窗口会被切断。
把 `~/.cache/@codebufffreebuff-desktop-updater/pending/*` 挪走即可挂住。

---

## 19.2 客户端怎么拿模型列表（抓包真值，77 条）

**整个抓包里 `/api/v1/freebuff/models` 只出现 1 次**，是登录后的第一个请求：

```http
GET /api/v1/freebuff/models
Authorization: Bearer <authToken>
x-freebuff-catalog-protocol: 1
x-freebuff-client: desktop
User-Agent: Bun/1.4.2
Accept: */*
```

**三个此前搞错的点**（都是我方多发 / 多要了东西）：

| 项 | 官方 | 我方改动前 | 判定 |
|---|---|---|---|
| `x-codebuff-api-key` | **全 165 条抓包 0 次** | catalog 请求带了 | ❌ 多余，删 |
| 设备签名三头 | catalog 那跳**没有**（签名从 session 才开始） | catalog 也签 | ❌ **不是"无害"——见 §19.9，它会让目录行数从 13 变成 53** |
| `install-id` / `first-tab-discount` / `multi-session` / `include-unused-rate-limits` | 都是 **session 那跳**的头 | catalog 也带 | ❌ 串台，删 |

**设备密钥的注册时机**（这才是签名的起点）：

```http
POST /api/v1/freebuff/device-keys
Authorization: Bearer <token>
Content-Type: application/json
{"publicKey":"<base64url raw Ed25519 32B>","client":"desktop"}
→ 200 {"keyId":"YP21Eug4HHmST2REeo2iBn"}
```

注册在 catalog **之后**、session **之前**。所以官方时序是
`catalog（无签名）→ device-keys → session（开始带签名三头）`。

---

## 19.3 目录响应结构（protocol 1）

```jsonc
{
  "protocol": 1,
  "version": "v0.g1.e82917.limited.5",   // 每次抓取递增
  "issuedAt": 1791026594122,
  "refreshAt": 1791028394122,            // 距 issuedAt 恒定 1800_000ms
  "recommendedKey": "m-00032eaeec",
  "fallbackKey": "m-00032eaeec",
  "plansUrl": "https://freebuff.com/plans",
  "fetchId": "fbf1.AAHc6mj4MPgjsBuZ...",
  "rows": [ /* 13 行，见下 */ ]
}
```

每行：

```jsonc
{
  "key": "m-096e75164d",
  "handle": "fbm1.AAEAAUPms5lB-oo0ipZ3...",  // 服务端签名，客户端不可伪造
  "displayName": "DeepSeek V4.1 Flash",
  "tagline": "Smart & Fast",
  "warning": "May use data for AI training",
  "badges": [{"kind":"test","label":"Experimental","tone":"warning"}],
  "multimodal": true,
  "premium": false,
  "dataUse": "service" | "training",
  "access": "open" | "locked",
  "lockedLabel": "Paid plan",
  "efforts": ["low","high","max"],
  "defaultEffort": "high",
  "reasoningEffort": "high",
  "contextWindow": 1048576,
  "compaction": {"cacheExpiryMs":900000,"cacheExpiryMinTokens":40000,"maxContextLength":400000},
  "sortOrder": 30,
  "legacyDigests": ["1e303ac563a6f9cc"]
}
```

⚠️ **`handle` 每次抓取都变**（`e82917` 那次的 handle 与 `e82918` 那次全 13 行都不同），
而 `key` / `displayName` / `legacyDigests` **稳定不变**。所以：

- `key` = 服务端身份，**可缓存**
- `handle` = 本次抓取的票据，**必须每次重抓**（这就是 `fetchId` 存在的理由）

---

## 19.4 13 行全量（2026-10-03 19:23 抓，UI 菜单逐项吻合）

| key | displayName | tagline | premium | access | efforts | ctx | 价格 FB/h |
|---|---|---|---|---|---|---|---|
| m-00032eaeec | MiMo 2.6 Flash | Balanced | – | open | – | – | 10 |
| m-7e20df6765 | GLM 5.3 Flash | Deep reasoning | – | open | low/high/max | 1M | 15 |
| m-096e75164d | DeepSeek V4.1 Flash | Smart & Fast | – | open | low/high/max | 1M | 15 |
| m-5a5d0e255e | GPT-6 Luna | Strong all-around | ✅ | locked | low/med/high/xhigh | 1M | 20 |
| m-cb71f819fe | MiMo 2.6 Pro | Strong reasoning | ✅ | locked | – | – | 30 |
| m-69307952f8 | Solar Mini 4 | Fast and light | – | open | – | 500K | 0 |
| m-9a7e098cc1 | Solar Pro 4 | Upstage flagship | – | open | – | 500K | 10 |
| m-22ff70c712 | Space Bunny Alpha | 1M context | – | open | 五档 | 1M | 0 |
| m-5dafce7f08 | Gemini 3.8 Flash | 1M context | ✅ | locked | high | 1M | 80 |
| m-ffcbc2bcf3 | Muse Spark 1.3 | Falls back when busy | ✅ | locked | low/med/high | 1M | 15 |
| m-6adcd6d671 | GPT-6.1 Sol | OpenAI flagship · Promotional | ✅ | locked | low/med/high | 1M | 100 |
| m-916b95b337 | Ling 3.1 Flash | Fast & free | – | open | – | 131072 | 2 |
| m-a273b5e513 | Laguna S 2.1 | Fast open coder | – | open | – | 131072 | 2 |

⚠️ **最后两行没有 `legacyDigests`** —— 上游新增的模型还没补 legacy id，
只能靠 `displayName` 寻址。这是「可读名必须当一等公民」的硬理由。

---

## 19.5 ❌ 根因：三张表不是一回事

同一次 session 响应里同时给了三张表，此前代码把**最小那张**当成了模型清单：

| 表 | 键数 | 含义 | 代码改动前用途 |
|---|---|---|---|
| `rows` | **13** | 模型清单（权威） | ❌ 只用来取 handle |
| `freebucks.prices` | **17** | 每模型单价 FB/h | ❌ 未用于列表 |
| `rateLimitsByModel` | **6** | **今日给了会话额度的子集** | ❌ **被当成模型清单** |

```
rateLimitsByModel:
  m-00032eaeec MiMo 2.6 Flash      limit 6  used 0
  m-096e75164d DeepSeek V4.1 Flash limit 6  used 0
  m-69307952f8 Solar Mini 4        limit 6  used 0
  m-9a7e098cc1 Solar Pro 4         limit 6  used 0
  m-22ff70c712 Space Bunny Alpha   limit 6  used 0
  m-7e20df6765 GLM 5.3 Flash       limit 0  used 0   ← 额度 0，照旧列出
```

`prices` 里还有 4 个 key（`m-0a6f9dd646` / `m-3b095d8b43` / `m-79033aedfe` /
`m-f8d6ac83f8`）**连目录里都没有** —— 它们是上游的隐藏/未开放条目。
所以「用 prices 当清单」也不对，会多出 4 个根本发不出去的模型。

**正确组合**：清单取 `rows`，额度挂 `rateLimitsByModel`，单价挂 `prices`。

### 次生根因 1：内置 catalog 是 2026-08 的快照

`src/catalog/freebuff-catalog.json`（`syncedAt: 2026-08-27`）拿 legacyDigests
反查今天的目录，**13 行只命中 3 行**：

```
✅ m-00032eaeec → mimo/mimo-v2.5               （名字已从 "MiMo 2.5" 变成 "MiMo 2.6 Flash"）
✅ m-7e20df6765 → z-ai/glm-5.3-flash
✅ m-096e75164d → deepseek/deepseek-v4-flash   （名字已变成 "DeepSeek V4.1 Flash"）
❌ 其余 10 行：内置表无此摘要
```

所以 `/v1/models` 给下游的是一份 2026-08 的**陈旧且半对不上**的名字表。

### 次生根因 2：探测只看一个账号

`/v1/models`（`proxy.js handleModels`）与 `/api/models/upstream`
（`api.js`）都走 `runtimes.getAny()` —— **只探测一个账号**。
而仓库里**已有** `probeAllAccountsSession()` 做逐账号并集（注释里明确写了
「只看一个号会漏」），就是没被这两个入口用上。

---

## 19.6 ✅ 1 次主动请求：我方形态验证（HTTP 200）

```bash
curl -H "Authorization: Bearer <token>" \
     -H "x-freebuff-catalog-protocol: 1" \
     -H "x-freebuff-client: desktop" \
     -H "User-Agent: Bun/1.4.2" -H "Accept: */*" \
     https://www.codebuff.com/api/v1/freebuff/models
```

| 项 | 客户端抓包 | 我方请求 | 一致 |
|---|---|---|---|
| HTTP | 200 | 200 | ✅ |
| 行数 | 13 | 13 | ✅ |
| key 集合 | — | — | ✅ |
| displayName | — | — | ✅ 全 13 行一致 |
| legacyDigests | — | — | ✅ 全一致 |
| version | `e82917` | `e82918` | ⚠️ 分钟级递增，正常 |
| **handle** | `fbm1.AAEAAUPm...` | `fbm1.AAEAAUPn...` | ⚠️ **预期内**：每次抓取全量轮换 |

**结论：形态正确，上游接受。** 且再次印证 19.3 的 `handle` 轮换规律 ——
**handle 不可跨抓取缓存**，只有 `key` / `displayName` 稳定。

---

## 19.7 落地改动（本次已做）

1. catalog 请求头对齐官方 4 项：删 `x-codebuff-api-key`、删串台的 session 头。
2. `CatalogHolder` 保存**目录行全量**（`displayName` / `premium` / `access` /
   `efforts` / `contextWindow` / `multimodal` / `tagline` / `sortOrder`），
   新增 `rows()` 出口。
3. 新增 `buildCatalogDrivenModelsResponse()`（model.js）：**以目录行为清单**，
   `id` = `displayName`（可读），`freebuff_key` 透出 `m-xxx`，额度/单价挂上去。
4. `/v1/models`、`/api/models`、`/api/models/upstream` 三个入口全部改目录驱动；
   多账号探测改用 `probeAllAccountsSession()` 并集。
5. 前端「同步上游模型」改按目录同步；`model.noneUpstream` 文案的触发条件
   改成「目录抓取失败」而非「列表为空」。

---

## 19.8 复现资产

| 文件 | 内容 |
|---|---|
| `captures/2026-10-03-e2/2026-10-03-official-client-e2.jsonl` | 77 条原始抓包 |
| `captures/2026-10-03-e2/catalog-official-client.json` | 客户端那份目录（13 行） |
| `captures/2026-10-03-e2/catalog-our-probe.json` | 我方 1 次请求那份（13 行） |
| `captures/2026-10-03-e2/session-official.json` | session 响应（三张表都在里面） |


---

## 19.9 ⚠️ 更正：catalog 带签名会让行数变成 53 —— 那不是真值

本节是**自我更正**。前几轮我报告"目录 53 行"并把它当真实清单写进了
note，那是错的。

### 事实

同一账号、相隔数秒的两次 catalog 请求：

| 请求方 | 是否带设备签名 | version | rows |
|---|---|---|---|
| 官方客户端（抓包） | **不带** | `v0.g1.e82917` | **13** |
| 我方 curl（那 1 次） | 不带 | `v0.g1.e82918` | **13** |
| 主服务（CatalogHolder） | **带** | `v0.g1.e82918` | **53** |

### 13 才是客户端口径

抓包里客户端的 13 行与**客户端 UI 模型菜单实测的 13 项逐项一致**
（`docs/reverse/13-client-ui-recon.md` §13.3 与本次 CDP 实测
`.agent-option` 两项均吻合）：

```
Solar Mini 4 / Space Bunny Alpha / Laguna S 2.1 / Ling 3.1 Flash /
MiMo 2.6 Flash / Solar Pro 4 / DeepSeek V4.1 Flash / GLM 5.3 Flash /
Muse Spark 1.3 / GPT-6 Luna / MiMo 2.6 Pro / Gemini 3.8 Flash / GPT-6.1 Sol
```

### 53 是怎么来的

`src/upstream/client.js` 给 `CatalogHolder` 的 `fetchImpl` 加了设备签名三头，
而客户端在这一跳不签（165 条抓包里，**只有 `/api/v1/freebuff/session` 带
签名**，13 次；`/models` 与 `/device-keys` 都不带）。

多带一个客户端没有的特征 → 上游返回了**另一份**目录。它不是"更全的
清单"，是我们形态偏离后换来的响应，**不能当真值**。

### 处置

- `CatalogHolder` 的 `fetchImpl` 已去掉签名，头集与客户端逐字节一致。
- 所有以 53 为判据的表述已更正（note 两处 + 本文档）。
- 教训：任何"我方拿到了更多/更好数据"的结果，第一反应应该是
  **怀疑自己的形态偏离了**，而不是当成收获。
