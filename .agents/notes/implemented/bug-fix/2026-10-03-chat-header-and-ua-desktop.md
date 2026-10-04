# Agent Note: chat 不带 `x-freebuff-instance-id`,UA 第三段走 desktop 形态

Status: implemented

## Problem

两处此前按 CLI 侧证据填的形态,与 **desktop 路线**的真实抓包不符.

### 1. chat 多带了 `x-freebuff-instance-id`

上一版(`2026-10-03-chat-instance-id-header.md`)判定该头"必须带",
依据是"补上后 428 消失".但 2026-10-03 的抓包复核推翻了这个因果:

- 官方 chat 头部**恒为 8 项**,8 个样本逐个校验 diff 为空集.
- **没有** `x-freebuff-instance-id` / `-client` / `-model` /
  `-catalog-protocol` / `-install-id` —— 那些是 **admission** 用的.
- 实例标识只走 `codebuff_metadata.freebuff_instance_id`.

所以当时 428 消失是**巧合**(同批还改了别的),不是该头的功劳.
带上它反而成为多余的指纹面.

### 2. UA 第三段是 `runtime/bun/1.4.2`,不是 `runtime/browser`

两个值**都是真机实测值**,只是路线不同:

| 来源 | 第三段 |
|---|---|
| 官方 CLI 0.2.6 抓包 | `runtime/browser` |
| 官方 desktop 0.0.156 抓包 | `runtime/bun/1.4.2` |

官方 orchestrator 本身就是 bun 跑的,所以 desktop 路线下 runtime 段是 bun.
`OFFICIAL_CHAT_UA_SUFFIX` 此前按 CLI 抓包填成 browser,与本仓库的
desktop 路线不符.

## Decision

**chat 头部删掉 `x-freebuff-instance-id`,UA suffix 改 `runtime/bun/1.4.2`.**

- 实例标识仍由 `codebuff_metadata.freebuff_instance_id` 承载(保留),
  只是不再重复出现在头部.
- `OFFICIAL_CHAT_UA_SUFFIX` 改为 bun 形态,并在注释里**同时保留** CLI 的
  browser 值及其出处 —— 避免下一个读者以为其中一个是错的.
- `test/smoke.mjs` 的 UA 断言同步改为 desktop 真值,注释说明两条路线的差异.

## Alternatives considered

- **保留 instance-id 头(多带无害)** —— 直觉上"多一个头不至于失败".
  但抓包证明官方 8 个头是**恒定集合**,我们此前多发 5 个,
  而 context 里已有判据:官方把"多余的指纹面"当作第三方客户端信号之一.
  按"照抄对齐"原则应删,不赌它无害.
- **UA 保留 browser(不动)** —— 改动最小,且 CLI 抓包确实是 browser.
  但本仓库走 desktop 会话(admission 用 desktop 槽位与 desktop agent),
  UA 却宣称 browser —— 与 instance-id 那次一样是**身份自相矛盾**,
  而这类矛盾已经被证明会引发判定异常.故必须一致化到 desktop.
- **两套 UA 按通道切换** —— 理论最优,但当前没有 CLI 通道需求,
  引入切换机制是过度设计.需要时再加.

## Consequences

- chat 头部与官方 8 项集合一致(差 `x-freebuff-catalog-fetch` 与设备签名,
  那两项主项目尚未接入,属后续项).
- UA 与 desktop 真值逐字一致.
- `npm test`(smoke ok)与 `npm run typecheck` 全绿;
  smoke 的 UA 断言已更新为 desktop 值.

## Evidence

- `docs/reverse/15-protocol-review.md` P0-1:官方 chat 8 个样本头部集合
  逐个校验 diff 为空集.
- `docs/reverse/captures/2026-10-03-official-client.jsonl`:
  manager/worker 各样本的 `User-Agent` 均为
  `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2`.
- `docs/reverse/14-captured-diff.md`:逐字段 diff 表.
