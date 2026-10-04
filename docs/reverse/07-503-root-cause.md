# 07 — 503 的真因:每模型每日会话额度(不是请求形态)

> 结论先行:`503 The model is temporarily unavailable` **不是**请求形态问题,
> 是 **每模型每日会话次数用尽**.这个结论花了很多步才拿到,写在这里避免复踩.

## 7.1 现象

用全新账号(`891481a7`,`25/25` Freebucks 满额)跑完整链路:

```
catalog    200
admission  200 active     ← 会话真的建成了，扣了额度
agent-runs 200 runId
chat       503 {"error":{"message":"The model is temporarily unavailable.","code":503}}
```

随后再发 → `409 session_superseded`("This model purchase was refunded"):
**上游把这次购买作废并退款**,所以 balance 一直是 25.

## 7.2 误判过程(走过的弯路)

先怀疑了这些,**全部排除**:

| 怀疑 | 验证 | 结果 |
|---|---|---|
| model 表示法(handle vs key) | 两种都试 | 非此因(mismatch 已单独消除) |
| `surface: cli` 与 desktop 会话矛盾 | 改 `surface: desktop` | 仍 503 |
| 工具集不合法 | 只留官方签名工具 | 仍 503 |
| 0 价预览模型不可用 | 换 15 / 5 价模型 | 仍 503 |
| 出口 IP 与客户端不一致 | 直连出口 `US`,与 admission 返回的 `countryCode: US` 一致 | 非此因 |

**三个价格档,多个模型,多种身份组合全部 503** —— 说明变量不在请求里.

## 7.3 真因:`rateLimitsByModel` 打满

读 admission 响应 / `GET /api/v1/freebuff/session` 的 `rateLimitsByModel`:

```jsonc
"rateLimit": {
  "model": "m-22ff70c712",
  "entitlementBreakdown": { "base": 6, "referral": 0, "streak": 0 },
  "limit": 6,
  "recentCount": 6,                     //  已用满
  "pool": "limited",
  "poolLabel": "Daily",
  "period": "pacific_day",
  "resetTimeZone": "America/Los_Angeles",
  "resetAt": "2026-10-03T07:00:00.000Z",  // 北京时间 15:00
  "windowHours": 24
}
```

全量核对(同一时刻):

```
m-00032eaeec  recent=6  limit=6
m-096e75164d  recent=6  limit=6
m-69307952f8  recent=6  limit=6
m-9a7e098cc1  recent=6  limit=6
m-22ff70c712  recent=6  limit=6
m-7e20df6765  recent=0  limit=0      ← 这个免费档根本没额度
```

**limited 档每模型每天 6 次会话**,我的探测正好把它打满了.
`limit=0` 的模型(GLM 5.3 Flash,价格 25)在免费档下完全不可用.

## 7.4 与 Freebucks 是两本账

- **Freebucks**:按小时计费的钱包.503 后自动退款,所以 `balance` 恒为 25.
- **rateLimit**:每模型每日**会话次数**.它不退款,用满就是次日 07:00Z 才恢复.

所以"额度看起来没少"是假象 —— **花钱的那本账退了,次数的那本账没退**.
这和 `AGENTS.md` 里记的"两本账并行"是同一个结构,但此前记的是
`session_units` vs Freebucks,**这里还有第三本:每模型每日会话次数**.

## 7.5 处置

1. 判据:chat 收到 503 时,先读 `rateLimitsByModel` 看 `recentCount >= limit`,
   **不要**当成"模型暂时故障"去换模型重试 —— 换模型只会把另一个模型也打满.
2. 归入冷却码:`model_unavailable` 语义应细分出 **`daily_session_quota_exhausted`**,
   它的冷却时长 = 到 `resetAt` 的时间(跨小时级),而不是分钟级重试.
3. admission 之前就该查 `rateLimitsByModel`:已满就**不要** admit
   (admit 买断一小时,明知失败还买就是白烧钱).

## 7.6 教训

探测前先看配额,别拿真凭据穷举.本次 6 次探测正好等于每日上限 ——
一次不剩.见 `06-ban-forensics.md` 的硬约束.
