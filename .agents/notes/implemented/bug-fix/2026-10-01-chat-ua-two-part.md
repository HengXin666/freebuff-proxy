# Agent Note: chat UA 是两段式，且版本段是 0.0.0-test（不是包版本号）

Status: implemented

## Problem

官方 chat/completions 的 `user-agent` 与我们发的不一致，**两处都错**：

```
官方（mitmproxy 抓 CLI 0.2.6）:
  ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser
我们（改前）:
  ai-sdk/openai-compatible/0.0.178/codebuff
```

### 1. 版本段是 `0.0.0-test`，不是包版本号

二进制原文：

```js
Qo = typeof __PACKAGE_VERSION__ < "u" ? __PACKAGE_VERSION__ : "0.0.0-test"
```

官方**发布构建里没有注入** `__PACKAGE_VERSION__`，于是回退到字面量 `0.0.0-test`。
所以我们此前发 `0.0.178`（`package.json` 的版本）反而**与官方不一致** ——
越是"看起来正确"的版本号，越是偏离真实指纹。

### 2. 后面还有第二段，我们整段漏了

`ai-sdk/provider-utils/3.0.25 runtime/browser` 由 ai-sdk 库自己拼接。
二进制里只有第一段的模板字符串：

```js
"user-agent": `ai-sdk/openai-compatible/${Qo}/codebuff`
```

第二段是库在运行时追加的 —— 单看模板串会以为只有一段（这正是当初漏掉的原因）。

## Decision

**UA 常量化为两段式，版本段默认 `0.0.0-test`；`proxy.js` 不再传 `getCliVersion()`。**

- `official-fingerprint.js`：新增 `OFFICIAL_CHAT_UA_VERSION = '0.0.0-test'` 与
  `OFFICIAL_CHAT_UA_SUFFIX`；`officialChatUserAgent()` 拼两段。
- `proxy.js`：调用 `officialChatHeaders()` 时**不传 version**，用函数默认值；
  顺带移除随之不再使用的 `getCliVersion` 导入。

`getCliVersion()` / `activeCliVersion` **保留**：它们仍驱动 npm registry 版本对齐
（`cli fingerprint version aligned` 日志），只是不再进 chat UA。

## Alternatives considered

- **继续发包版本号（0.0.178）** —— "看起来更真实"但实测与官方相反；
  官方的真实输出就是 `0.0.0-test`。
- **只补第二段、保留 0.0.178** —— 半对半错比全错更难发现。
- **把 `OFFICIAL_CHAT_UA_SUFFIX` 也做成可配置** —— provider-utils 版本随 ai-sdk
  依赖升级而变，但目前只有 `3.0.25` 这一个实测值；等有第二个样本再抽象，
  现在写死并注明来源更诚实。
- **从本地 package.json 读 provider-utils 版本** —— 我们不是 ai-sdk 客户端，
  本地根本没有这个依赖，读不到。

## Consequences

- chat 的 UA 与官方**逐字一致**（测试断言直接写死金标准字符串）。
- 旧注释里"UA 必须是 `版本号`"的假设已被推翻并就地重写。

## Evidence

- 真机抓包（官方 CLI 0.2.6）：`ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser`。
- 二进制：`__PACKAGE_VERSION__` 回退字面量；`runtime/browser` 字面量存在。
- `npm test` 全绿（断言改为与金标准字符串相等）、typecheck 干净。
- ⚠️ 端到端仍未验证：**本会话无可用账号**（被封账号 `llh282000500@gmail.com`
  已 `banned: true`；`data/credentials/` 里另外三个账号 token 全部 HTTP 401
  `Invalid API key or user not found`）。
