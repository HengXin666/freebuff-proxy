# Agent Note: instanceId 用裸 UUID 并复用,session 头组不再限定 `cli:` 前缀

Status: implemented

## Problem

两处实现与**官方 desktop 抓包**不符,都是按 **CLI 侧**证据写的.

### 1. instanceId 形态与生命周期

此前 `newCliClaimId()` → `cli:<uuid>`,且**每次 admission 新建**.

抓包复核(2026-10-03)显示官方 desktop 是**裸 UUID 且整场复用**:

```
line 8 / 34 / 54 三次 POST admission 的 x-freebuff-instance-id
  同为 e1be7199-331e-4622-b5a9-0a2cfe8aecc1
line 38 的 codebuff_metadata.freebuff_instance_id 也是它
```

review(`15-protocol-review.md` P0-2 / E.1)指出这可能就是
`12-waiting-room-slot-contention.md` §12.2 里标注"尚未确定"的
**购买被全额退款作废**的直接诱因:官方回执里 `desktopRefunds` 从未出现,
而我们每次都退.cli-bridge 改成裸 UUID 复用后实测:admission 200 且无退款条目.

### 2. session 头组只在 `cli:` 前缀时发

`officialSessionHeaders()` 按官方 **CLI** 源码
(`cli/src/utils/freebuff-session-api.ts:186-201`)实现:

- multi-session / purchase-continuity / desktop-attempt-id 只在 `isCliClaim()` 时发
- POST 的 instance-id 只在 cli claim 时带

但 **desktop 抓包证明 POST admission 也带整组**(line 8/34/54,且用裸 UUID).
那条规则是 CLI 源码的,不适用于 desktop 路线.

## Decision

1. **新增 `newRawInstanceId()`**(裸 UUID),`SessionManager` 在构造时生成一次,
   整个进程复用,admission 与 GET session 都用它.
2. **`officialSessionHeaders()` 改为[有 instanceId 就发整组]**,
   不再要求 `cli:` 前缀,POST 也带 instance-id.

`isCliClaim()` 保留导出(外部仍在用),但不再是发头的前置条件.

## Alternatives considered

- **保留 `cli:` 前缀(CLI 路线)** —— 两边都是官方实测值,看似都行.
  但本仓库走 desktop 会话(desktop agent,desktop 槽位),
  instanceId 却宣称 CLI —— 与已栽过两次的**身份自相矛盾**同类
  (instance-id 头,UA runtime 段都是这么错的).必须一致化到 desktop.
- **只改形态,不复用** —— 形态对了但每次新建仍然会退款.
  复用才是消除退款的关键(review 的推测 + cli-bridge 的实测).
  两个都要改.
- **同时保留两条路线按通道切换** —— 当前没有 CLI 通道需求,
  引入切换是过度设计;需要时再加,且注释已标明两条证据的出处.

## Consequences

- admission / GET session 现在带裸 UUID 的 instance-id,
  以及 multi-session,purchase-continuity,desktop-attempt-id(后者每次新 uuid).
- `desktopRefunds` 应不再出现(待配额重置后实测确认).
- 测试断言同步改为 desktop 真值:admission 与 GET session 的
  instance-id 都必须是裸 UUID 且不得带 `cli:` 前缀.
- `npm test`(smoke ok)与 `npm run typecheck` 全绿.

## Evidence

- `docs/reverse/15-protocol-review.md` P0-2 / E.1.
- `docs/reverse/captures/2026-10-03-official-client.jsonl` line 8 / 34 / 54 / 38.
- cli-bridge 侧实测:改裸 UUID 后 admission 200 且未产生退款条目
  (`docs/reverse/16-success-200-with-toolcall.md`).
