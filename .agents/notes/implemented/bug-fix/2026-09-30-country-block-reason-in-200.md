# Agent Note: 识别上游在 200 回执里夹带的地理封锁（countryBlockReason）

Status: implemented

## Problem

上游把出口 IP 的地理封锁**不放在错误码里，而是夹在 200 OK 的会话回执里**：

```json
{
  "status": "active",
  "countryCode": "JP",
  "countryBlockReason": "country_not_allowed",
  "freebucks": { "balance": 25, "daily": { "remaining": 25 } }
}
```

会话**照样建立成功**（`status: "active"`、额度照扣），但随后的
`POST /api/v1/chat/completions` 一律 503。因为 503 不带任何业务体，
本代理只能把它归成 `http_503`：

- 账号被冷却、换号，再冷却、再换 —— 所有账号轮流撞同一堵墙；
- 每次 admit 都**买断一小时的 Freebucks**（见
  [2026-09-14-paid-hour-hold.md](../architecture/2026-09-14-paid-hour-hold.md)），
  所以每轮无效重试都在烧真钱：实测一次诊断就把 25 烧到 5；
- 用户/控制台看到的只有 `503`，真正的判据 `country_not_allowed` 从未出过日志。

改前 `countryBlockReason` 在整个 `src/` 里**零命中** —— 这个字段从未被读取过。
已有的 `country_blocked` 处理（`client.js` 的 403 分支、
`session-manager.js` 的 `ACCOUNT_LEVEL_SESSION_STATUSES`）只认
**HTTP 403 + `status: "country_blocked"`** 那一种形态，对 200 回执里的地理封锁不适用。

## Decision

**在会话回执的解析层，把 200 里夹带的 `countryBlockReason` 归一化成既有的
`country_blocked` 账号级故障，让它走已有冷却通道，并把 `countryCode` 带上给用户看。**

- 归一化发生在 `client.js` 的 session 回执解析处（GET/POST 都覆盖）：
  只要回执对象里 `countryBlockReason` 为真值，就按 `status: "country_blocked"` 处理，
  原有 403 直通分支不动。
- 账号级故障集合 `ACCOUNT_LEVEL_SESSION_STATUSES` 已含 `country_blocked`，
  所以冷却、换号、控制台 `lastProbe` 展示全部自动生效，无需新增通道。
- `countryCode` 一并透出（错误 `body` 与日志），让用户知道"是哪个国家被拒"。
- 只识别、不绕过：本改动**不试图换出口、不伪造地理位置**。换出口是代理池配置的事
  （前端「代理设置」），与本决策无关。

### 为什么不做成"硬失败"

仍然返回会话对象（而不是抛错），让既有调度逻辑自己走冷却/换号：
这条封锁是**出口**属性，不是账号属性 —— 同一个账号换一个允许的出口就可用。
若在此处硬失败，就抹掉了"换代理即恢复"这条最有效的出路。

## Alternatives considered

- **什么都不做（继续把 503 当普通上游故障重试）** —— 最省事，且改前"能跑"。
  但它是**唯一会烧钱**的选项：每次重试都买断一小时 Freebucks，而所有账号共享
  同一个出口，换号只会把所有账号的额度依次烧光。实测一次诊断 25 -> 5，
  正是这个选项的代价。
- **在 chat 层识别 503 并特判** —— 能拦住症状，但 503 不带业务体，
  无法区分"地理封锁"与"上游真的 5xx/瞬时故障"；把两者混为一谈会让真正的
  瞬时故障被误判成不可恢复。上游已经在 session 回执里**用明文给出了原因**，
  没理由去猜 503。
- **把 `countryBlockReason` 直接当 `banned`** —— 语义错。封号是账号终局，
  地理封锁换出口即恢复；混为一谈会让用户以为账号废了而丢弃可用账号
  （账号实测 `banned: false`、额度全满，只有出口被拒）。

## Consequences

- ⚠️ **2026-09-30 修订：只有真封锁才归一。** 初版把所有 `countryBlockReason`
  一律判成封锁，这是错的。官方源码
  （`common/src/constants/freebuff-countries.ts`）写明：
  "the union of the three full-access groups is the full-access allowlist;
  **everywhere else, and any VPN, is limited access**"。
  即 `anonymous_network` / `recent_limited_country` 落的是
  `accessTier: 'limited'` —— **可用档位**（模型集合变小、Freebucks 25→20），
  不是封锁。判成封锁 = 把可用账号判死并白烧额度。
  现由 `isTerminalCountryBlock()` 区分：只有 `country_not_allowed` /
  `anonymized_or_unknown_country` / `missing_client_ip` /
  `unresolved_client_ip` / `ip_privacy_lookup_failed` 走终止路径。
- 会话回执带**真封锁**时归一为 `country_blocked` 并**立即终止选号**，
  不再冷却账号、不再试下一个账号：出口级故障换号无意义，只会白烧额度。
- **已付费的会话窗口必须保留**：上游是照常建会话、照常扣费的（一次 admit =
  买断一整小时），所以回执里带着 `instanceId` 时就先落盘再抛错。归一化只
  **叠加**封锁标记，绝不替换掉整份回执 —— 替换会让那条会话无法寻址：
  DELETE 不掉（腾不出上游槽位）也追不回退款，等于把刚买的一小时白扔。
  这与「刷新不得抹掉活会话句柄」是同一条铁律（见
  [2026-09-15-console-readonly-refresh.md](../feature/2026-09-15-console-readonly-refresh.md)）。
- 用户看到的错误从 `503`（无信息）变成 `403 country_blocked` + 具体国家码，
  可据此去前端「代理设置」换出口 —— 这是唯一有效的处置。
- 账号**不会被冷却**：地理封锁不是账号的错，冷却它会让控制台误报"账号故障"。
- 只识别不绕过：代码不尝试换出口、不伪造地理位置。换出口始终是配置层的事。

## Evidence

- 真账号 `llh282000500@gmail.com`：`/api/v1/me` -> `200`、`banned: false`；
  `GET /api/v1/freebuff/session` -> `countryCode: "JP"`、
  `countryBlockReason: "country_not_allowed"`、额度充足。
- 随后 `POST /api/v1/chat/completions` -> `503`（无业务体），
  代理侧表现为 `http_503` -> 冷却换号 -> 再 503。
- 改前 `rg countryBlockReason src/` -> 0 命中。
