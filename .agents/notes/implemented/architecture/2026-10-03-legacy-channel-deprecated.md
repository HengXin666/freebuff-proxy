# Agent Note: legacy 通道废弃;上游请求一律走副仓库 RPC

Status: implemented

## Problem

主服务(Node)里那套**自己拼的上游链路**——`ensureFreebuffSystemMessages()` +
`ensureFreebuffToolSignature()` + CLI 世代 agent + 自管 session 调度——
与官方抓包**逐字段不符**,且实测反复失败:

- system:CLI 开场白 vs 官方模板(7918/13443 字符)
- tools:自编签名工具(`lookup_agent_info` 在官方 37 工具里**根本不存在**)
- agent:`base3-free-catalog`(CLI 世代)vs desktop 世代
- 实测:admission 反复返回 `purchase_claim_released` / `admit_failed`

同时它制造了一个危险的假象:**看起来在跑,实际全被拒**.用户看到 429 而非
"链路走错".

而副仓库(cli-bridge / bun)同账号同一时刻稳定成功
(200 + `write_file` 工具调用).

## Decision

**legacy 通道废弃,禁止调用;上游请求一律走副仓库 RPC.**

实现要点:

- `config.resolveUpstreamChannel(settings, config, warn)`:唯一判定入口.
  legacy **硬回落** official 并告警(不是照旧执行).
- `proxy.js` 三处内联判定统一改用该函数.
- 控制台下拉:legacy 选项保留但 `disabled`(用户看得见"曾经有过,现在不能用",
  而不是凭空消失造成困惑).
- 文档标注废弃,并更新自测结果.

为什么是"硬回落"而不是"尊重用户选择":继续调用旧链路只会产生全被拒的结果,
尊重它没有意义,只会让用户以为服务在跑.

## Alternatives considered

- **保留 legacy 作为回退** —— 曾这么做.但它的失败是**系统性**的
  (形态不符),不是偶发,作为回退没有价值.**否决**.
- **直接删除 legacy 代码** —— 最干净,但会让读代码的人不知道这段历史,
  且旧配置文件里的 `legacy` 会变成未知值.**否决**:保留值 + 硬回落 +
  前端置灰,兼顾兼容与明确.
- **让 legacy 与 official 并存,用户自选** —— 用户明确要求"废弃主仓库 API,
  禁止调用".**否决**.

## Consequences

- 上游请求只有一条路径:主服务 → RPC → 副仓库(cli-bridge).
- 旧配置 `channel: legacy` 不会报错,自动走 official 并留告警.
- 前端无法再选到 legacy.
- `npm run typecheck` 全绿.

## Evidence

- 副仓库自测(2026-10-03,账号 `4c2bb9ab`):
  `ADMIT 200 active / STARTRUN 200 / CHAT 200 / TOOLCALL write_file`.
- 主服务旧链路实测:admission 反复 `purchase_claim_released`.
- 官方抓包逐字段 diff:`docs/reverse/14-captured-diff.md`,
  `15-protocol-review.md`.

## 遗留(与本次废弃无关)

`npm test` 有 **两个并发/时序敏感的既有失败**(`上游并发峰值应为 3, got 2`,
`max 2 concurrent streams, got 1`).已验证**干净 HEAD 上同样失败**,
与本次改动无关,但需在后续单独修(疑似调度计时在高负载下不稳).
