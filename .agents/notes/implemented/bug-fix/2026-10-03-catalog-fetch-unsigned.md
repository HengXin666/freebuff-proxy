# Agent Note: catalog 抓取不带设备签名 —— 带签名会拿到 53 行，那不是真值

Status: implemented

## Problem

同一账号、相隔数秒的两次 `GET /api/v1/freebuff/models`：

| 请求方 | 设备签名 | version | rows |
|---|---|---|---|
| 官方客户端（抓包） | **不带** | `v0.g1.e82917` | **13** |
| 我方 curl（那 1 次） | 不带 | `v0.g1.e82918` | **13** |
| 主服务 `CatalogHolder` | **带** | `v0.g1.e82918` | **53** |

主服务此前拿到 53 行，被当成"更全的真实清单"写进了文档与 note。
**那是错的。**

13 才是客户端口径：抓包里客户端那 13 行与**客户端 UI 模型菜单实测的
13 项逐项一致**（`docs/reverse/13` §13.3 与本次 CDP 实测 `.agent-option`
两项吻合）。

53 的成因：`src/upstream/client.js` 给 `CatalogHolder` 的 `fetchImpl`
加了设备签名三头，而客户端在这一跳**不签**。165 条抓包里只有
`/api/v1/freebuff/session` 带签名（13 次），`/models` 与 `/device-keys`
都不带。多带一个客户端没有的特征 → 上游返回了另一份目录。

## Decision

`CatalogHolder` 的 `fetchImpl` **不再加设备签名**，头集与客户端逐字节一致：

```
Authorization: Bearer <token>
x-freebuff-catalog-protocol: 1
x-freebuff-client: desktop
User-Agent: Bun/1.4.2
Accept: */*
```

官方时序是 catalog（无签名）→ device-keys → session（开始签名），
签名不是"加了更保险"，而是形态偏离。

同时更正所有以 53 为判据的表述（两篇 note + `docs/reverse/19` §19.9）。

## Consequences

- 目录行数回到与客户端一致的 13（该账号口径）。
- 之前"53 条模型"的说法作废；任何拿 53 做过判断的结论都要重看。
- 设备签名仍然发 —— 只是从 session 那一跳开始（客户端也是这样）。

## Alternatives considered

- **保留签名，用 53 行当清单**：不行。它是我们形态偏离后换来的响应，
  不是上游"给客户端的清单"；拿它当真值等于把偏差固化成产品行为。
  且 53 行里有一批模型客户端根本看不到，选了就会发到上游不认的 key。
- **保留签名但只用两集合的交集**：交集仍是 13，等于脱裤子放屁，
  还白白多带一个非客户端特征。
- **什么都不做（继续用 53）**：用户明确指出"没从客户端对齐过的一律作废"，
  这条直接命中。

## Verification

- `src/upstream/client.js` 的 catalog `fetchImpl` 只剩 `fetchWithProxy`，
  日志不再出现 `catalog fetch: adding device signature`。
- 抓包复核：165 条里 `/models` 与 `/device-keys` 均无签名头，
  `/session` 13 次带签名。
- 13 行与 UI 菜单 13 项逐项一致（脚本比对 `sorted(names) == sorted(ui)`
  为 True）。

## 教训

任何"我方拿到了更多/更好数据"的结果，第一反应应当是**怀疑自己的形态
偏离了**，而不是当成收获。
