# Agent Note: 模型清单的权威是目录 rows,不是 session 回执的 rateLimitsByModel

Status: implemented

## Problem

账号额度满(Freebucks 25/25),未被封禁,但 `/v1/models` 与控制台
[同步上游模型]都报**没有任何可用模型**.

根因是三张表被当成了一张 —— 它们同时存在于同一份 session 响应里:

| 表 | 键数 | 含义 | 改动前被误用为 |
|---|---|---|---|
| `GET /api/v1/freebuff/models` 的 `rows` | 13 | **模型清单** | 只用来取 handle |
| `session.freebucks.prices` | 17 | 每模型单价 FB/h | 未用于清单 |
| `session.rateLimitsByModel` | 6 | 今日**给了会话额度**的子集 | **被当成模型清单** |

把清单建在最小那张表上,额度为 0 或未授予额度的模型就全部"消失"了.

两个次生根因:

1. 内置 `src/catalog/freebuff-catalog.json` 是 2026-08-27 快照,拿
   `legacyDigests` 反查今天的目录,13 行只命中 3 行;且上游新模型
   (Ling 3.1 Flash / Laguna S 2.1)**根本没有 legacyDigests**.
2. 两个入口都走 `runtimes.getAny()` 只探测一个账号,而已有的
   `probeAllAccountsSession()`(逐账号并集)没被用上.

证据:`docs/reverse/19-catalog-is-the-model-list.md`,
`docs/reverse/captures/2026-10-03-e2/`(77 条抓包 + 目录与 session 原文).

## Decision

**清单取目录行,额度/单价只作元数据,两者合并展示但不互相顶替.**

1. `CatalogHolder` 保存目录行全量(`rowByKey` / `rows()` / `row()`);
   新增 `runtimes.catalogRows()` 做跨账号并集,`refreshCatalogs()` 补抓 ——
   目录是懒加载的,而 `/v1/models` 常常是启动后第一个请求.
2. `runtimes.catalogQuota()` 只出 `{ rateLimits, prices, accessTier }`.
3. 新增 `src/catalog-models.ts` 的 `buildCatalogDrivenModelsResponse()`:
   以目录行的 `displayName` 为 `id`(可读),`freebuff_key` 透出 `m-xxx`.
   用户明确要求对外模型名必须可读,且对外 API 与控制台口径一致.
4. `isModelAllowed` 新增 `catalogKeys`(key + 可读名两个口径),否则目录里
   当日额度为 0 的模型会被 `model_not_allowed` 拒掉.
5. catalog 请求头对齐官方 4 项,删掉多发的 `x-codebuff-api-key`
   (全 77 条抓包出现 0 次)与串台的 session 头.
6. 前端[上游暂无可用模型]改为仅在**目录抓取失败**时提示.

### 为什么 buildCatalogDrivenModelsResponse 单独成文件

放在 `src/model.ts` 里时,在与 model.js 同进程,进程早期调用的场景下,
结果对象的部分字段会出现"键存在但读不到"的现象.独立成
`src/catalog-models.ts` 后行为确定(真实服务与离线测试两侧都验证过).

## Consequences

- `/v1/models` 与 `/api/models` 现在给的是**上游此刻真实的全部模型**
  (13 行,与客户端 UI 菜单逐项一致),而不是"今日有额度的那几个".
- 对外 id 从 `deepseek/deepseek-v4-flash` 这类 2026-08 的过时名字,
  变成目录原文 `DeepSeek V4.1 Flash`;旧的可读 id 仍可通过
  `catalogId` 与 `freebuff_key` 反查,不会硬性断掉老客户端.
- 内置静态 catalog 不再是模型清单的来源(它只在目录抓取失败的回落路径
  里兜底),避免"快照漂移导致清单长期对不上".
- 控制台  标注改按 `rate_limit` 判定,不再依赖只有 6 个键的那张表.

## Alternatives considered

- **什么都不做**:不行,用户线上就是[没有任何可用模型].
- **改用 `freebucks.prices` 当清单**:它有 17 个键,但其中 4 个
  (`m-0a6f9dd646` / `m-3b095d8b43` / `m-79033aedfe` / `m-f8d6ac83f8`)
  **连目录里都没有**,会多出 4 个根本发不出去的模型.
- **继续用内置静态 catalog + legacyDigests 反查**:那份是 2026-08 快照,
  13 行只命中 3 行,且新模型没有 legacyDigests —— 覆盖面会越修越差.
- **保留 rateLimitsByModel 作为清单的补充**:会重新引入"额度决定清单"
  的耦合,那正是本次故障的成因.它只作元数据.

## Verification

起真实服务实测:`/v1/models` 返回可读模型名清单(单价/额度/accessTier
正确挂载),`/api/models/upstream` 不再为空,用可读名 `DeepSeek V4.1 Flash`
请求 chat 被白名单放行并解析为 `m-096e75164d`.

 该轮实测曾报告"53 条",那是**catalog 抓取多带了设备签名**换来的另一份
响应(客户端不签名,只有 13 行且与 UI 菜单逐项一致).53 不是真值,
已修正为不带签名(见 docs/reverse/19 §19.2),本 note 不再以 53 为判据.

离线回归 `test/verify-catalog-models.mjs`(13 行真机目录):钉住
"13 条而非 6 条",id 可读,额度为 0 仍在清单,白名单放行,假模型仍拒.
