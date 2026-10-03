# Agent Note: 「同步上游模型」按钮自己抓目录（一键刷新只跑 session）

Status: implemented

## Problem

把 `/api/models/upstream` 改成纯读缓存后，**「同步上游模型」按钮点了永远是空**。

原因是我自己引入的错配：

- 「同步上游模型」→ `/api/models/upstream` —— 被我改成**只读缓存、不发请求**。
- 「一键刷新」→ `/api/accounts/refresh` —— 只跑 `probeAllAccountsSession()`
  （session GET），**根本不抓目录**。

于是没有任何一个按钮会去抓目录：想拿清单的按钮不发请求，发请求的按钮
不抓清单。目录永远为空，`syncUpstreamModels` 每次都弹「上游暂无可用模型」。

## Decision

`/api/models/upstream` **恢复为允许抓目录**。

它对应的是用户**主动点击**「同步上游模型」，属于
`docs/reverse/20 §20.3` 里唯一被允许的探测时机（用户主动）。
调用 `refreshCatalogs({ force: true })` 强制重抓（不带 force 时
`CatalogHolder.fetch()` 命中缓存会直接返回 true，等于不抓）。

`/v1/models` 与 `/api/models` 仍然**纯读缓存、零自动探测** —— 那是被
下游客户端高频访问的接口，不该在首访时触发上游请求。

## Consequences

- 「同步上游模型」点一次 = 抓目录 + 顺带补一次 session（拿额度/单价），
  一次点击拿到**完整清单**（名字 + 价格 + 额度）。
- 「一键刷新」也同时抓目录与会话 —— 两个按钮都能一次搞定，不再需要
  用户点两个才凑齐数据（这个割裂是我上一版造成的）。
- 想更新就再点一次：`refreshCatalogs({ force: true })` 会真重抓
  （实测连点两次 = `catalog fetched` 计数 2，不是命中缓存直接返回）。
- 请求量：一次点击 = 2 个只读 GET（models + session），
  无 admission、无 chat。

## Alternatives considered

- **给「一键刷新」加上抓目录**：也能修，但职责会糊 —— 它现在的契约是
  "只读刷新账号状态、不创建/释放会话"，塞进抓目录会让一次点击发两类请求。
  保持"谁要清单谁抓"更直白。
- **让 `/v1/models` 恢复自动补抓**：违反用户明确的零自动探测裁决，不行。
- **什么都不做**：按钮永远空，等于功能报废。
- **只让「一键刷新」抓目录、同步按钮仍读缓存**：能修，但用户点「同步
  上游模型」却拿不到新目录，语义对不上 —— 按钮名字说的是同步上游。
  最终两个按钮都补齐（谁点都能更新）。

## Verification

起服务实测（`data/catalog-cache.json` 已删、全新进程）：

1. 启动 → 日志外部请求计数 0；`/v1/models` 返回 `{data:[],notProbed:true}`。
2. 点「同步上游模型」→ 返回 **13 条**，`catalogVersion: v0.g1.e82918`，
   单价全部正确（MiMo 10 / DeepSeek 15 / GPT-6.1 Sol 100 …）。
3. 随后 `/v1/models` 返回同样 **13 条**，`notProbed` 消失 —— 未多发请求。
4. 日志中 `session/admission` 与 `chat/completions` 计数均为 **0**。
5. **更新可用**：连点两次同步 → `catalog fetched` 计数 2，确认是真重抓
   而非读缓存（版本串相同只是上游几分钟内没变版本）。
6. 只点「一键刷新」一次 → `catalogRows: 13` + 会话刷新，两件事都完成。

13 条与客户端 UI 模型菜单实测的 13 项一致（去掉 catalog 设备签名后
不再出现 53 行那份偏离响应，见
`2026-10-03-catalog-fetch-unsigned.md`）。
