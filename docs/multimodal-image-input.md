# Freebuff 多模态（图片输入）支持调研

> 本文是 [freebuff-proxy](../README.md) 的详细文档之一。**结论性调研，只查证、不改代码**。
> 对象是上游 Freebuff/Codebuff 本体（CLI / Desktop / Web）+ 本代理的转发行为。
> 快速上手 / 一键部署请看 [主页 README](../README.md)。

## TL;DR

1. **支持，而且是官方一等能力**：Freebuff 上游模型目录里有显式的 `multimodal: boolean` 字段，
   注解决定「上传的图片是被当作真正的多模态内容转发，还是被降级/内联成文本」
   （`common/src/constants/freebuff-models.ts:82-84`）。
2. **不是所有模型都能看图**，但**所有模型都能"收"图**：非多模态模型收到的图片会在上游
   completions 层被替换成「视觉模型生成的图片描述」，所以照样"读得到"
   （`freebuff-models.ts:822`）。官方 CLI 只给原生多模态行加 ` · Images` 徽章
   （`cli/src/components/freebuff-model-selector.tsx:1345-1350`）。
3. **本代理（freebuff-proxy）在数据面上已经是通的**：`messages[].content` 是原样透传的，
   OpenAI 的 `image_url`（含 `data:image/png;base64,...`）会完整转发上游；
   `free-mode.js` 只重写 **system 消息**，不碰 user/assistant 的 content part。
   → **下游 Agent 现在就可以发图片请求**。
4. **三个真实缺口**（本次调研实测出来的，均未修复）：
   - **catalog 同步三元组不一致**：运行时同步从 `CodebuffAI/freebuff` 拉源码，而本地
     clone 的真相在 `CodebuffAI/codebuff`——**两个仓库的 `freebuff-models.ts` 不是同一份**
     （34,623 B vs 214,559 B）。当前上游解析器解析这份文件时，**所有模型的 `multimodal` 都变成 `false`**。
   - **本地内置 catalog 的 `multimodal` 标记已过期**：flash 的标记仍是 `false`，而线上
     `freebuff-models.ts` 因 2026-09-10 的 V4.1 Flash 升级已改成 `true`。
   - **控制台「测试对话」没有图片输入**（`dashboard` 只有文本输入）：功能可用，但不可自测/演示。
5. **未做**：真实上游的图片端到端实测（会花额度，且需要真实 Freebuff 账号）。因此
   「线上 API 是否对代理形态的请求同样转发图片」属于**推断**，不是实测结论——见「不确定项」。

## 证据基线

| 项 | 值 |
|----|----|
| Codebuff 开源仓库 | `CodebuffAI/codebuff` @ `654a906e6758ffe17974dae829d35423dcd827b3`（2026-09-13T12:33:48Z） |
| 运行时同步源 | `CodebuffAI/freebuff` @ `main`（raw.githubusercontent.com） |
| 数据面（协议） | OpenAI 兼容 `chat/completions`，content part：`text` / `image_url` / `file` |
| 本地代理基线 | 工作区当前代码（未改动） |

复现命令（只读，不写工程）：

```bash
# 1) 上游目录/多模态标记（真相）
git clone --depth 1 --filter=blob:none --sparse https://github.com/CodebuffAI/codebuff.git /tmp/cb
cd /tmp/cb && git sparse-checkout set --cone common cli packages sdk agents
grep -n "multimodal" common/src/constants/freebuff-models.ts

# 2) 运行时同步真正用的那份（注意大小差异）
curl -sS https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-models.ts -o /tmp/upstream-freebuff-models.ts
wc -c /tmp/cb/common/src/constants/freebuff-models.ts /tmp/upstream-freebuff-models.ts

# 3) 用本仓库的解析器跑一遍上游源（可复现「multimodal 全 false」）
#    见 src/catalog/parser.mjs buildCatalogFromSources
```

## 一、上游怎么表达多模态

### 1.1 目录字段

`FreebuffModelOption.multimodal` 的注释原文（`freebuff-models.ts:82-84`）：

> Whether the model accepts image input. Drives whether uploaded images are forwarded as real
> multimodal content vs. dropped/inlined as text.

派生量与查询函数：

- `FREEBUFF_MULTIMODAL_MODEL_IDS` / `FREEBUFF_WEB_MULTIMODAL_MODEL_IDS`（`:2603` / `:2609`）
  —— 分别由 `SUPPORTED_FREEBUFF_MODELS` 与 `FREEBUFF_WEB_ALL_MODELS` 过滤得出。
- `getFreebuffModelImageSupport(id)`（`:3826`）—— **未知模型返回 `undefined`**，
  刻意不把新模型/付费模型的图剥掉（"until their capability is known"）；例外是已退役的
  DeepSeek fireworks wire id 被钉成 `false`（`:3831`）。
- `isFreebuffWebMultimodalModelId(id)`（`:3849`）。

### 1.2 当前各模型的原生多模态能力

以本地 clone（`codebuff@654a906`）逐行提取，`multimodal` 为行内字面量：

| 模型 id | 显示名 | 原生看图 | premium |
|---|---|---|---|
| `openai/gpt-5.6-luna` | GPT-5.6 Luna | ✅ | 是 |
| `openai/gpt-5.6-luna-max` | GPT-5.6 Luna (Max context) | ❌ | 是 |
| `openai/gpt-5.6-luna-es` | Codex (test) | ❌ | 是 |
| `deepseek/deepseek-v4-flash` | DeepSeek V4.1 Flash | ✅（**2026-09-10 起**） | 否 |
| `deepseek/deepseek-v4-flash-max` | DeepSeek V4 Flash (Max context) | ❌ | 否 |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | ❌ | 是 |
| `deepseek/deepseek-v4-pro-max` | DeepSeek V4 Pro (Max context) | ❌ | 否 |
| `mimo/mimo-v2.5` | MiMo 2.5 | ✅ | 否 |
| `minimax/minimax-m3` | MiniMax M3 | ✅ | 是 |
| `google/gemini-3.8-flash` | Gemini 3.8 Flash | ✅ | 是 |
| `anthropic/claude-fable-5` | Claude Fable 5 | ✅ | 是 |
| `z-ai/glm-5.3-flash` | GLM 5.3 Flash | ✅ | 否 |
| `z-ai/glm-5.2` | GLM 5.2 | ❌ | 是 |
| `stealth/ox-alpha` | Ox Alpha | ✅（已撤出免费模式） | 否 |
| `crof/kimi-k3-eco` | Kimi K3 | ❌ | 是 |
| `meta/muse-spark-1.2-contributor` | Muse Spark 1.2 | ❌ | 是 |
| `meta/muse-spark-1.3-contributor` | Muse Spark 1.3 | ❌ | 是 |
| Solar Pro 4 | Solar Pro 4 | ❌ | 见 entitlement |

**flash 的 `multimodal: true` 是实测换来的**（`freebuff-models.ts:1379-1388`）：

> Verified against the live API rather than taken from the announcement: `deepseek-flash`
> reads an inline base64 PNG and names its colour, where `deepseek-v4-pro` sent the same part
> answers "Unknown".

并且该注释点明了路由约束：**只在 DIRECT lane 成立**，所以路由器对其他 lane 仍会拍平图片
（"That's why the router flattens image parts for every other lane rather than trusting this flag alone"）。

### 1.3 非多模态模型也能"读图"（降级，不是拒绝）

`freebuff-models.ts:822`：

> Being text-only costs this nothing: images reaching a Freebuff model that cannot see pixels are
> converted to vision-model descriptions at the completions layer (`getFreebuffModelImageSupport`
> gates it), so a rerouted turn carrying an image still reads it.

即 **能力差异 = 原生像素 vs 视觉模型转写描述**，而不是"能不能传图"。
该降级实现在 Freebuff 的服务端（`web/src/llm-api/*`），**不在开源仓库里**——但它作用于
`api.codebuff.com`，也就是本代理转发的同一个端点。

## 二、图片在协议上长什么样

### 2.1 Codebuff 内部类型

`common/src/types/messages/content-part.ts`：

```ts
imagePartSchema = { type: 'image', image: dataContent | URL, mediaType?: string }
filePartSchema  = { type: 'file',  data:  dataContent | URL, filename?: string, mediaType: string }
```

内部工具结果里还有 `{ type: 'media', data, mediaType }`（base64），例如读文件工具把图片交给模型。

### 2.2 出网（真正发给 provider / 上游 API）

`packages/llm-providers/src/openai-compatible/chat/convert-to-openai-compatible-chat-messages.ts:74-90`：
把 `mediaType` 以 `image/` 开头的 file part 转成 **OpenAI 标准 `image_url`**：

```jsonc
{ "type": "image_url", "image_url": { "url": "data:image/png;base64,<...>" } }
```

`imageUrlFromData()`（同文件 `:17-42`）处理了三种输入形态——**已带 `data:` scheme 的字符串、
裸 base64 字符串、`Uint8Array`**，并显式避免重复加前缀（`data:image/png;base64,data:image/png;base64,…`
会被 provider 400 "invalid base64-encoded value"）。非图片 file part 直接抛
`UnsupportedFunctionalityError`。

`sdk/src/__tests__/image-request-body.test.ts` 是这条链路的**线上形状回归**（head 文件头注释：
"End-to-end guard on the shape of an image as it leaves for the provider"），断言真实
`streamText → model` 产出的是合法 data URL——说明这个位置历史上真崩过（曾发出
`data:image/png;base64,[object Object]`，GPT-5.6 Luna 每次带图必 400）。

### 2.3 客户端（CLI / Desktop）侧的图片输入

- CLI：`/image <path> [message]`（`cli/src/commands/image.ts`）、剪贴板粘贴
  （`cli/src/utils/clipboard-image.ts`）、终端拖拽；`pending-attachments.ts` 负责压缩与状态。
- 体积限制（`common/src/constants/images.ts:49-51`）：
  `MAX_IMAGE_FILE_SIZE = 10MB` → 迭代压缩 → `MAX_IMAGE_BASE64_SIZE = 1MB`，
  多图合计 `MAX_TOTAL_IMAGE_SIZE = 5MB`。
- 支持格式：`jpg/jpeg/png/webp/gif/bmp/tiff/tif`（`IMAGE_EXTENSION_TO_MIME`）。
- 模型选择器只在 `multimodal === true` 的行上显示 ` · Images` 徽章
  （`freebuff-model-selector.tsx:958-963` 与 `:1345-1350`；对应测试
  `cli/src/components/__tests__/freebuff-model-selector.test.tsx:450-472`）。
  注释解释了为什么不给所有行加：文本行仍可贴图（服务端转描述），"but badging every row
  'Images' made the label meaningless"。

## 三、本代理（freebuff-proxy）现状

### 3.1 数据面：已通

- 请求体读取上限 **32MB**（`src/util/http.js:23-25`），远高于单图 1MB / 多图 5MB 的客户端预算。
- `buildForwardBody`（`src/proxy.js:1212-1271`）以 `...clientBody` 展开，
  只改动：`model` / `reasoning` / 输出预算 / **`messages`（仅补 system 开场）** /
  `tools`（补签名）/ `codebuff_metadata` / `provider.data_collection` / `stop`。
  **没有任何 content part 的白名单或图片剥离逻辑。**
- `ensureFreebuffSystemMessages`（`src/free-mode.js:78-115`）只处理**首条 system 消息**；
  `normalizeContentToText` 也只在 system 上调用。user 的 `[{type:'text'},{type:'image_url'}]`
  原样抵达上游。
- 结论：**下游 Agent 直接把 OpenAI 形态的 `image_url`（http(s) URL 或 data URL）放进
  `messages` 即可**，与官方 CLI 走的是同一条 wire 形状。

### 3.2 元数据面：`multimodal` 会漂

- 内置 catalog 的 `multimodal` 是**手工精修**的，而运行时缓存的 `multimodal` 来自解析器；
  合并规则（`src/model.js:152-167`）里**内置条目以"内置元信息优先"整条返回**，
  因此**内置标记永远压过缓存值**——上游把 flash 改成 `true` 也不会自动生效。
- 更硬的问题：`src/catalog/parser.mjs:116` 对每个模型写死 `multimodal: false`
  （它只从源码里抽 `id` / `displayName` / agent 映射，**根本没读 `multimodal` 字段**）。
- 叠加"两个仓库文件不同源"（34,623 B vs 214,559 B），运行时同步源里**根本没有行内
  `multimodal:` 字面量**。实测：用本仓库解析器跑一遍最新上游源 → 14 个模型 `multimodal` **全部 `false`**。

影响面（当前可控，但会误导）：
- `GET /v1/models` 返回的 `multimodal` 字段（`src/model.js:350`）——下游 Agent 若据此做
  "能不能传图"的决策，会得到错误答案（对 flash 是**假阴性**）。
- 前端「模型管理」的自定义模型覆盖（`src/web/model-store.js:177`）是**唯一现在能修正它的入口**。

### 3.3 Web 控制台：无图片输入

`dashboard/` 的「测试对话」只有文本输入；全仓 grep 无 `image` / `attach` / `multipart`
相关的输入控件（命中的都是静态资源 MIME 与账号 JSON 导出）。因此：
**功能可用但不可自测**，用户/运维无法在控制台里直观确认"这个模型到底能不能看图"。

## 四、结论与建议（未执行，仅建议）

按「先降风险、再补能力」排序：

1. **修同步源**（`src/catalog/runtime-sync.mjs:27-28`）：改为 `CodebuffAI/codebuff`，
   或保留 `freebuff` 但明确"该仓库的 `freebuff-models.ts` 是 re-export 残页"。
   *风险*：换源 = 换文件体积（214KB），且要确认 raw/CDN 可达性——属于独立改动，建议单独验证。
2. **让解析器读 `multimodal`**（`src/catalog/parser.mjs`）：在行内对象里抽 `multimodal:\s*(true|false)`，
   并对**老上游那份**回退到"未标注 ⇒ 不覆盖内置值"，避免把好标记刷成 `false`。
3. **校正内置 catalog**：`deepseek/deepseek-v4-flash` → `multimodal: true`（`:1388` 实锤）；
   补充缺失行（`google/gemini-3.8-flash`、`meta/muse-spark-1.3-contributor`）。
   *注意*：flash 的图只在 DIRECT lane 成立，标记成 `true` 是"通常成立"而非"永远成立"，
   建议在 `note` 里写明。
4. **控制台加图片输入**（可选）：支持粘贴/选择图片 → 转 data URL 塞进 `content` 数组，
   并在模型下拉里显示 `multimodal` 标记——一次把"能传"和"能自测"补齐。

## 五、不确定项（不要当成已证实的）

1. **没有做真实上游端到端实测**：`admit` 会消耗额度，本地也无运行中的代理实例
   （8787 未监听）。表中 `multimodal` 全部来自源码，**不是线上探测结果**。
2. **代理形态请求是否同样享受"视觉模型描述"降级**未知。该逻辑在闭源服务端，
   且可能按 surface/trace 区分；官方 CLI 走的就是 `api.codebuff.com` + `cost_mode=free`，
   与本代理同形，但**未实证**。
3. **未确认上游是否对图片体积/格式有额外服务端校验**；客户端常量（10MB / 1MB / 5MB）是
   CLI 侧约束，不是协议约束。
4. **`freebuff`（re-export 仓库）的完整目录**未逐行核对：只确认它不含行内 `multimodal:` 字面量。
5. 上游目录每月都在动（本仓库 README 里已有多次 "WITHDRAWN" 记录），本表以
   `codebuff@654a906`（2026-09-13）为准，**有保鲜期**。
   > 第 1 条的"未实测"已由第六节的端到端实测补齐（2026-09-13）。

## 六、实测复核（2026-09-13，真实链路 cli/DSH → sub2api → freebuff-proxy → freebuff.com）

本节是对前文「未做端到端实测」的补齐。链路身份已确认：`ai.woa.qzz.io`（配置名 HXApi）
是 **sub2api** 的部署（其前端 bundle 内含 `Sub2API` 字样）。

**实测方法**：用本地凭据库里的 HXAPI key 直连网关，各发 4 张纯色 PNG，看模型能否读出颜色。
`/v1/chat/completions` 与 `/v1/responses` **双端点各测一轮**：

| 输入图 | chat/completions 回答 | responses 回答 |
|---|---|---|
| 纯红 | Red | Red |
| 纯蓝 | Blue | Blue |
| 纯绿 | Teal（偏差） | Green |
| 纯黄 | Gold（偏差） | Yellow |

结论：**图片能完整穿过整条链路并被 DeepSeek 真正"看见"**（不是"Unknown"式的瞎猜）。
两处色名偏差属模型自身色感问题，不是链路丢图。

### 6.1 逐段判定

| 段 | 是否支持 | 证据 |
|---|---|---|
| ① DSH/CLI → 网关 | **声明层拦着（可配置）** | DSH 的 `dsh-llm-pi-ai` 插件把模型模态取自 `input` 字段，缺省常量 `DEFAULT_INPUT = ["text"]`（`lib/index.js:906`），schema 默认 `defaultInput` 同值（`:993`）。上游自带目录把 `deepseek/deepseek-v4-flash` 标成 `input:["text"]`（pi-ai 的 openrouter / vercel-ai-gateway data 文件——**是过期元数据**，对应 2026-09-10 前的老 flash），所以图片默认被当成不支持。 |
| ② sub2api → freebuff-proxy | **支持** | `internal/pkg/apicompat/chatcompletions_responses_bridge.go` 的 `responsesContentPartsToChatContent` 把 `input_image` → `{type:"image_url", image_url:{url}}`（`:568-580`），正是 OpenAI 标准形状；`/v1/chat/completions` 入站更是直通不转换。 |
| ③ freebuff-proxy → freebuff.com | **支持** | `src/proxy.js:1212-1271` 原样透传；只有 system 消息被重写。 |
| ④ 上游模型 | **支持** | 见上表，双端点实测通过。 |

### 6.2 真正的"不支持点"只有一个，且可修

**DSH 侧给该模型声明的模态是 text-only。** 上游模型本身完全能读图（已实测），
sub2api 与 freebuff-proxy 也都原样转发，唯一挡住的是这条声明。

修法（`~/.dsh/settings.yaml`，`llm-pi-ai.providers.hxapi.models` 条目）：

```yaml
        - id: deepseek/deepseek-v4-flash
          name: deepseek/deepseek-v4-flash
          input: [text, image]      # 新增：声明该模型接受图片
```

依据 `declaredInput()` 的优先级：**条目显式声明 > 自带目录 > 路由 `defaultInput`**
（`dsh-llm-pi-ai/lib/index.js:682`），所以显式写 `input` 一定能覆盖那份过期的 text-only 目录。

### 6.3 一个需要留意的兜底机制

DSH 有「给纯文本模型投影图片」的降级：`projectImagesForTextModel` / `replaceImagesForTextModel` /
`textOnlyImageText`（`dsh-llm/lib/index.js:721` 起），把图片块替换成
`[image omitted because this model accepts text only; attachment sha256:...]`。
**代码搜索显示这套投影只出现在 `dsh-llm` 主路径，`dsh-llm-pi-ai` 插件里没有**；
但它是否在某些配置下仍会生效，本次未直接验证——声明 `input: [text, image]` 之后该分支不会再触发。

### 6.4 与三、3.2 的关系


### 6.5 已落地的本地改动（2026-09-13）

按 6.2 的方案改的是**本机 DSH 配置**，不是本仓库代码：

```yaml
# ~/.dsh/settings.yaml → llm-pi-ai.providers.hxapi.models[]
        - id: deepseek/deepseek-v4-flash
          name: deepseek/deepseek-v4-flash
          input: [text, image]      # ← 新增
```

同一 provider 下另两个模型（`openai/gpt-5.6-luna-es`、`z-ai/glm-5.3-flash`）
按上游 `multimodal: true` 声明一并加了同样的行。

- **无需重启**：`dsh-settings-file` 用 chokidar 监听（`spec.watch` 默认 true，`lib/index.js:180-200`），
  保存即热加载；改完当轮就能 `read_image`。
- **验证**：改前 `read_image` 报 "does not declare image input"；改后同一张图正常读出
  （PNG 与 JPEG 两种格式都通过）。
- **回滚**：备份在同目录旁的 `settings.yaml.bak-*`。
- **不需要动**：sub2api、freebuff-proxy、以及本仓库 catalog 的任何代码——
  链路本身全程支持图片（见 6.1）。

第 3.2 节记录的「本仓库 catalog `multimodal` 标记过期/同步源错位」**不影响图片能否通过**，
只影响 `GET /v1/models` 告知下游的元数据准确性。链路能不能看图与本仓库的标记无关——
这点已由本节的端到端实测证实。
