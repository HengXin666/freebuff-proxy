# Agent Note: 用官方 CLI 形态的 claim(cli: 前缀)签发会话

Status: implemented

## Problem

官方 CLI **自己生成**会话 instanceId,而不是等服务端签发一个裸 uuid:

```ts
// cli/src/utils/freebuff-session-identity.ts
const CLI_MULTI_SESSION_PREFIX = FREEBUFF_CLI_CLAIM_PREFIX   // 'cli:'
newFreebuffCliInstanceId() => `cli:${randomUUID()}`
// cli/src/hooks/use-freebuff-session.ts:576
let claimId = relaunch?.instanceId ?? newFreebuffCliInstanceId()
```

常量真源 `common/src/constants/freebuff-desktop-sessions.ts`:
```
export const FREEBUFF_CLI_CLAIM_PREFIX = 'cli:'
// "The server reads it to tell the CLI's claims from Desktop tabs"
```

改前我们完全用服务端返回的裸 uuid,于是官方那整套 **multi-session 协议头**
一个都没带(它们只在 instanceId 带 `cli:` 时才发,见
`cli/src/utils/freebuff-session-api.ts:186-200`):

- `x-freebuff-multi-session: 1`
- `x-freebuff-purchase-continuity: 1`
- GET 时:`x-freebuff-heartbeat: 1` + `x-freebuff-include-unused-rate-limits: 1`
- metadata:`freebuff_multi_session: '1'` + **`surface: 'cli'`**

`surface: 'cli'` 就是服务端区分 native CLI 与 Desktop 标签的字段 —— 缺它等于
没有自证身份.

## Decision

**admit 时自生成 `cli:<uuid>` claim 并发给服务端,同时按官方条件带齐
multi-session 协议头与 `surface: 'cli'` metadata.**

- `newCliClaimId()` / `isCliClaim()` 落在 `src/upstream/official-fingerprint.ts`.
- POST 是否带 instance-id 头严格照官方判据
  `if ((multiSession || method !== 'POST') && opts.instanceId)`:
  GET/DELETE 总是带;POST **只在 cli claim 时**带(那是客户端声明的 claim).
- 本代理不是 Desktop,`x-freebuff-client: desktop` **不带**(官方该头是
  Desktop 专用).`x-freebuff-bfcid` 也不带 —— 它是广告点击 id,需 HMAC
  校验,官方注释明说 "forging it buys nothing at all".

## Alternatives considered

- **沿用服务端签发的裸 uuid** —— 改前现状,零改动.但那样永远不会触发
  multi-session 协议头,也就永远不带 `surface: 'cli'`,服务端无从把我们的
  请求认成 CLI claim.
- **改成 Desktop 形态(`x-freebuff-client: desktop`)** —— 我们是 CLI 协议,
  冒用 Desktop 身份是另一套谎言,且 Desktop 走的是标签/多会话语义,与本项目
  单会话模型不符.
- **伪造 bfcid** —— 官方明说需 HMAC 校验,伪造无收益且是明显的对抗行为,不做.

## Consequences

- admission 现在自带 `cli:` 前缀 claim;服务端**实测原样接受并保留**.
- multi-session 全套头与 `surface: 'cli'` 已对齐官方条件.
- 形态断言锁进 `test/smoke.mjs`(claim 正则,两个头,metadata 两字段).

## Evidence

- 真账号实测(2026-09-30):POST admission 传 `x-freebuff-instance-id: cli:<uuid>`
  → `200 active`,返回 `instanceId` **与传入完全一致(带 cli: 前缀)**.
-  **chat 仍未打通**:同一账号在 `accessTier: limited` 下对
  `upstage/solar-mini4`,`mimo/mimo-v2.5`,`z-ai/glm-5.3-flash` 三个模型
  (均为官方 `LIMITED_FREEBUFF_MODEL_IDS` 成员)都返回
  `503 {"message":"The model is temporarily unavailable"}`.
  三次 admit 的额度**均被服务端自动退还**(`spent: 0`,余额未减少).
  所以这不是形态问题(`free_mode_cli_required` 已不再出现),而是该账号/出口
  组合在 limited 档位下的服务端策略.**尚未解决.**
