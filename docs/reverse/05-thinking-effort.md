# 05 — 思考强度(reasoning effort)

## 5.1 官方枚举(源码 `orchestrator.js:120829`)

```js
var REASONING_EFFORTS = ["minimal","low","medium","high","xhigh","max","ultra"];
var DEFAULT_REASONING_EFFORT = "high";
var BYOK_REASONING_EFFORTS = ["low","medium","high"];   // BYOK 只有三档
```

目录里每个模型行自带可用档位与默认值(`orchestrator.js:134790`):

```js
freebuffCatalogRowSchema = {
  ...
  efforts:        z.array(effortSchema).optional(),   // 该模型支持的档位
  defaultEffort:  effortSchema.optional(),
  reasoningEffort: effortSchema.optional(),
  ...
}
```

**所以"支持哪些档位"是每模型不同的,必须从 catalog 读**,不能硬编码.
本机实测(limited 档目录)示例:

| 模型 | efforts | defaultEffort |
|---|---|---|
| Space Bunny Alpha | `["low","medium","high","xhigh","max"]` | `high` |
| GPT-6.2 / MiMo 2.7 Max / Nemotron 4 Ultra | `["low","medium","high"]` | `high` |
| Grok 5 Fast / MiMo 3 Pro / MiniMax M4 Pro | `["low","high"]` | `high` |
| Gemini 3.8 Flash | `["high"]` | `high` |
| GPT-6.1 Sol | `["low","medium","high"]` | `medium` |
| MiMo 3 Flash / Qwen4 Flash / Solar Pro 4 | 未声明 | — |

未声明 `efforts` 的模型:不要主动发 `reasoning_effort`.

## 5.2 传输方式

在 **请求体顶层**发 `reasoning_effort`(OpenAI 兼容字段名).
源码 `orchestrator.js:103278` 的缓存调试归一化列出了 provider 请求体字段全集,
其中就含 `reasoning_effort`:

```js
["model","messages","tools","tool_choice","response_format",
 "reasoning","reasoning_effort","verbosity","provider"]
```

即上游认识两个思考字段:`reasoning`(对象式)与 `reasoning_effort`(字符串式).

 **只能发一个**:仓库 `src/proxy.ts` 的 `normalizeReasoningFields(body)`
注释写得很直白 —— "One reasoning field only — avoids Freebuff default +
client dual fields.".同时发两个会与上游默认值打架.

## 5.3 每模型的默认档(源码 `orchestrator.js:124816-124988`)

部分模型在官方定义里写死默认档,例如:

```js
FREEBUFF_GPT_5_6_LUNA_REASONING_EFFORT   // GPT-5.6 Luna
FREEBUFF_GPT_6_LUNA_REASONING_EFFORT     // GPT-6 Luna
FREEBUFF_GPT_61_SOL_REASONING_EFFORT     // GPT-6.1 Sol
DEEPSEEK_V4_REASONING_EFFORTS = ["low","high","max"]
OX_ALPHA_REASONING_EFFORTS    = ["low","high","max"]
GLM_V53_FLASH_REASONING_EFFORTS = ["low","high","max"]
```

## 5.4 与"mission effort"的区别(别混淆)

源码里另有一套 **任务投入度**,与思考强度是**两个不同维度**:

```js
var MISSION_EFFORT_LEVELS = [1,2,3,4,5], DEFAULT_MISSION_EFFORT = 3;
MISSION_TIME_BUDGET_MINUTES = { 1:15, 2:30, 3:60, 4:120, 5:240 };
MISSION_TIME_EFFORT_LABELS = {
  1: "Sprint — what was asked, working, with essential proof",
  2: "Focused — what was asked, checked through the real surface",
  3: "Crafted — correct, clean, and proven",
  4: "Thorough — proven and pruned on every dimension",
  5: "Exhaustive — the most careful version of exactly what was asked"
}
```

- `reasoning_effort` = 模型**每条回复**的思考深度(low/medium/high/...)
- `mission effort` = 整个**任务**允许花多少分钟(1~5 级)

## 5.5 代理侧要做的事

1. 从 catalog 读 `efforts` / `defaultEffort`,模型未声明则不发该字段.
2. 客户端传了值 → 校验它在该模型 `efforts` 里;不在则回落到 `defaultEffort`.
3. 发之前先 `normalizeReasoningFields`,保证只剩一个思考字段.
