# 18 — 两条链路怎么选、有什么区别、客户端带工具时怎么处理

> 面向使用者。回答三个问题：
> 1. 最安全最推荐用哪个？
> 2. 两条链路有什么区别？
> 3. 客户端（比如带自己的工具定义）发请求过来，这里怎么转换？

## 一、两个通道

| 通道 | 是什么 | 状态 |
|---|---|---|
| **official** | **照抄官方客户端抓包真值**：官方 37 工具、官方 system 模板、desktop 世代 agent、分层 provider | ✅ **当前默认，推荐** |
| legacy | 旧的自拼形态（CLI 开场白 + 自编签名工具 + `base3-free-catalog`） | 回退保留 |

**控制台 → 设置 → 「上游请求链路」** 可切换，立即生效、重启保持。

## 二、推荐哪个？—— official

理由（都有实测支撑）：

1. **它是照抄，不是猜测。** 字段直接取自官方客户端真实流量
   （`docs/reverse/captures/2026-10-03-official-client.jsonl`），
   可逐字段核对；legacy 来自早期第三方项目加多年补丁，已无法核对。
2. **实测通过。** 2026-10-03 用 official 形态拿到
   **HTTP 200 + `write_file` 工具调用**（`16-success-200-with-toolcall.md`）。
3. **消除了身份/世代错配。** legacy 用 CLI 开场白 + CLI 世代 agent，
   但会话是 desktop 建的 —— 自己跟自己矛盾，这正是历史上多次被拒的根源。

**唯一提醒**：official 在主服务（Node 侧）尚未实机验证过
（cli-bridge 侧验证过；主服务当时被**配额**挡住，不是失败）。
所以保留了 legacy 作为一键回退。若遇到异常，切回 legacy 即可。

## 三、区别（逐项）

| 项 | legacy | official |
|---|---|---|
| system | CLI 开场白 2 句 | 官方模板（worker 7918 / manager 13443 字符，含 Git 摘要、规则、日期） |
| tools | 客户端工具 + `lookup_agent_info`/`decide` | 官方 37 个真实工具（+ 客户端工具合并） |
| agent | `base3-free-catalog`（CLI 世代） | `freebuff-desktop-thread-local-v3`（desktop 世代） |
| provider | 无 | worker `data_collection: deny`；manager `allow_fallbacks: true` |
| `tool_choice` | 无 | `auto` |
| 思考强度 | 顶层 `reasoning_effort` | `codebuff_metadata.freebuff_reasoning_effort`（官方只在后者，顶层 0 次命中） |
| metadata | 含 `surface` / `freebuff_client_env` | 官方没有这两个（是 CLI 侧的），已移除 |

> 注：`lookup_agent_info` 在官方 desktop 的 37 工具里**根本不存在** ——
> 它是我们从 CLI 侧抄来的。

## 四、客户端带自定义工具时怎么处理

**场景**：下游客户端（任意 OpenAI 兼容客户端）发请求，自己带
`tools: [{name: "run_code"}, {name: "get_weather"}]` 之类。

**处理：合并，不是替换。**

```
发出去的 tools = 官方 37 个  +  客户端工具（按 function.name 去重，官方优先）
```

- **为什么要保留官方 37 个**：工具集本身是上游的指纹判据之一，
  只发自定义工具会被当作外来客户端。
- **为什么不只发官方的**：那样客户端的自定义工具会**静默消失** ——
  用户以为声明了能调，实际根本没发出去。
- **去重**：客户端若声明了官方已有的名字（如 `write_file`），
  以官方定义为准，不重复追加。
- **客户端没声明工具时**：不发工具集 —— 没要工具就不背 37 个的 token，
  也不凭空引入工具调用可能。

实测（dry-run，零额度）：官方 37 + `my_custom_tool` = **38 个**；
`write_file` 只出现 1 次（去重生效）。

**工具调用结果的归属**：本代理**不执行**工具。上游返回的是
`tool_calls` **请求**（如"请调用 write_file"），代理原样返回给下游客户端，
由客户端自己执行并回传结果。所以"文件有没有真的创建"取决于客户端，
不是代理 —— 拿到结构完整的 `tool_call` 即为链路打通。

## 五、架构：为什么不是在主服务里再写一遍

official 形态的实现**只有一份**，在 `cli-bridge/`（用官方同款 bun 执行）。
主服务（Node）**不复制**那份逻辑，而是 RPC 委托：

```
主服务（Node）                     副仓库（cli-bridge, bun）
  持有 instanceId / runId      →     desktop 世代 startRun
  通道判定                            官方形态构造 + 发送 chat
  透传响应                      ←     原始响应
```

主服务只传 `instanceId + messages + tools`，拿原始响应透传给下游。

**为什么这样**：两份实现必然漂移，官方形态一变要改两处；而且等于把
已实测通过的逻辑丢掉重写。用副仓库的 `reuse`（只 startRun + chat，不
admission）—— 主服务已做过 admission，不该再买一次（一次 admit = 买断一小时）。

**降级**：副仓库不可用/失败时，请求体会补成 legacy 形态再走原路径，
不会发出"既无官方 system 也无签名工具"的畸形请求。

## 六、回退与验证

- 出问题：控制台切回 **legacy**，无需重启。
- 验证前先看配额：`GET /api/v1/freebuff/session` 的
  `rateLimitsByModel`（`recentCount` vs `limit`）。**满了就别发** ——
  每模型每日 6 次，超出会 503 且退款。
- 离线对比（零额度）：`FREEBUFF_DUMP_DIR=... action=dryrun`
  生成请求样本，再用 `tools/diff-request.py` 与官方抓包 diff。
