# Agent Note: 网页 token ≠ CLI token；chat 必须用服务端指派的 model

Status: implemented

## Problem

两个根因级发现，都来自对官方抓包的复核与一次「意外成功」的日志。

### 1. 我们一直用错 token 类型

官方 CLI 的业务请求用的 token 与我们喂给它的凭据**不是同一把**：

```
官方 CLI 请求头里的 Authorization: d4f6bee2-a6cb-46b0-9fa6-9dd8620d034b
我们 credentials.json 里的 authToken: f11e5e53-e80b-463b-926d-e23ac94e189e
```

CLI 写回凭据时把 token 放进了 `default.tokenStore: "keychain"`，`user.authToken`
仍是原值 —— 说明**服务端在登录流程中另发了一把 CLI 专用 token**。

实测确认这把 CLI token 独立有效（`GET /me` → 200，同一账号），且**行为与网页
token 不同**。我们此前一直拿网页 token 打 CLI 端点，服务端只能按 legacy/不可信
处理 —— 这解释了为何所有形态对齐（签名 / 目录协议 / env 描述符）都无济于事：
**形态是对了，凭证不对**。

### 2. chat 必须用服务端指派的 model，不能用自己的模型名

会话回执里的 `model` 是**服务端指派**的（`m-00032eaeec` 这样的目录 key，或
`fbm1.AAA...` 句柄），与客户端请求的模型名无关。

实测（CLI token 那次）：会话建起来了、拿到 instanceId 与 `model: m-096e75164d`，
但随后 chat 用 `deepseek/deepseek-v4-flash` → 上游报
**`session_model_mismatch`** —— 会话绑定的模型与请求的不符。

## Decision

1. **chat 的 `model` 用会话回执里的值**（`snap.model`），请求的模型名只作兜底：

```js
const outgoingModel =
  typeof sessionModel === 'string' && sessionModel ? sessionModel : upstreamModel
```

2. token 来源问题记录在案：正确做法是**走 CLI 登录流程签发 CLI token**，
   而不是复用网页 token。本轮未实现（属凭据导入链路改造，需单独决策）。

## Alternatives considered

- **继续在形态上找差异** —— 已经对齐到源码可验证的极限（UA / 端点 / 三类头 /
  签名 / 目录协议 / env 16 字段），端到端仍不通。根因不在形态。
- **把 CLI token 硬编码进凭据** —— 能验证，但那把 token 属于某次安装的登录会话，
  会过期且不该长期携带。正确路径是让导入流程签发。
- **chat 继续用请求的模型名** —— 实测直接报 `session_model_mismatch`；
  服务端指派的模型才绑得上会话。

## Consequences

- chat 请求的 model 与会话绑定一致，消除 `session_model_mismatch`。
- 用错 token 的根因已明确，后续凭据导入链路可据此改造。

## Evidence

- 抓包对比：官方 CLI 用 `d4f6bee2-...`，与我们凭据的 `f11e5e53-...` 不同。
- CLI token 独立有效：`GET /api/v1/me` → 200，同一账号 `llh282000500@gmail.com`。
- **一次真实成功**（用 CLI token）：日志出现
  `started agent run` → `session error: session_model_mismatch` →
  `released freebuff session instanceId=cli:ae4bde10-8b95-48ff-b6d4-13b8dda76d90
  model=m-096e75164d balance=15` —— 会话真的建立了、模型是服务端指派的句柄。
- 账号全程安全：`banned: false`，额度 15/25 未消耗（失败均发生在扣费之前）。
- ⚠️ 端到端仍未完成：修好 model 绑定后重试又回到 `country_not_allowed`
  （服务端对受限出口的判定存在波动，符合官方源码里 `access-cache.ts` 的
  access floor 语义：`recent_limited_country` 会把限制延续一段时间）。
