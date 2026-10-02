# 06 — 封禁实证：探测本身触发了 `status: banned`

> 这是本次逆向**最重要的一条实测因果**。写在前面，避免后人重蹈。

## 6.1 时间线

| 时刻 (UTC) | 动作 | 结果 |
|---|---|---|
| 14:57 | 首次 admission（官方登录态，MiMo 2.6 Flash） | **200 active** ✅ |
| 15:00~15:10 | 反复 admission / DELETE / 穷举端点与字段（约 40+ 次上游写请求） | 逐步出现 `purchase_capacity` |
| 15:19 | `GET /api/v1/freebuff/session` | **403 `{"status":"banned", "verificationReason":"region_locked"}`** ❌ |
| 15:19 | `GET /api/v1/me` | **200**（账号本身仍有效） |

## 6.2 结论

1. **ban 是 session 端点级的**，不是账号注销：`/api/v1/me` 仍 200。
   即：账号存在，但被禁止建立免费会话。
2. **高频 admission/DELETE 循环本身就是封禁触发器**。
   官方客户端的行为是"建一次会话用一小时"，而我几分钟内建/拆了几十次。
   这正是上游判定"自动化脚本"的行为特征。
3. `region_locked` 是**伴随说明**，不是根因：
   全程国家码一直是 `US` / `countryBlockReason: recent_limited_country`，
   且**首次 admission 在同一出口下是成功的** —— 出口没变，变的是请求节奏。

## 6.3 给后续工作的硬约束

- 协议探测**只用只读端点**（`GET /api/v1/freebuff/models`、`GET /api/v1/me`）。
- admission 是**买断一小时**的付费动作，一次成功的会话要用满，
  **绝不**为了试字段反复建/拆。
- 需要试 chat 变体时，在**同一条会话内**改请求体重试 ——
  改模型才需要重开会话，而重开前必须先把旧会话 DELETE 干净。
- 单账号单位时间内的 admission 次数要有硬上限。

## 6.4 与仓库现状的对应

仓库凭据 `1e600b3a`（llh282000500@gmail.com）在**任务开始前**就已经是
`403 {"status":"banned"}`；`9df44474` 被标 `banned` 冷却至 2026-10-03。
这两个账号的 ban **不是本次探测造成的**，是历史累积的。

本次新增：`54393a42`（loli@woa.qzz.io，官方客户端登录态）在探测过程中被封。
**教训**：不要把"唯一可用的真凭据"拿去做穷举式探测。
