# Agent Note: admission 前必须结清待结束的会话;错误信息必须逐账号对账

Status: implemented

## Problem

用户远程报[明明有 15 点,却说一点都没有,太误导人了].读远程日志后确认是
**两个独立问题**:

### 问题一:错误信息张冠李戴

日志(2026-10-04 12:52:17,池里 3 个号):

```
12:52:17  skip account  lolikagayaku666   balance=0        ← 被拒的是这个
12:52:17  skip account  llh282000500      balance=0        ← 和这个
12:52:17  admitting      loli@woa.qzz.io                   ← 有 15 的号**被放行了**
12:52:18  slot busy      loli@woa.qzz.io  code=purchase_capacity
```

**有 15 点的那个号根本没被判额度不足** —— 它被正常放行,卡在槽位上.
而错误 body 里那句 `balance 0 < price 15` 说的是**另外两个 0 余额号**的账.

上一版虽然加了 `accounts: [...]` 逐账号明细,但**顶层 message 仍是"取最差那个号"**
的旧口径 —— 用户最先看到的就是这句,于是被误导.

### 问题二:槽位被占,但本地账本说"没有会话"

同一账号**直连上游**只读查询:

```json
{ "status": "none", "balance": 15, "daily": { "spent": 10, "remaining": 15 } }
```

上游说**没有活跃会话**,而远程 admission 一直回 `purchase_capacity`(槽位被占).
面板与上游各说各话 —— 用户完全无法判断.

官方做法(`orchestrator.js:208130-208136`):

```js
for (let end of journal.pending(owner)) {
  if (end.instanceId !== instanceId) continue;
  if ((await recovery.finish(end, auth, {...})).status === "ended") continue;
  throw localSessionError("previous_end_unconfirmed");
}
```

即 **admission 前先把"待结束的会话"结清**.我们缺这一步,于是上游认为槽位仍被占,
而本地 `_apply` 早已把 `session` 覆盖成 `none`.

## Decision

### 一,message 逐账号列出,不再单取一个

`no_available_account` 的顶层 message 改为按序号列出**每一笔账**
(`#1 balance=0 price=15 (daily 0/25, daily_exhausted); #2 balance=15 price=15 …`).
不写邮箱(PII,且 message 最容易被整段转发).

### 二,admission 前结清待结束的会话

`_admitUnlocked` 开头:若 `_releasePending` 且 `session.instanceId` 存在,
先 `DELETE /session` 把它结清(失败只记日志,不阻断),再走正常 admission.
只在确实处于待结束状态时做,正常路径零开销.

### 三,槽位忙时记录上游回执细节

`purchase_capacity` / `purchase_in_use` / `premium_slot_taken` 的回执带
`currentInstanceId` / `nextExpiryAt` / `slotLimit` —— 那是**定位"谁占槽位"的唯一
线索**.此前只记 `code`,导致用户遇到[上游 none,本地 busy]时无法定位
(我为此白查了一轮).现在全部落进日志.

## Alternatives considered

- **只改 message,不管槽位** —— 两类问题独立:message 修误导,槽位修拦截.
  只修一个用户仍然用不了.
- **保留"取最差那个号"的 message** —— 已被用户明确指为"误导人":
  数字与账号不对应,用户会对着自己有余额的号去查一个没坏的东西.
- **在 message 里带邮箱** —— 违反既有脱敏纪律(`maskEmail` / message 会被整段转发).
  序号 + 数值足以消除歧义.
- **admission 前无条件 DELETE 一条旧会话** —— 那会踩上一版刚修的坑
  (付费时段内释放 = 白烧钱).所以只在 `_releasePending`(说明**已经**在退避重试
  结束它)时才补一次 DELETE.

## Consequences

- **message 变长**(多账号时每号一行),且不再引用任何单个账号的账 —— 这是刻意的.
- **`_releasePending` 时 admission 多一次 DELETE**(仅在该状态下).
- **槽位忙日志多 6 个字段**,便于下一次直接定位占用者.
- 既有 code(`no_available_account` / `freebuff_exhausted`)不变,
  按 code 匹配的调用方不受影响.

## Evidence

- 远程日志定位(12:52:17-12:52:18):有 15 点的号被放行 + 卡 `purchase_capacity`;
  被拒的是另外两个 0 余额号 → 证实 message 张冠李戴.
- 直连上游只读查询该账号:`status: none` / `balance: 15` / `spent: 10` →
  证实"面板与上游不一致".
- 官方源码 `orchestrator.js:208130-208136`:admission 前的 `journal.pending` 结清循环.
- 新增测试(`test/smoke.mjs`):admission 前必须先 `DELETE` 那条待结束的会话,
  且 `DELETE` 必须发生在幂等 admission **之前**;结清后 `_releasePending` 复位.
- 反向探针实证可证伪:把该分支短路后断言红
  (`admission 前必须先 DELETE 那条待结束的会话，got ["GET:…","POST:…"]`).
- 门禁:typecheck 过;`npm test` 全绿;`check:contract` / `check-config-consistency` 过.
