# Agent Note: 目录 key 的显示名要有兜底；槽位占用不冷却账号

Status: implemented

## Problem

### 1. 总览的额度列显示裸目录 key

`AccountRuntimes._modelDisplayName(key)` 只查实时目录的 `displayNameForKey(key)`。
**目录未抓取时**（服务刚启动、或该 runtime 的 catalog 尚未 fetch）它一律返回
`null`，于是 `/api/overview` 的 `modelNames` 为 `null`，前端 `modelNameFor()`
三级取值全落空，界面渲染成裸 key（`m-096e75164d`），用户认不出是哪个模型。

实测（2026-10-03）：账号池额度键全是 `m-xxx`，而 overview 的 `modelNames` 为
`null`。

### 2. `ensureSession` 失败无条件冷却账号

`app-context.js` 的 `ensureSession` 循环里，只要失败就 `markCooldown(key, wrap)`，
**不区分错误码**。于是 `purchase_in_use`（瞬时槽位占用）也被冷却 —— 这违反
AGENTS.md 对 `purchase_capacity` 的明确规定（"它是资源竞争不是账号故障"），
而 `purchase_in_use` / `purchase_claim_released` / `premium_slot_taken` 属同一类。

实测反例：全新账号配额 0/6、无购买无退款，仅因上一次会话尚未释放而拿到
`purchase_in_use`，即被冷却到 20:20 —— "刚导入的干净账号立刻不可用"。

## Decision

1. **`_modelDisplayName` 加静态表兜底**：实时目录查不到时，用目录 key 的
   `legacyDigest` 反查内置静态表 `FREEBUFF_AVAILABLE_MODELS`，命中取
   `displayName`。手法与既有的 `_modelCatalogId` 完全一致。**不做模糊匹配**，
   也不用 `recommendedKey` 兜底（后者已被证伪：会静默换模型）。
2. **槽位占用类只告警、不冷却**：新增 `slotBusyCodes` 集合
   （`purchase_capacity` / `purchase_in_use` / `purchase_claim_released` /
   `premium_slot_taken`），命中时 `logger.warn` 后跳过 `markCooldown`。

## Alternatives considered

- **让 overview 主动 fetch catalog** —— 能解决，但把"读接口"变成"写网络"，
  首屏变慢且引入失败面。**否决**：兜底是纯本地查表，零成本零风险。
- **前端显示时兜底** —— 前端已有三级取值（后端映射 > 列表 display_name >
  去前缀 id），但后端 `modelNames` 为 null 时前端拿不到目录 key 对应的名字
  （静态表的 id 是 `deepseek/deepseek-v4-flash` 口径，与 `m-xxx` 对不上）。
  **否决**：换算必须在后端，那里才有 digest 索引。
- **无条件冷却（现状）** —— 简单，但把"槽位忙"当成账号故障，
  会把可用账号钉死一段时间。**否决**：AGENTS.md 已明确反对。
- **给槽位占用加重试而不是跳过冷却** —— 重试是对的，但那是 admission 层
  的事（cli-bridge 已做退避重试）；调度层不该叠加冷却。**否决**。

## Consequences

- 总览额度列/模型列在 catalog 未就绪时也能显示可读名。
  实测：`m-096e75164d` → `DeepSeek V4.1 Flash`，12 个模型全部有名字。
- 槽位占用不再冷却账号，账号不会被"假故障"钉死。
- `npm test`（smoke ok）与 `npm run typecheck` 全绿。

## Evidence

- 实测前：`modelNames: null`；实测后：
  `{"m-00032eaeec":"MiMo 2.6 Flash","m-096e75164d":"DeepSeek V4.1 Flash", ...}`
- 日志反例：`account cooling down; code: purchase_in_use until 20:20:01`
  （配额 0/6 的干净账号）
- AGENTS.md「额度 / 配额 / 负载均衡」段：`purchase_capacity` 明确不冷却。
- 附带实测：目录大小随设备签名变化（带签名 53 句柄 / 不带 13 句柄），
  两种情况下 `m-096e75164d` 都能命中。
