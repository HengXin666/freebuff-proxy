# 17 — 现状盘点：哪个通过了，还差什么，影响是什么

> 2026-10-03 盘点。回答三个问题：
> 1. 我们的服务真的成功了吗？—— **分两个实现，别混**
> 2. 还差什么？
> 3. 每项会导致什么结果/影响？

## 一、哪个通过了？（必须分清）

| 实现 | 运行时 | 验证结果 |
|---|---|---|
| **`cli-bridge/`** | **bun**（官方客户端同一份） | ✅ **200 + write_file 工具调用**（已实测） |
| `src/proxy.js`（主服务） | Node / undici | ⚠️ **未验证** —— 被**配额**挡住，不是失败 |

主服务未验证的原因与协议无关：`ce620a8c` 有 `rate_limited` 冷却到
**明天 07:00 UTC**（北京时间 15:00）——正是 `07` 号文档记的
**每模型每日 6 次会话**配额耗尽。

**所以"我们的服务已经成功"这句话目前只对 cli-bridge 成立。**

## 二、cli-bridge 与官方的对齐度（三跳逐项核对）

| 跳 | 结论 |
|---|---|
| **admission** | 逐项一致。仅动态值不同（fetchId / attempt-id / sig / ts / instanceId）。我们**缺** `Accept` 与 `User-Agent: Bun/1.4.2`（官方 admission 用 Bun UA，不是 ai-sdk 那个） |
| **agent-runs** | 一致。官方 3 个业务头（authorization / content-type / acting-user-id），我们同样；agentId 已是 desktop 世代 `freebuff-desktop-thread-local-v3` |
| **chat** | body 顶层 / metadata / tools（37/37）/ system 首句全一致；头部仅 fetchId / sig / ts 三个必然动态值不同 |

**结论：cli-bridge 三跳与官方逐项对齐，剩余差异只剩传输层的
`Accept` 与 admission 的 Bun UA。**

## 三、还差什么 + 影响

### A. 主服务（src/proxy.js）未同步的 3 项 —— **结构性**

| # | 主服务现状 | 应为 | 不修的后果 |
|---|---|---|---|
| 1 | agentId = `base3-free-catalog`（**CLI 世代**） | desktop 世代：`freebuff-desktop-autorun`（manager）/ `freebuff-desktop-thread-local-v3`（worker） | 世代错配。这是当初 `free_mode_invalid_agent_model` / `session_model_mismatch` 的同类成因 |
| 2 | 工具集 = 自编签名工具（`lookup_agent_info` + `decide`） | 官方 37 个真实工具 | `lookup_agent_info` **在 desktop 37 工具里不存在**（我们从 CLI 侧抄的）。工具集指纹不匹配 → 上游降级/拒绝 |
| 3 | system = `You are Buffy, the strategic coding assistant.`（CLI 开场白） | 官方模板（worker 7918 字符 / manager 13443 字符） | 开场白是硬门禁。用错世代 → `free_mode_cli_required` 或降级 |

**已同步完成的 4 项**（无需再动）：
chat 删 `x-freebuff-instance-id` 头、UA 改 `runtime/bun/1.4.2`、
chat 只带 `catalog-fetch`、**instanceId 裸 UUID + 复用**。

### B. cli-bridge 自身的收尾项 —— 影响小

| 项 | 影响 |
|---|---|
| 缺 `Accept: */*` | 传输层，大概率无影响 |
| admission 用 ai-sdk UA 而非 `Bun/1.4.2` | 官方 admission 明确是 Bun UA；属指纹面，**建议补** |
| `repo_snapshot` worker 层已真实采集 ✅ | — |

### C. 绕不开的外部约束 —— **这个才是最大影响**

| 约束 | 数值 | 影响 |
|---|---|---|
| **每模型每日会话数** | **6 次**（limited 档） | 单账号单模型一天只能聊 6 轮。超出 → 503 + 全额退款 |
| **Freebucks 每日池** | 20（走代理时） | 每次 admission 按模型单价扣（deepseek 15/hr） |
| **并发槽位** | `slotLimit: 1` | 与官方客户端**互斥**——它在用，我们就 `purchase_in_use` |
| **封号** | 反复触网即触发 | 已毁 4 个账号 |

**这几条决定了产品上限**：单账号一天 6 次，意味着
**多账号池是刚需**，而不是优化项。

### D. bun 依赖 —— 待定，影响架构

cli-bridge 依赖 79MB 的 bun 二进制，与 AGENTS.md 的
「仅 2 个运行时依赖」**冲突**，也会撑大 Docker 镜像。

但**是否需要 bun 尚未证实**：
- 证据支持"不需要"：主服务纯 Node 跑起来后 catalog/签名/identity 全正常；
  且我们已证明 **TLS 不是失败原因**（对齐后形态正确才是）。
- 证据不足：主服务从未拿到 200（被配额挡）。

**待配额重置后做一次 Node 侧验证即可定论。若 Node 能通 → 删除 cli-bridge 与 bun。**

## 四、建议的下一步顺序

1. **等配额重置（明天 15:00）后，先用主服务（Node）验证一次。** ← 决定 bun 存废
2. 若 Node 不通 → 把 bun 合入主服务（或保留 cli-bridge 作为上游执行层）。
3. 同步 A 的 3 项（agent 世代 → 工具集 → system），每项独立验证。
4. 补 admission 的 `Bun/1.4.2` UA 与 `Accept`。

## 五、风险提示

**不要再拿真账号做穷举探测。** 已毁 4 个账号，当前 `ce620a8c` 也在
冷却中。后续每次验证都要：
- 先查 `rateLimitsByModel`（recentCount vs limit），满了就别发
- 单次请求，失败先读回执，不盲目重试
- 优先用 dry-run（`action: 'dryrun'`）做离线对比，零额度消耗
