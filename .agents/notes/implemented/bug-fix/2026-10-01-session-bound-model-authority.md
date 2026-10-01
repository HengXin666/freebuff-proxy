# Agent Note: 会话绑定的是服务端指派的模型，客户端必须顺从（不是"翻译"）

Status: implemented

## Problem

端到端卡在 **chat 层 503** 上，而**会话与 agent run 都已成功**：

```
freebuff session active   instanceId=cli:a3919132-...  model=m-00032eaeec
started agent run         runId=a7735c50-...  agentId=base2-free-deepseek-flash
upstream chat non-ok      status=503
  {"error":{"message":"The model is temporarily unavailable. ...","code":503}}
```

根因在**模型映射**：我们请求 `deepseek/deepseek-v4-flash`，但当时目录里
**根本没有这个模型** —— 只有 12 行：

```
m-00032eaeec | MiMo 2.6 Flash        ← recommendedKey
m-7e20df6765 | GLM 5.3 Flash
m-096e75164d | DeepSeek V4.1 Flash   ← 这才是 deepseek 系
m-5a5d0e255e | GPT-6 Luna
...
```

我们加的 `recommendedKey` 兜底把请求映射成了 `m-00032eaeec`（**MiMo 2.6 Flash**），
于是会话绑 MiMo、agent 却是 `base2-free-deepseek-flash`，chat 自然被拒。

### 目录是**动态的**

同一账号两次抓取分别是 **52 行**与 **12 行** —— 目录内容随账号状态/时段变化。
所以任何"把请求里的模型名硬翻译成句柄"的做法都会错：名字未必在册。

## Decision

**不做翻译，做顺从**：会话回执已经给出服务端指派的 `model`，chat 就直接用它。

- `snap.model`（会话回执里的 `m-xxx` / `fbm1.xxx`）是唯一可信的模型标识；
- `recommendedKey` 只用于**建会话**（admission 需要带一个 model），
  **不参与** chat 的模型选择；
- 客户端请求的模型名（如 `deepseek/deepseek-v4-flash`）只用于**选账号**与日志，
  不上 wire。

## Alternatives considered

- **继续用模型名翻译句柄** —— 已证伪：目录里没有该名字的行，翻译必然落空或落到
  错误行（实测落到 MiMo）。
- **按 displayName 模糊匹配** —— 名字会变（"DeepSeek V4.1 Flash" vs 我们目录里的
  "DeepSeek V4 Flash 07/31"），且服务端目录本身是动态的，匹配规则注定脆。
- **硬编码模型→句柄表** —— 句柄是服务端签名且随目录版本刷新，写死会立刻过期。
- **recommendedKey 兜底**（本 note 初版曾建议）—— **已被证伪**：它把
  `deepseek/deepseek-v4-flash` 静默映射到 MiMo（`m-00032eaeec`），制造了
  "会话绑 MiMo + agent 用 deepseek" 的矛盾，是 chat 503 的直接原因。
  正确机制是 legacyDigests（FNV-1a），见
  [2026-10-01-legacy-model-digest-mapping.md](2026-10-01-legacy-model-digest-mapping.md)。

## Consequences

- chat 用的模型与会话绑定**必然一致**，消除 `session_model_mismatch` 与由此引发的
  503。
- 下游请求的模型名只影响"选哪个账号/哪条会话"，不再影响上游 wire 上的字段。
- 若将来需要"客户端指定模型"，正确做法是让 **admission** 按该模型去建会话
  （目录里有对应行时），而不是在 chat 上改写。

## Evidence

- 日志三方对照：会话 `model=m-00032eaeec`（MiMo）、agent `base2-free-deepseek-flash`、
  chat 503。
- 目录实拉 12 行，无 `deepseek/deepseek-v4-flash`，deepseek 系只有 `m-096e75164d`。
- 账号全程 `banned: false`；额度 20/25（本轮消耗 10，来自探测建立的会话）。
