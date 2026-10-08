# Agent Note: 对外模型 id 一律无空白(catalogId 优先), 取代[用显示名当 id]

Status: implemented

## Problem

issue #30(用户 birdxs):在 freebuff 管理平台自动获取的可用模型 **id 带空格**,
在 picoclaw 里**加不进去** ---- picoclaw 的配置不允许模型 id 带空格.
该用户还试过在控制台[自定义模型]里把显示名改成带连字符的写法, **没有生效**,
可用模型那里仍然是带空格的模型.

实测复核(2026-10-08, 用本机真实目录缓存 15 行跑生产函数
`buildCatalogDrivenModelsResponse()`):

```
rows=15  ids_with_space=15
  id="GPT-5.6 Luna"                display_name="GPT-5.6 Luna"
  id="DeepSeek V4 Flash 07/31"     display_name="DeepSeek V4 Flash 07/31"
  id="MiMo 2.5"                    display_name="MiMo 2.5"
  ...
```

**15/15 条的对外 id 都含空格** ---- 不是个别模型, 是整条清单对外不可用.

两个成因:

1. `src/catalog-models.ts` 的 `toEntry()` 直接把目录行的 displayName 当对外
   `id`("主标识是可读模型名,不是 m-xxx").可读名天然带空格
   (`DeepSeek V4 Flash 07/31`).
2. 控制台的自定义模型**按同 id 覆盖**(`addCustomEntries` 用
   `byId.set(cm.id, ...)`).目录行的 id 是带空格的 displayName, 用户填的无空格
   id 与之不相等 → 不是覆盖, 而是**并排多出一行**; 带空格那行照旧留在清单里.
   这解释了"手动改显示名没生效".

## Decision

**对外模型 id 必须是无空白标识; 人类可读名退到并列字段 `display_name`.**

取值顺序(纯函数真源 `src/util/public-id.ts` 的 `publicModelId()`):

1. **catalogId**(上游 legacy 模型 id, 如 `deepseek/deepseek-v4-flash`)---- 优先.
   它就是上游与 OpenAI 兼容生态通用的模型名, 且天然无空白.
2. **displayName 归一形态**(`MiMo-2.6-Pro` / `Ling-3.1-Flash`)---- 上游新增模型
   没有 legacyDigests(如 `Ling 3.1 Flash` / `Laguna S 2.1`), 此时才用.
3. 目录 key(m-xxx)兜底(连可读名都没有时).

配套三件事:

- **`display_name` 保留可读名**(可带空格): 展示侧仍显示 `DeepSeek V4 Flash 07/31`,
  人类可读性不丢.
- **反查闭合**: 归一形态与原显示名一起进 `CatalogHolder.keyByName`
  (真源 `src/upstream/protocol/parse.ts`), 所以下游照着 `/v1/models` 的 id 原样填
  回来能落回目录 key; 旧写法(带空格显示名 / 裸 key)继续可用, 升级期不断.
- **白名单同口径**: `catalogModelKeys()` 三个口径全收(key + displayName + publicId),
  避免"清单里能选, 请求被 model_not_allowed 拒".

对外 id 的构造点全部收拢到 `publicModelId()`:
`src/catalog-models.ts`(目录清单), `src/model/response/rows.ts`(会话条目),
`src/context/catalog/account-catalog.ts` 的 `modelAliases()`(向外 id 的唯一真源出口).

**控制台是例外, 必须留在可读名口径上**: `/api/models/upstream` 的 `models[].id` 保持
可读模型名, 无空白 id 放在**并列字段 `publicId`**, 首列展示 `publicId`.
原因是前端 `known` 表按 `id` 三路合并(内置 catalog / 自定义 / 上游), `syncUpstreamModels`
也按 `id` 写回自定义条目 ---- 而历史自定义条目存的正是可读名. 实测(2026-10-08,
本机 53 条自定义 + 13 行目录): 把控制台 id 也换成无空白形态后,
**合并只命中 3 条, 另 10 条以上游新行重复入表(列表 68 行 -> 78 行)**,
同一模型在页面上出现两次. 改回可读名做内部身份后: `merged=13, added=0`.

## Alternatives considered

- **什么都不做, 让用户自己改客户端** ---- 用户已经试过控制台的自定义覆盖,
  而那条路按 id 相等才生效, 改不动带空格的目录 id. 而且缺陷在**我们的对外契约**里
  (OpenAI 兼容的 `id` 字段), 不该由客户端承受.
- **只把 displayName 里的空格换成连字符(不用 catalogId)** ---- 修好了 issue #30,
  但会让生态通用的 `deepseek/deepseek-v4-flash` 写法消失, 与已落库的
  53 条自定义条目(大量使用该写法)全面失配, 用户配置会大面积失效.
- **保留 id 不动, 另加 `id_slug` / `id_alias` 并列字段** ---- 改动最小,
  但 picoclaw 这类**直接读 `id`** 的客户端仍然撞墙 ---- 等于没修 issue.
- **把带空格的显示名从清单里删掉** ---- 用户失去人类可读名, 且
  `display_name` 本来就是给展示用的, 删它解决不了 id 的问题.
- **在 `catalogDisplayName()` 里改**(把归一逻辑并进名称真源) ---- 那个函数的语义是
  [目录行 -> 对外可读名], 归一形态不是可读名(它不可读); 并进去会让
  `display_name` 也变成无空白形态, 展示侧跟着退化. 所以另立纯函数真源.

## Consequences

- **对外 id 变化是破坏性的**: 老客户端若把 `MiMo 2.6 Flash` 写死在配置里, 现在要改成
  `mimo/mimo-v2.5`. 但**旧写法仍能解析**(keyForName 保留原显示名与大小写/空白不敏感
  匹配), 所以只要客户端照我们下发的清单走, 就不会断.
- 目录新增模型(无 catalogId)的对外 id 形如 `Ling-3.1-Flash`: 无空白, 可反查,
  但与上游生态没有既有对应名 ---- 这是"上游没给我们可读 id"时的最优形态.
- `/api/models/upstream` 与 `/api/accounts/refresh` 的 `upstreamModelIds` 同步改成
  对外 id 口径(原来给 `displayName || key`); 判据真值仍在 `upstreamModels[].key`.
- `modelAliases()` 新增 `publicId` 字段: 前端与控制台按它取对外 id, 不再各自
  `displayName || key` 拼一遍(那正是本仓反复出问题的"第二套口径").

## Evidence

- 改前实测: 真机目录 capture(13 行)与本机缓存(15 行)走生产函数,
  **带空格 id = 全部**; 改后 **= 0**.
- 端到端(真 capture + 真 CatalogHolder, 2026-10-08):
  ```
  checked=13 bad=0
  publicIds: mimo/mimo-v2.5, z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash,
             GPT-6-Luna, MiMo-2.6-Pro, Solar-Mini-4, Solar-Pro-4,
             Space-Bunny-Alpha, Gemini-3.8-Flash, Muse-Spark-1.3,
             GPT-6.1-Sol, Ling-3.1-Flash, Laguna-S-2.1
  ```
  每条都满足: 归一后 == 目录 key, 白名单放行, 句柄可寻址.
- 套件: `model-name-chain`(新增 [无空白] 与 [新 id 可被解析回目录 key] 断言),
  `catalog-models`(新增 [id 不得含空白] 断言), `smoke` 的
  `/v1/models` 会话条目段(改为按 `freebuff_key` 定位并断言 `Solar-Pro-4` 形态)全绿.
- 控制台回归实测(修法前后对照): 修前 `merged=3 / added=10 / total=78`,
  修后 `merged=13 / added=0 / total=68`.
- 可证伪: 把 `publicModelId()` 的归一改回直接返回 displayName, 上述断言变红
  (独立盲审复现: 断言红 3 条; 还原后 sha256 与字节一致).
- 独立盲审计审发现并已修的缺口: **大写变体解析不到**. 摘要是大小写敏感的,
  而 catalogId 形态(mimo/mimo-v2.5)此前没有小写兜底 ---- 实测
  `keyForName('MIMO/MIMO-V2.5')` 返回 null, 白名单拒收, 400 model_not_allowed.
  而 issue #30 用户原话里贴的正是 `MIMO/MIMO-V2.5`. 修法: `keyForName` 第②条路径
  精确匹配落空后试小写(不覆盖任何精确命中). 修后实测:
  `MIMO/MIMO-V2.5` -> m-00032eaeec, `DEEPSEEK/DEEPSEEK-V4-FLASH` -> m-096e75164d.
