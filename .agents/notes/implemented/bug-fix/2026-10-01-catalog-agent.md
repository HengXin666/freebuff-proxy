# Agent Note: 目录模式下 agent 是统一的 base3-free-catalog(不按模型推导)

Status: implemented

## Problem

官方 chat 走目录协议时,`POST /api/v1/agent-runs` 的 START 用的是:

```json
{"action":"START","agentId":"base3-free-catalog","ancestorRunIds":[]}
```

而我们发的是 `base2-free-deepseek-flash`(按模型名推导).

这不是"名字不同"的小事:**agent 世代决定系统消息的开场白**.官方 chat 的
`messages[0]` 是

```
You are Buffy, the coding agent behind Codebuff.
```

这是 **base3 规范开场**(base2 是 `You are Buffy, the strategic coding
assistant.`).agent 用 base3 而开场白用 base2(或反之)是跨世代组合,
上游按世代校验会拒绝.

## Decision

**会话模型是目录 key 时,agent 一律用 `base3-free-catalog`.**

判定条件:`snap.model` 以 `m-`(目录 key)或 `fbm1.`(句柄)开头 —— 也就是
**目录模式**.此时不再走 `agentIdForModel(upstreamModel)` 的推导.

二进制原文(两条一起看才完整):

```js
UK = "base3-free-catalog"
Ps$(H) { return WD().row(H)?.key === H ? UK : cCH(H) }
```

即"会话的模型是不是目录行"决定用统一 agent 还是按世代推导.

**兜底也必须同代**:主 agent 被拒时的 `agentFallbackForModel()` 在目录模式下
会回退成 `base2-free`(因为它按模型名查表,查不到目录 key)—— 跨世代.
改为同样返回 `CATALOG_UNIFIED_AGENT_ID`.

## Alternatives considered

- **继续按模型名推导 `base2-free-<slug>`** —— 改前现状,与官方不一致.
- **只改主 agent,不管兜底** —— 主 agent 被拒时会静默回退到跨世代的 base2,
  失败原因更难查(表现为"换了个 agent 还是被拒").
- **按模型名判断世代(如 `/luna/`)** —— 测试里原本这么写,但模型名不是世代
  的真实来源:世代由 agentId 决定,而 chat body 里没有 agentId.目录模式才是
  可判定的代理信号.

## Consequences

- 目录模式下 agent 与系统消息开场白**同代**,不再出现跨世代组合.
- `CATALOG_UNIFIED_AGENT_ID` 成为该常量的唯一定义处(`src/model.ts`).

## Evidence

- 抓包:官方 agent-runs START `agentId=base3-free-catalog`(目录模式唯一值).
- 抓包:官方 chat `messages[0]` 以 `You are Buffy, the coding agent behind
  Codebuff.` 开头(base3 开场).
- 二进制:`UK` / `Ps$` 两段逻辑(见上).
- `npm test` 全绿(测试的世代判定从"按模型名猜"改为"按目录形态判"),
  typecheck 干净.
- 相关:[2026-10-01-chat-ua-two-part.md](2026-10-01-chat-ua-two-part.md),
  [2026-10-01-chat-accept-star-slash-star.md](2026-10-01-chat-accept-star-slash-star.md).
-  端到端未验证:本会话无可用账号(被封 + 其余三个 token 401).
