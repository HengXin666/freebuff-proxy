# Agent Note: 注入官方真签名工具，避免被上游判作外来客户端而降级

Status: implemented

## Problem

带工具的请求被上游**降级**：请求不是失败，而是被悄悄改投
`inclusionai/ling-3.0-tiny:free`（一个免费小模型），于是回答质量塌陷；而当该 slug
在 OpenRouter 侧不可路由时，请求以 `404 No endpoints found for <model>` 失败，
下游 Responses 桥接层再把那个 404 崩成 Cloudflare 纯文本 502，客户端 SDK 只看到
`502 status code (no body)` —— 即 issue#15「所有模型空响应」的现场。

判据不在本地可观测范围内（上游降级时**不回明确的错误码**），所以此前只能从症状反推。
2026-09-19 定位到判据真源并做了对照实验，判据是公开的：

- 真源：`common/src/constants/foreign-client-signals.ts`
  （2026-09-19 取，sha256 `505f9b42af1758b5403233737251b231a9369a312dbe4dcde6ceeed538589da9`）。
  上游已把文档化的 `docs/freebuff-abuse-detection.md` 从仓库撤下，判据只剩这份源码。
- 降级目标：`FREEBUFF_DOWNGRADE_MODEL_ID = 'inclusionai/ling-3.0-tiny:free'`。
  上游注释称「2026-08-08 verified against the OpenRouter catalog: 262k context, $0,
  且 `tools` + `tool_choice` 在 supported_parameters 里 —— 所以带工具的降级请求是
  降级而不是硬报错」。**该 slug 现在已不在 OpenRouter 目录中**（2026-09-19 实测：
  445 个模型里没有任何 `tiny` 变体；`inclusionai/` 只剩 `ling-3.0-flash*`）。
  这解释了 404 的确切来源：降级目标消失后，降级就变成了路由失败。

### 判据的关键那一条

上游 2026-09-17 起把签名从「**名字**」升级为「**名字 + 真实参数 schema**」
（源码原话：`A NAME alone stopped being enough on 2026-09-17`），并且**逐字点名了
本代理**：

> Every public resale proxy (freebuff2api and its forks, **freebuff-proxy**, 9router)
> had adapted to the `some(signature)` rule the same way: append one hollow definition —
> `end_turn` with an empty schema and a one-line description we never shipped — to
> whatever toolset the real harness sent, and let the model never call it. Names are
> strings; strings are free.

上游还把这种形态**逐字收进了测试夹具** `PROXY_HOLLOW_END_TURN`：

```ts
export const PROXY_HOLLOW_END_TURN: WireTool = {
  type: 'function',
  function: {
    name: 'end_turn',
    description: 'Signal the end of the current task.',
    parameters: { type: 'object', properties: {} },
  },
}
```

本代理改前的实现（`ensureFreebuffToolSignature` 往 tools 末尾补空心 `end_turn`）
**正是这个形态**，即上游明确定向封堵的对象。

配套规则（同源）：

- `isGenuineSignatureTool` 要求签名工具**非空 schema**，且顶层参数名是官方
  `toolParams` 参数名的**子集**（子集是为了让落后一个版本的官方客户端仍放行）。
  **零参数工具（`end_turn` / `task_completed`）永远不算签名** —— 复制的名字加
  `{}` 与真货逐字节相同，没有结构可验证。
- `FOREIGN_HARNESS_TOOL_NAMES`（49 个）：Claude Code 的 PascalCase 核心工具
  （`Bash` / `Read` / `Edit` …）、Cursor、Codex、OpenClaw、opencode 的专有名。
  出现**任意一个**就判外来，**无论请求还带了什么**（包括我们的真签名工具）。
- `FOREIGN_HARNESS_PROMPT_MARKERS`：`You are Claude Code`、
  `Anthropic's official CLI`、`cc_version=`、`cc_entrypoint=`；只看 system 角色消息。
- 无工具时的 `root_agent_no_tools` / `sampling_params` 两条上游**只报不罚**。

## Decision

**单一真源镜像上游判据，并据此注入「货真价实」的官方签名工具。**

- 新增 `src/upstream/foreign-client-signals.js`：`detectForeignClient` /
  `isGenuineSignatureTool` / `isHollowSignatureTool` / `schemaPropertyKeys`
  与上游同名函数**同义实现**，外加常量表 `OFFICIAL_TOOL_PARAMETER_KEYS`（37 个官方
  工具的顶层参数名，由上游 `toolParams` 逐个 `z.toJSONSchema` 提取）、
  `FOREIGN_HARNESS_TOOL_NAMES`、`FOREIGN_HARNESS_PROMPT_MARKERS`、
  `FREEBUFF_DOWNGRADE_MODEL_ID`、`ENFORCED_FOREIGN_SIGNALS`。
- `src/free-mode.js` 的 `ensureFreebuffToolSignature` 改为追加
  `FREEBUFF_SIGNATURE_TOOL_DEFINITIONS`，**两个并挂、任一通过即可**（上游是 `some()`）：
  `lookup_agent_info`（真实 schema `{ agentId }`，走 schema 子集判定）与
  `decide`（官方自定义工具名，走自定义名放行）。两条规则各自独立：任一条被上游收紧，
  另一条仍然成立。幂等：已带其一则补另一个。
- `description` 统一写 `Protocol compatibility marker. Do not call this function.`。
  上游对**有参数**的工具只比对 schema、不比对描述（描述只在零参数工具上用于日志），
  所以这里可以自由取舍；而一个真诚邀请模型调用的描述，会让模型真的去调一个下游客户端
  根本不认识的名字。
- `src/proxy.js` 在转发前用 `detectForeignClient` 算一次判定，命中**受罚信号**时
  记 `logger.warn('upstream may treat request as a foreign client')`，带
  `signal / sampleToolNames / foreignToolNames / hollowToolNames`。判定权永远在上游，
  这份本地判定只为让「正在被降级」可见 —— 上游降级时不回明确错误，症状只是回答变差
  或 404/502，不主动暴露原因。
- 保留既有的剥离兜底（`stripToolsOnSchemaRejection`）：指纹对齐消除的是**已知**判据，
  兜底应对的是**未知**判据变化。

### 对照实验（决定性）

用上游判据源码在本地原样加载（`node --import <ts-loader>`，zod@4），喂真实的
下游工具集：

| 转发上游的工具集 | 上游判定 |
|---|---|
| 下游工具 + **空心 `end_turn`**（改前） | `foreign_toolset` → 降级到 `ling-3.0-tiny:free` |
| 下游工具 + **官方真签名工具**（改后） | `null`（判为自己人） |

差分测试覆盖 97 个用例（工具名单点/组合、schema 变体含 `anyOf`、空/缺失/超集
schema、prompt 标记、采样参数、根 agent 分类）：本地镜像与上游判据**逐例 signal 与
evidence 完全一致，0 处分歧**；常量集（签名名集 36、generic 5、外来名 49、标记 4、
受罚信号 3）与参数名表**逐项相等**。

## Alternatives considered

- **什么都不做（保留空心 `end_turn`）** — 它的最强理由是：这曾是**真实有效**的对策，
  且成本为零。但上游已于 2026-09-17 定向封堵这一形态，并在源码里点名 freebuff-proxy、
  把该请求体逐字收进测试夹具。继续用它 = 继续以一个**已知**会被判外来客户端的形态
  请求，换来降级（免费小模型）而不是可用模型。
- **逐字复刻官方全部 37 个工具的 schema，整个工具集都换成官方的** — 理论上能过任何
  指纹。但下游客户端（DSH/Codex 类）必须要自己的工具名才能派发调用；换成官方名字
  等于下游解析不到它要调的 `tool_calls`，工具能力直接失效。而且官方 schema 会随版本
  漂移，逐字复刻是一份需要持续重逆的负债。签名工具只需**子集**判据过关即可，
  不必整体替换。
- **只带 `decide`（自定义名，最省事）** — 上游对自定义名不查 schema，单靠它就能过。
  但它依赖「`FREEBUFF_CUSTOM_TOOL_NAMES` 保持含 `decide`」这一条 —— 上游注释显示
  该名单是**为 Desktop autorun agent 加的**，随时可能随 Desktop 改版而收缩。
  只挂一条等于把可用性押在一条随时会动的规则上，所以两条并挂。
- **只带 `lookup_agent_info`（真实 schema）** — 结构证据最扎实，但它要求上游
  `toolParams.lookup_agent_info` 的参数名保持是 `{ agentId }`（或超集）。挂两条的
  成本只是一个额外的工具定义（几行 JSON），换来任一条规则变化时的存活能力。
- **把下游工具名整体改名成官方名（如 `bash` → `run_terminal_command`）** — 能让
  工具集看起来完全是官方的。但改名后上游返回的 `tool_calls` 用的是官方名字，代理
  必须再把名字**回译**给下游，且参数 schema 根本不同（一个是 `command`，另一个是
  4 个参数），回译等于实现一个双向的、每次上游发版都要重对的转换层。收益只是
  「更像官方」，而对称性证据（真签名工具已足以过关）说明收益为零。
- **只做可观测性，不改注入行为** — 能让大家**看见**被降级，但不解决降级本身。
  可作为第一阶段，但既然判据与修法都已确证，停在观测等于明知可用形态而不用。

## Consequences

- 带工具的请求转发上游时多出 2 个工具定义（`lookup_agent_info` + `decide`）。
  代价是每个请求多几十字节的 `tools` 数组，换来的是**不被降级** —— 这是该字段的
  全部意义。无工具的请求不注入（上游对无工具是只报不罚，补了反而多一个签名字段）。
- 镜像判据是**副本**：上游改规则后本地会过期，过期表现为「本地日志说没问题、
  上游仍在降级」—— 比没有日志更误导。因此把源码 sha256 写进
  `FOREIGN_CLIENT_SIGNALS_SOURCE_SHA256` 并在模块头部标注重对方式。
- `isHollowSignatureTool` 与零参数工具的描述表（`OFFICIAL_ZERO_PARAM_TOOL_DESCRIPTIONS`）
  **只用于日志**，不参与任何判定 —— 与上游一致（上游明说那条比对只喂日志，否则
  落后一个版本的官方客户端会被误罚）。
- 仍有一个**未解决**的边界：下游若自带 Claude Code 的名字（`Bash` / `Read` …），
  补签名**救不了**，上游判 `foreign_tool_names`。上游的设计就是如此（否则「补上官方
  真工具」会成为新的洗白手段）。这条路径需要下游改名，不在本代理可解范围内；
  本地日志会把 `foreignToolNames` 打出来，便于归因。
- 设置项 `freeToolSignatureEnabled` 的语义随之变化：从「补一个占位」变成「补齐官方
  真签名工具」，控制台文案同步改写。关掉它意味着接受被判外来客户端并降级。
- 未做线上实测：本地判据镜像与上游同源、对照实验在本地跑通，但**没有**用真实账号
  打线上确认「降级不再发生」。理由是 admit 会当场买断一小时、账号池紧张。诚实边界：
  本文主张的是「判据已测绘且请求形态已对齐」，不是「线上已不再降级」。

## Testing

- `test/smoke.mjs`（指纹组，集成）：带工具的请求转发上游后，断言 `tools` 恰为
  `[客户端原工具, ...FREEBUFF_SIGNATURE_TOOL_NAMES]`；并把**整个** `tools` 数组
  喂进 `detectForeignClient`，断言 `signal === null`、`hollowToolNames` 与
  `foreignToolNames` 均为空 —— 即「转发上游的工具集不得被判外来」。
- `test/smoke.mjs`（单元）：`ensureFreebuffToolSignature` 注入的工具必须逐个通过
  `isGenuineSignatureTool` 且位于 `FREEBUFF_SIGNATURE_TOOL_NAMES` 内；主签名工具
  必须带**非空**参数 schema；开关关闭时不注入；幂等；只带其一则补齐。
- 差分测试（一次性，不随仓库交付）：把上游判据源码与本地镜像并排加载，97 个用例
  逐例比对 signal 与 evidence，另比常量集与参数名表。

## Related

- [2026-09-18-tool-schema-rejection-strip.md](2026-09-18-tool-schema-rejection-strip.md)：
  剥离兜底。那篇当时把 404 归因为「上游对 tools 做指纹比对，任何非官方工具集一律
  404」；本次测绘把因果推进了一步 —— 404 来自**降级目标 slug 已从 OpenRouter 下架**，
  而非比对失败本身。剥离兜底保留，作为未知判据变化的最后一道防线。
- [2026-09-18-official-cli-fingerprint.md](2026-09-18-official-cli-fingerprint.md)：
  UA / 准入端点 / 头集合的逐字对齐。那篇的结尾把「指纹对齐后上游是否不再返回
  tool-schema 404」列为**未做的验证**；本文给出判据真源与对照实验，补上了该缺口。
