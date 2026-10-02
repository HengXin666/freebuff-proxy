# Agent Note: 模型映射修好后 chat 仍 503 —— 503 不是模型映射的充分判据

Status: implemented

## Problem

[2026-10-01-session-bound-model-authority.md](2026-10-01-session-bound-model-authority.md)
的结论是：chat 503 来自「会话绑 MiMo + agent 用 deepseek」的模型错配，修好映射即可消除。

2026-10-01 用新账号端到端实测，**映射已修好，503 依旧**：

```
11:15:11 freebuff session active   model=m-096e75164d  accessTier=limited
11:15:11 started agent run         agentId=base3-free-catalog
11:15:11 chat forward model resolved
         requested = deepseek/deepseek-v4-flash
         assigned  = m-096e75164d        ← 会话权威模型，与请求一致
         outgoing  = fbm1.AAEAAUPeE7tq…  ← 该行的服务端句柄
11:15:12 upstream chat non-ok      status=503
         {"error":{"message":"The model is temporarily unavailable.
                             Please try again later.","code":503}}
```

三个此前各自被指为根因的环节这次**全部正确**：legacyDigests（FNV-1a）映射命中
`m-096e75164d`（非 MiMo）、agent 与系统开场白同代（catalog agent 是 base3，
开场白走 base3 canonical）、wire 上的 tools 经本地判据
`detectForeignClient` 计算 `signal === null`（`["get_weather","lookup_agent_info","decide"]`，
`hollowToolNames`/`foreignToolNames` 均为空）。

所以 `The model is temporarily unavailable` **不是**"模型映射错"的充分判据 ——
它是一个**不携带原因的通用文案**，映射正确时同样会返回。

⚠️ 样本量 = 1 次 chat（n=1），且只有 deepseek-v4-flash 一个模型。本文主张的是
"映射修好不足以消除 503"（一个**否定性**结论，n=1 足以成立），**不是**
"503 的真实原因已定位"。

## Decision

**把 503 从"模型映射的判据"降级为"待归因的通用失败"，不再据此反推根因。**

具体落在三处认知上（代码本次未随之改动，因为还没有可判定的替代判据）：

1. 不再把 `The model is temporarily unavailable` 当作映射错误的证据 —— 它
   与映射正确与否**独立**；
2. 会话回执的 `accessTier: 'limited'` 是 503 的**共存条件**而非证明：
   本次实测账号正是 limited，与
   [2026-09-30-country-block-reason-in-200.md](2026-09-30-country-block-reason-in-200.md)
   记录的"受限出口下 chat 一律 503"是同一类现场；
3. 归因 503 必须拿到**带原因的响应体**或换通道对照（网页通道
   `webChannelEnabled` 是现成的对照组），而不是继续在 CLI 通道上改字段试错。

## Alternatives considered

- **继续修 CLI 通道的字段（UA / 头 / metadata）** —— 最强理由是：此前几轮正是
  靠逐字段对齐官方解决了一批问题。但本次三个已对齐的环节同时正确却仍 503，
  说明剩下的差异不在已测绘的字段面上；继续盲试的每一次都要付出一次 admit，
  而代价已经实测出来了（见 Consequences）。
- **判定 503 = 出口受限，直接改用网页通道** —— `webChannelEnabled` 已实现且
  [2026-09-30-web-chat-stream-transport.md](../feature/2026-09-30-web-chat-stream-transport.md)
  记录的正是"limited 下 CLI 通道 503、网页通道正常"。它是对照组的正确用法，
  但直接切换等于在没有对照证据时改默认行为；本次账号已被封，无法补做对照。
- **什么都不做，保留 503 = 映射错 的旧结论** —— 会让下一个 agent 继续在已修好
  的映射上找 bug（本次就是这样浪费了两轮）。旧结论必须被显式推翻。

## Consequences

- 503 不再被当作映射层的判据；后续归因需要带原因的响应体或通道对照。
- ⚠️ **实测代价（重要）**：同一账号在 chat 503 之后**紧接着**换模型再 admit，
  上游直接判 `banned`，冷却 24 小时（`until 2026-10-02T11:16:35Z`）。
  即 503 之后再试不是"免费重试"，而是可能把账号当场搭进去。
  这条与 AGENTS.md 的"一次 admit 买断一小时"是两回事：这里是**账号级封禁**。

## Evidence

- `/tmp/fbp.log`（2026-10-01）时间线：会话 active `m-096e75164d` → agent run
  `base3-free-catalog` → chat 503 → 冷却 → 会话释放（refund 0, balance 10）
  → 第二次 admit → `banned`（24h）。
- 离线复核：wire tools 经 `detectForeignClient` 得 `signal: null`；
  `isBase3Agent('base3-free-catalog') === true`（与 base3 开场同代）。
- `npm test` 通过、`npm run typecheck` 干净、`npm run verify-notes` 全绿。

## Testing

- 端到端 n=1（受账号封禁限制，无法扩大样本）。
- 离线：`detectForeignClient` 对实际 wire 工具集得 `signal: null`；
  `freebuffLegacyModelDigest('deepseek/deepseek-v4-flash') === '1e303ac563a6f9cc'`
  对应行 `m-096e75164d`（与会话回执一致）。

## Related

- [2026-10-01-session-bound-model-authority.md](2026-10-01-session-bound-model-authority.md)：
  本文推翻它"修好映射即可消除 503"的结论；映射机制本身（会话模型权威）仍然成立。
- [2026-10-01-legacy-model-digest-mapping.md](2026-10-01-legacy-model-digest-mapping.md)：
  legacyDigests 映射（本次实测确已生效）。
- [2026-10-01-catalog-agent.md](2026-10-01-catalog-agent.md)：目录模式统一 agent
  （本次实测确已生效，且与开场白同代）。
- [2026-09-30-web-chat-stream-transport.md](../feature/2026-09-30-web-chat-stream-transport.md)：
  limited 档位下网页通道是 CLI 通道 503 的现成对照组。
- [2026-10-01-settings-optional-chain.md](2026-10-01-settings-optional-chain.md)：
  本次排查中修掉的读开关写法（它曾让故障伪装成"上游判第三方客户端"）。
