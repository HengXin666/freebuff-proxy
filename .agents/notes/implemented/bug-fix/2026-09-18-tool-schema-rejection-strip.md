# Agent Note: 上游以 tool-schema 指纹拒绝工具请求时剥离工具重试

Status: implemented

## Problem

下游调用**所有模型**都拿到空响应，错误文本是
`OpenAI API error (502): 502 status code (no body)`。

链路与判定（2026-09-18，直连线上实例逐段对照）：

1. 客户端（DSH/Codex 类 agent）**每个请求都带 `tools`**。
2. 上游对 `tools` 做指纹比对 —— 把"工具集是否与官方 CLI 一致"当作第三方客户端
   判据（freebuff 源码 `freebuff-models.ts` 原话："the tool-schema check
   (docs/freebuff-abuse-detection.md), which downgrades third-party clients"）。
3. 比对失败**本身不是错误**：上游把请求**降级**改投
   `inclusionai/ling-3.0-tiny:free`（`FREEBUFF_DOWNGRADE_MODEL_ID`），不回 4xx。
   该 slug 现已从 OpenRouter 目录下架（2026-09-19 实测，详见
   [2026-09-19-genuine-tool-signature.md](2026-09-19-genuine-tool-signature.md)），
   降级于是变成路由失败：/api/v1/chat/completions 回 `404`，body 形如
   `{"error":{"message":"No endpoints found for <model>","code":404}}` ——
   **字面说"模型不存在"，与工具毫无关联**。
4. 代理把 404 当"客户端 4xx，不换号、不重试"原样透传；下游 Responses 桥接层
   （sub2api）处理该错误时崩成 Cloudflare 纯文本 502（body 仅
   `error code: 502\n`），OpenAI SDK 解析不出 JSON，于是报
   "502 status code (no body)"。

### 证据强度（2026-09-18 二次复核后修正）

**已确证**（多模型、多轮次、跨时间窗、带 `x-freebuff-proxy-account` 账号头交叉验证）：

| 请求 | 结果 |
|---|---|
| 无 `tools` | **200**（稳定复现） |
| 带 `tools` | 404（与工具名/参数内容无关） |

**已撤回**：早前"必须带 `required`"、"只有官方工具名白名单才放行"、"逐字复刻官方
24 个工具名仍 404"等更细的规律**不成立**。复核发现那批实验跑在**账号池正被逐个
封禁**的同一时间窗内（A/B/C 系列 14:20-14:25、Y/R/Q/S 系列 14:40-14:46），
后期账号已全部返回 `403 account_suspended` —— 那些"规律"是**装置漂移产生的伪影**，
不是上游的真实判据。

**判据已测绘**（2026-09-19）：真源是上游开源的
`common/src/constants/foreign-client-signals.ts`，规则是"签名工具必须名字 + 真实参数
schema 双真"，零参数工具永远不算。本文发表时那句"精确规则仍未测绘"已被取代，
测绘结果与对照实验见
[2026-09-19-genuine-tool-signature.md](2026-09-19-genuine-tool-signature.md)。

另确认第二个缺陷：上游对第三方客户端的封禁回
`403 {"error":"account_suspended","message":"...third-party client or proxy..."}`，
`error` 是**字符串**、没有 `code` 字段。既有 `shouldSwitchAccountOnError` 只认
`banned` / `country_blocked` / `ip_capped`，于是这个 403 落进"4xx 客户端错误不
换号"分支：**每个被封的账号被反复复用**，错误原样甩给下游，`markCooldown` 也记不上
`bannedAt`（控制台看不到封禁）。

## Decision

**把"工具被上游拒"当成一种可恢复杂志，剥离工具后重发一次。**

- `src/free-mode.js` 新增 `hasClientTools` / `stripClientTools`：后者删
  `tools` / `tool_choice` / `parallel_tool_calls`（`functions` 不删）。
- `src/proxy.js` 的 `forwardCompletions` 在响应头阶段改为**最多两轮**：第一轮带原
  工具集；若被 `isToolSchemaRejection`（404 + "No endpoints found"）判定为工具拒绝，
  第二轮去掉工具重发。命中时回 `x-freebuff-proxy-tools-stripped: 1`。
- 只在**客户端确实带了 `tools`** 时才可能重试；受
  `settingsStore.stripToolsOnSchemaRejection`（默认 true）控制，控制台可关。
- `src/upstream/client.js` 新增 `extractAccountBanError`：把
  `account_suspended` / `banned` / `country_blocked` 归一为 `banned`；
  `forwardCompletions` 据此**重算 `effectiveErrCode`**（只改响应体而不改
  `errCode`，`shouldSwitchAccountOnError` 与 `markCooldown` 仍照旧分支，等于没改）。

取舍明确：**宁可丢工具能力，也不能全体空响应**。剥离后模型仍给出文本回答。

指纹对齐（协议化的第一步）见
[2026-09-18-official-cli-fingerprint.md](2026-09-18-official-cli-fingerprint.md)：
本 note 的剥离重试只是**兜底**；根因是请求指纹与官方 CLI 不一致（UA 版本号、
准入端点、头集合），对齐后该 404 应不再触发。

## Alternatives considered

- **什么都不做，把 404 原样透传** — 最省事，且"不替客户端做决定"是好原则。
  但它等于承认"带工具的 agent 完全不可用"。实测已证明该 404 与"模型不存在"无关，
  继续按客户端错误处理是**错误归因**，不是保守。
- **继续补**空心**签名工具（往 tools 末尾加官方 `end_turn` 名字 + 空 schema）** —
  既有实现正是这个思路。它的**最强理由**是：这曾是真实有效的对策，且成本为零。
  但上游 2026-09-17 起要求「名字 + 真实参数 schema」双真，零参数工具**永远不算签名**，
  并把这一形态逐字收进测试夹具、点名 freebuff-proxy。该写法已被
  [2026-09-19-genuine-tool-signature.md](2026-09-19-genuine-tool-signature.md)
  换成官方真签名工具（`lookup_agent_info` + `decide`）；**补签名仍在用**，
  变的是补什么。
- **逐字复刻官方 24 个工具的完整 schema** — 理论上能过指纹（官方 CLI 就靠它通过）。
  但官方 schema 是上游私有实现（要从 140MB 二进制里逆），每次上游改版都要重逆；
  且这只是"伪装成官方客户端"，维护成本与风险都高于"对齐指纹 + 剥离兜底"。
- **用 `functions` 旧字段绕过** — 实测 200，但模型把工具调用写成正文文本而非
  结构化 `tool_calls`，下游解析不到调用，等于工具能力失效。换个字段换个死法。
- **把该 404 当作账号级故障换号重试** — 换号解决不了：这是**请求形态**被判据拒绝，
  每个账号都会拒。白烧 admit 预算（一次 admit 买断一小时）。

## Consequences

- 带工具的请求：若上游以 404 拒掉带工具的请求，会多一次往返后才剥离重试。
  请求形态对齐官方签名工具后该路径应不再触发；若上游改变判据，它是最后一道兜底。
  （注意 404 的直接成因是降级目标 slug 下架，见本文 Problem 第 3 条。）
- **工具能力在免费模式下可能仍不可用**（取决于上游判据是否只看指纹）。
- `account_suspended` 归一为 `banned` 后，被封账号进入 24h 冷却并在控制台标记
  `banned`——这是**正确的**行为，代价是账号池会快速见底。
- 新增下游可见的响应头 `x-freebuff-proxy-tools-stripped`；新增设置项
  `stripToolsOnSchemaRejection`（`/data/settings.json`，web API 可读写）。

## Testing

- `test/smoke.mjs`（`tool_schema_reject`）：带 `tools` 时 mock 上游回
  404 No endpoints found → 断言**恰好两次** chat 调用、第一次带原工具、第二次
  `tools === undefined`、响应 200 且带 `x-freebuff-proxy-tools-stripped: 1`。
- `test/smoke.mjs`（无 `tools` 对照）：不触发拒绝、只调用一次。
- `test/smoke.mjs`（`suspended_a` 多账号）：token-a 回 403
  `account_suspended` → 断言换到 token-b 成功、且 a 在 `runtimes.list()` 里
  `banned === true`。
- 线上一手对照实验（本文 Problem 的"已确证"两行）为判据来源；
  **更细的 tool-schema 规则未测绘，已有伪影结论已撤回。**
