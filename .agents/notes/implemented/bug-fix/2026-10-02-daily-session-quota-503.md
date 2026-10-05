# Agent Note: chat 的 503 要按[每模型每日会话额度耗尽]归因,不能当模型故障

Status: implemented

## Problem

有限档位(limited tier)下,完整链路
`catalog → admission(200 active) → agent-runs(200 runId)` 全部成功,
**唯独 `POST /api/v1/chat/completions` 返回 503**:

```
{"error":{"message":"The model is temporarily unavailable. Please try again later.","code":503}}
```

随后同一会话再发变成 `409 session_superseded`("This model purchase was refunded"),
而账号 `balance` 一直是满额 25 —— 看起来"钱没花,模型坏了".

排除法验证过,**全部不是**成因:model 表示法(handle vs key),
`surface: cli` 与 desktop 会话的身份矛盾,工具集不合法,
0 价预览模型不可用,出口 IP 与官方客户端不一致.
三个价格档(0 / 5 / 15)多个模型全部 503,说明变量不在请求里.

真因在 session 回执的 `rateLimitsByModel`:

```
m-00032eaeec  recent=6 limit=6   resetAt=2026-10-03T07:00:00.000Z
m-096e75164d  recent=6 limit=6   resetAt=2026-10-03T07:00:00.000Z
m-22ff70c712  recent=6 limit=6   resetAt=2026-10-03T07:00:00.000Z
m-7e20df6765  recent=0 limit=0
```

limited 档**每模型每天 6 次会话**(`period: pacific_day`),用满即 503.
它与 Freebucks 是两本账:**503 后上游自动退款**(所以 balance 不变),
但**次数那本账不退**.于是"额度看起来没少"是假象.

危害在归因:把它当成"模型暂时故障"去换模型重试,
只会把下一个模型也打满 —— 6 次探测正好等于每日上限,一次不剩.

## Decision

**新增 `dailySessionQuota(quota, model)`(`src/upstream/client.ts`)导出,
把 session 回执里的 `rateLimitsByModel` / `rateLimit` 读成
`{ exhausted, resetAtMs, limit, recentCount }`.**

判据:
- `exhausted = limit <= 0 || recentCount >= limit`.
  `limit=0` 单独算一类:免费档下该模型根本没额度(实测 `m-7e20df6765`),
  它不是"用完了"而是"没有",但同样必须视为不可用.
- `resetAtMs` 取 `resetAt` 的最晚值,供冷却时长用(跨小时级,不是分钟级重试).
- 指定了 model 时优先读该模型行;未指定时取所有行的 `limit` 最小值与
  `recentCount` 最大值(保守判定).
- 拿不到 `limit` / `recentCount` 就返回 `exhausted: false` ——
  **宁可不识别,也不猜**.老上游或没有该字段的账号行为不变.

本次只落判据函数,**不**改 `extractRateLimitError` 的返回码集合:
503 目前仍走 `model_unavailable` 的 per-model 冷却路径,
改变它的语义属于行为改动,需要单独的验证与 note.

## Alternatives considered

- **什么都不做 / 沿用"模型暂时故障"** —— 最省事,且现有代码确实能跑.
  但这是**错误归因**:症状是 503,真因是配额,而错误归因的直接后果是
  代理会去换模型重试,把健康的模型逐个打满 —— 把一个"等一天就好"的问题
  变成"整个账号当天报废".实测 6 次探测正好打满,正是这个机制的代价.
- **直接把 503 归一进 `RATE_LIMIT_CODES`,让它走换号重试** —— 换号同样无效:
  这是**每模型**额度,不是账号额度,换一个账号只会消耗另一个账号的额度.
  且它会让 `model_unavailable` 失去 per-model 冷却的语义(会误伤整个账号).
- **在 admission 之前就拦截(查额度再决定要不要 admit)** —— 这才是根治,
  但需要把 quota 状态接进调度选号路径,改动面大得多.
  先落判据函数,让归因可观测,根治留到接调度时做.

## Consequences

- `dailySessionQuota` 是纯函数,无 IO,可单测;已覆盖 5 个用例
  (满额 / 未满 / limit=0 / 空输入 / 无该模型).
- 不触及任何现有码路径,行为零变化:`npm test` 与 `npm run typecheck` 全绿.
- 未被识别的 503 表现与改前完全一致.

## Evidence

- 实测:全新账号 `891481a7`,`freebucks.balance=25` 满额,
  admission `200 active`,agent-runs `200`,chat 连续 3 个价格档 503.
- 实测:`rateLimitsByModel` 五个模型 `recent=6 limit=6`,
  `period: pacific_day`,`resetAt: 2026-10-03T07:00:00.000Z`.
- 实测:503 后 `balance` 恒为 25(上游退款),证明与 Freebucks 是两本账.
- 实测:单测 5 例通过(满额 true / 未满 false / limit0 true / 空 false / 无该模型 true).

详见 `docs/reverse/07-503-root-cause.md`.
