# Agent Note: 目录协议(catalog protocol)—— 服务端可验证的模型身份

Status: implemented

## Problem

官方 CLI 的 `x-freebuff-catalog-protocol` / `x-freebuff-catalog-fetch` 两个头,
我们一个都没有.官方对它的注释直接点明它是**开关**:

> Sent on every catalog-aware request (`GET /api/v1/freebuff/models`, the session
> endpoints). **Its presence is what tells the session endpoints to answer with
> catalog keys instead of model ids.**

没有它,服务端只能把请求当 **legacy 客户端**处理.

同一轮抓包还暴露了配套差异:官方 chat 的 `model` 字段**不是**
`deepseek/deepseek-v4-flash`,而是 `fbm1.AAEAAUPe2Us...` 这样的**句柄** ——
由 `GET /api/v1/freebuff/models` 签发,服务端签名,客户端造不出来.

## Decision

**实现目录协议(`src/upstream/catalog-protocol.ts`):抓一次目录,缓存
`fetchId` 与 `id → 句柄` 映射,并在每个请求上带这两个头.**

抓取实测响应结构(字段名与文档直觉不符,值得记下):

```json
{ "protocol": 1, "version": "v0.g1.e82909.limited.5",
  "fetchId": "fbf1.AAGZWM32cR3rz9Ux042...",
  "recommendedKey": "m-00032eaeec",
  "fallbackKey": "m-00032eaeec",
  "rows": [ { "key": "m-00032eaeec", "handle": "fbm1.AAEAAUPe2Us...",
              "displayName": "MiMo 2.6 Flash", ... } ] }
```

- 行数组叫 **`rows`**(不是 `models` / `data`);
- 行内标识是 **`key`**(`m-` 前缀)与 **`handle`**(`fbm1.` 前缀);
- `recommendedKey` 与官方 CLI 会话回执里的 `model: "m-00032eaeec"` 一致.

best-effort:抓不到就**不带这两个头**(走 legacy,可用性不受影响),
失败退避 5 分钟,绝不反复打上游.

### 一个关键细节:签名里的 fetchId 必须与头一致

设备签名的载荷第 6 行是 `fetchId`.它必须与 `x-freebuff-catalog-fetch` 头的值
**完全一致** —— 它把请求绑定到签发该句柄的那次目录抓取.
若签名传 `null` 而头上有值(或反之),服务端验签失败,等同于未签名.
已在 `apiFetch` 里改为统一取 `catalog.fetchId`.

## Alternatives considered

- **不实现目录协议,继续用 legacy 模型 id** —— 改前现状.官方把 protocol 头
  的存在性当作模式开关,缺它就只能走 legacy 路径,而 legacy 路径在受限出口下
  被直接拒绝.
- **伪造句柄** —— 做不到:句柄是服务端签名的(`fbm1.` 前缀只是给人看的标识),
  客户端无法自造.只能老实抓一次.
- **每次请求都重抓目录** —— 浪费且会触发上游限流.缓存 + 失败退避即可;
  服务端用 `freebuff_catalog_stale` 告知失效(官方定义),届时再重抓.

## Consequences

- 请求携带目录协议头,服务端会按目录客户端处理.
- 抓到 52 个模型的句柄映射(实测 `handles: 52`,`recommendedKey: m-00032eaeec`).
- 抓取失败/未就绪时自动回落 legacy 路径,可用性不受影响.

## Evidence

- 实测抓取成功:`fetchId: fbf1.AAGZWM32cR3rz9Ux042...`,52 个句柄,
  `version: v0.g1.e82909.limited.5` —— 与官方抓包同格式.
- 官方登录会话回执里的 `model: "m-00032eaeec"` 与我们的 `recommendedKey` 一致.
- `npm test` 全绿(常量真值 / 未持有不带头 / 抓取失败不抛且退避 /
  `rows` 解析与 id→句柄映射 / 已持有不重抓).
-  **端到端仍未通**:带上目录协议与签名后,session admit 仍返回
  `country_not_allowed` 且 `instanceId: null`.账号未被封,额度未消耗
  (说明请求被拦在扣费之前).**下一个该查的方向**:官方那次成功是
  `version: v0.g1.e82909.limited.5` 的目录,需逐头对比实际发出的报文
  与官方抓包(尤其是签名是否被服务端接受).
