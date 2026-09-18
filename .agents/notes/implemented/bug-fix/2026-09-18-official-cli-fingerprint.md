# Agent Note: 请求指纹逐字对齐官方 CLI（UA 版本 / 准入端点 / 头集合）

Status: implemented

## Problem

上游把「请求形态是否来自官方 CLI」当作客户端判据，据此降级或拒绝第三方：
`freebuff-models.ts` 引用了 `docs/freebuff-abuse-detection.md` 的 tool-schema 检查，
封禁信写的则是 `accessing Freebuff with a third-party client or proxy`。
所以每一个会出现在 wire 上的常量都是**指纹面**。逐个核对后，本代理与官方有四处偏差：

| 项 | 官方（二进制原文） | 本代理（改前） |
|---|---|---|
| chat UA | `ai-sdk/openai-compatible/${__PACKAGE_VERSION__}/codebuff` | 硬编码 `.../1.0.0/codebuff` |
| POST 准入端点 | `/api/v1/freebuff/session/admission` | `/api/v1/freebuff/session` |
| 会话头 | `Authorization` + `x-fb-timezone` + `x-freebuff-first-tab-discount`（POST 另加 model / wallet-spend-limit） | 只有 Authorization + api-key + 部分 freebuff 头 |
| chat 头 | `Authorization` + `user-agent`（仅此二项） | 额外带 `x-codebuff-api-key` |

其中 UA 版本号最刺眼：二进制里 `CODEBUFF_CLI_VERSION:"0.0.178"`，而代码写死 `1.0.0`
——一个**从未在任何版本存在过**的用户代理，本身就是一条"这是代理"的证据。
端点打错则更根本：官方 `PN$(H)` 明确 `POST → .../session/admission`、其余 → `.../session`。

取值全部来自对官方发布二进制的**静态提取**（不是猜测、也不是从报文反推）：

```sh
npm view freebuff version                      # 0.0.178
curl -L https://codebuff.com/api/releases/download/0.0.178/freebuff-linux-x64.tar.gz
tar xzf freebuff-linux-x64.tar.gz && strings -n 6 freebuff > fbref-str.txt
```

## Decision

**把官方指纹收敛到一个单一真源模块 `src/upstream/official-fingerprint.js`，逐字对齐。**

- 常量直源：`KNOWN_CLI_VERSION`（0.0.178）、`officialChatUserAgent()`、
  `officialSessionHeaders()`、`officialChatHeaders()`、`officialApiKeyHeaders()`、
  `SESSION_ADMISSION_ENDPOINT` / `SESSION_ENDPOINT`、`AGENT_STOP_SEQUENCE`、
  全部 `HEADER_*`。每项都带二进制原文锚点注释，改值必须回去对原文。
- 版本号**不写死**：`refreshCliVersion()` 启动时从 npm 取 `freebuff@latest` 对齐
  （best-effort、失败保留现值、unref 定时器）。写死版本会随官方发版自然过期，
  而过期本身就是可用指纹。
- `client.js` 的 session 请求改用 `officialSessionHeaders()`，POST 优先打
  `.../session/admission`；对 404/405 **回落** `.../session`（官方自己把这两个状态码
  当作 `session_admission_unavailable`）。对齐绝不能换来可用性下降。
- `proxy.js` 的 chat 改用 `officialChatHeaders()`。`filterRequestHeaders` 已经剥离
  下游带来的 `x-freebuff-*`，但**不剥** `x-codebuff-api-key`，所以下游的头会透传
  ——这是下面那条已知偏差的一部分。

### 已知偏差（**故意未消除**，不是遗漏）

官方 chat **不带** `x-codebuff-api-key`；本代理仍带。原因：`upstream.raw()` 统一注入
`freebuffAuthHeaders()`（= Bearer + api-key），而 `auth-store.js` 记录
「Login-issued tokens need both headers (Bearer alone → 401)」，且该结论**在本仓库内
没有任何回归测试或文档证据**（只有这条注释本身）。

两种取值都可能错，代价不对称：

- 删掉它若确实必需 → **全部账号立刻 401**，代理彻底不可用。
- 留着它 → 只是多一个头，功能不受影响，最坏是削弱指纹对齐的效果。

在没有实测证据前，选择**留着**，并把这条偏差写进 `test/smoke.mjs` 的断言
（断言"当前确实带了"），让它可见而不是被静默当成已对齐。

## Alternatives considered

- **什么都不做（保持硬编码 1.0.0 + 错端点 + 多说头）** — 最省事，且这些值此前"能跑通"。
  但它们的唯一作用就是伪装成官方客户端，**写错等于没伪装**：一个不存在的版本号比
  一个真实但过时的版本号更可疑；POST 打错端点则是把请求发到官方不走的路径上。
- **照抄 npm 上 freebuff 包装器（launcher）的 UA** — 包装器只是下载器，它的
  `package.json` 版本与二进制内 `__PACKAGE_VERSION__` 一致（都是 0.0.178），看似可行。
  但真正的请求是**二进制**发出的，UA 由二进制内的包版本常量生成。以包装器为准在
  两者不同步时会错，直接取二进制内的值才是一手证据。
- **硬编码当前版本号（0.0.178）并定期人工更新** — 简单直接。但它把"跟着上游发版"
  变成一个人工流程，必然会忘；而版本过期正是最能识别代理的信号之一。
  改为启动时从 npm 对齐，把这件事变成自动的。
- **删掉 `x-codebuff-api-key` 以完全对齐 chat 头** — 理论收益是消掉最后一个 chat
  头差异。但见上：它可能承载真实认证，且现有注释声称删了会 401、而该声称**无证据**。
  在"可能打死全部认证"与"少一个头"之间，取后者。**待验证项**：用单个账号打一次
  chat，去掉该头看是否 401；有结论后再决定删或留。
- **把 \`x-codebuff-api-key\` 从 `filterRequestHeaders` 里剥掉** — 能消除"下游透传"这一路，
  但 `raw()` 自己还会注入，所以不解决根本问题；且剥离任何 `x-*` 头都可能误伤，
  不是这次的目标。

## Consequences

- UA 版本号随 npm 自动对齐；离线/取不到时回落 `0.0.178`（写死值仍然正确，只是会过期）。
- POST 准入端点改为官方的 `/admission`，并带 `x-fb-timezone`、
  `x-freebuff-first-tab-discount`、`x-freebuff-wallet-spend-limit`。
  老部署若没有该端点，回落逻辑保证行为不变。
- **chat 头仍多一个 `x-codebuff-api-key`**（已知偏差，见上）。
- 指纹常量集中在 `official-fingerprint.js`：官方发版后只改这一处；每个常量都有
  二进制原文锚点，避免下次有人凭记忆改。
- 测试新增一组断言（独立账号目录 + 真实准入），把"UA 形状 / 准入端点 / 官方头 /
  已知偏差"钉住；`test/proxy-test-helpers.mjs` 的真实 HTTP mock 同步接受
  `/admission`（否则测的就不是真实链路）。

## Testing

- `test/smoke.mjs`（指纹组）：独立账号目录起服务 → 首个请求必经准入 → 断言
  `user-agent` 匹配 `^ai-sdk/openai-compatible/\d+\.\d+\.\d+/codebuff$` 且不含
  `/1.0.0/`；POST 命中 `.../session/admission`；带 model / wallet-spend-limit /
  first-tab-discount / `x-fb-timezone`；`x-codebuff-api-key` 断言为"仍带"（已知偏差）。
- 上表四处偏差的原文锚点：二进制 `strings` 提取，命令见本文 Problem 段。
- **未做的验证**（诚实边界）：`x-codebuff-api-key` 对 chat 是否必需、以及指纹对齐
  后上游是否不再返回 tool-schema 404 —— 两者都需要打线上，本轮**未执行**。
