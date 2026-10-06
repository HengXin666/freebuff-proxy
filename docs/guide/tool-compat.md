# 接入一个新的下游工具

> 最后核对: 2026-10-06 . 对应代码: 2.5.1
> 真源: `tool-compat`

这份文档回答一件事:**下游 harness(客户端)声明了一个新工具时,要改哪些文件,
按什么判据改, 改完怎么证明它一次就能派发成功**.

不读这份文档直接改的典型后果,本仓已经踩过三次:名字映射加了但参数规则没加
(下游报 `missing required property`), 参数规则加了但字段名对不上(下游报
`invalid arguments`), 两者都对了但下游压根没声明这个名字(下游报 `unknown tool`).
三种失败在体感上没有区别,所以必须按同一套流程一次做全.

## 一,先分清两条通道(选错通道 = 白改)

下游工具名进上游有两条互斥的通道,先判名字属于哪一条:

| 官方工具集里有等价物? | 走哪条 | 改哪里 |
|---|---|---|
| 有(如 `bash` / `read` / `edit`) | **改名通道** | `src/upstream/signals/tool-name-map.ts` 加映射 |
| 没有(如 `memory_save` / `jev_judge_ask`) | **载体通道** | 什么都不用改,自动包成 `proxy__<原名>` |

载体通道是自动的:官方本来就支持客户端自定义工具,工具会被包成官方 MCP 形态的
名字(`proxy` + `双下划线` + 原名)随 `tools` 发出,回程按映射表拆回原名.
**不要**为了走载体通道去给它硬凑一个官方名 ---- 那等于篡改语义.

判据的代码真源是 `src/upstream/signals/tool-name-map.ts` 的 `CLIENT_TO_OFFICIAL_TOOL`,
载体形态的代码真源是 `src/proxy/transport/tool-carrier.ts`.

## 二,四条必须同时满足的判据

一个下游工具要"一次就成功派发",下面四条缺一不可. **这四条就是回归测试
`test/suites/entries/verify/tool/param/dispatch-ready.ts` 在验的东西. **

1. **出站能注入** ---- 官方工具集是固定 37 个(`docs/reverse/captures/official-tools.json`).
   下游工具要么映射到其中一个,要么走载体通道被包出去.
2. **回程名字能还原** ---- 上游回的 `tool_calls` 里是官方名,要翻回下游认识的名字.
   真源 `buildOfficialToClientMap`(同 `tool-name-map.ts`).
   注意它按[本次声明]过滤:下游这次没声明过的客户端名不会被造出来.
3. **参数形态能翻译** ---- 官方 schema 与下游 schema 的字段名/结构往往不同.
   真源 `src/upstream/signals/tools/param-rules.ts`(规则数据)+
   `src/upstream/signals/param-map.ts`(翻译引擎).
4. **下游 schema 收得下** ---- 翻译后必须满足下游的 `required`,且不得带下游
   `additionalProperties: false` 不认识的字段.

## 三,加一个新映射的操作步骤

以"下游新增了一个 `list_dir` 工具"为例.

**第 1 步:判通道. ** 官方有 `list_directory`,且在 `CLIENT_TO_OFFICIAL_TOOL` 里
`ls` / `list_dir` 已经映射到它 ---- 走改名通道.

**第 2 步:加名字映射. ** 在 `src/upstream/signals/tool-name-map.ts` 的
`CLIENT_TO_OFFICIAL_TOOL` 里加一行 `list_dir: 'list_directory'`.
**同一次必须同步** `cli-bridge/lib/tool-map.ts` 的同名表 ---- 两张表逐条一致有断言在管
(`test/suites/entries/verify/tool/name-mapping.ts`).

**第 3 步:判要不要加参数规则. ** 调出官方 `list_directory` 的 schema:

```bash
node -e "const t=require('./docs/reverse/captures/official-tools.json');
console.log(JSON.stringify(t.find(x=>x.function.name==='list_directory').function.parameters,null,1))"
```

再调出下游工具自己声明的 schema(从 `test/fixtures/dsh-tools.json` 或真实抓包里取),
**逐个字段比对**. 两边的字段名, 类型, 必填性只要有一处不同,就必须加规则.

**第 4 步:写规则. ** 在 `param-rules.ts` 里加一条:

```ts
官方工具的下游名: {
  fields: { 官方字段: { to: '下游字段' } },
  synth: { 下游必填但官方没有的字段: (src) => 从整份官方参数合成 },
}
```

三条硬纪律(写在`param-map.ts`文件头,这里复述):
- **没有规则的组合一律返回 null**,调用方原样保留参数 ---- 宁可下游看到陌生的官方字段,
  也不要被错误规则改坏;
- **翻译后按下游 schema 裁剪**,丢掉下游不认识的多余字段;
- **下游要而官方没有的字段必须 synth 补上**,否则下游 required 校验过不去.

**第 5 步:补测试. ** 在 `test/suites/entries/verify/tool/param/dispatch-ready.ts` 的
官方参数样本表里加一条样本,并断言翻译后的关键字段. **断言必须可证伪**:
写完临时把实现改坏,确认测试变红,再还原.

## 四,判断参数规则写对没有的三种实测手段

**手段一:拿下游的校验器实跑. ** dsh 的校验器可以直接调用:

```bash
node -e "
import('/home/hx/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
  .then(m => console.log(m.validateJsonSchemaValue(下游schema, 翻译后参数, 'arguments')))
"
```

返回空数组 = 下游收得下;返回 `missing required property "..."` = 还差字段.

**手段二:跑全量对照矩阵. ** 用官方全部 37 个工具的元数据(
`src/upstream/signals/tools/official-tool-select.ts` 的 `OFFICIAL_TOOL_META`)
逐个走一遍名字还原与参数翻译,看哪一项落空. 落空项分两类:走载体通道的(正常),
以及该支持却没支持的(缺陷).

**手段三:翻历史会话找同类失败. ** 本仓的下游会话记录里直接有原始报错:

```bash
cd ~/.dsh/sessions/--home-hx-Loli-code-AI-Code-gpt-json-to-token-freebuff-proxy-freebuff-proxy--
zstd -dc <session>/session.v4.jsonl.zstd | grep -oE "unknown tool \"[^\"]+\"|missing required property \"[^\"]+\""
```

## 四点五,反向映射: 官方原生工具落到下游的另一个工具上

`CLIENT_TO_OFFICIAL_TOOL` 是[下游名 -> 官方名], 一个下游名只能指一个官方名.
如果反过来要表达**两个官方工具都落到同一个下游工具**(2026-10-06 的 `suggest_prompts`
就是这个例子), 加那张表是没用的 ---- 它的键是下游名. 这种情况用
`OFFICIAL_NATIVE_TO_CLIENT`(同文件), 键是官方原生名:

```ts
export const OFFICIAL_NATIVE_TO_CLIENT: Record<string, string> = Object.freeze({
  suggest_prompts: 'ask_user_question',
})
```

判据与那张大表一致: 只登记**明确做过对标决策**的官方名, 且同样受[本次声明]过滤
(下游没声明过目标工具时不得造别名). 没有下游对应物的一律不写.

## 五,官方 system 提示里点名的工具(不能靠裁剪回避)

官方 worker 层 system 模板里**明文要求**模型调用几个工具,这些名字即使被从
`tools` 数组里裁掉,模型仍会"提到"它们:

- `suggest_prompts`(模板原话:`almost every substantive turn should end with
  two to four follow-ups`)
- `write_todos` / `ask_questions` / `request_elevation`
- `register_preview` / `preview_open` / `preview_status`

`suggest_prompts` 与 `ask_questions` 都已经有下游对应物(映射到 `todo_write` 与
`ask_user_question`),所以会被注入 ---- `suggest_prompts` 的落法见第四节五与第八节.
其余是 orphan:下游没有对应工具,注入后模型选中只会报 `unknown tool`.
**这是官方提示词与下游能力之间的固有缺口,不是本仓的缺陷** ----
唯一的缓解是下游自己实现对等工具,或由下游 harness 在提示层覆盖该指令.

## 五点五,签到(streak)链路

官方**没有签到接口**. 客户端全仓只有一处 streak 调用:

```
GET /api/v1/freebuff/streak   只读, 报告状态
```

当天签到的触发条件是官方文案写死的那句: `+{freebucksDailyBonus} to your daily
allowance with each day's first message` ---- 也就是 **当天第一条消息**.
所以`一键签到` = 逐账号读状态, 对今天还没签的发一条最小消息.

真值出处(实证, 不是推断): 官方客户端产物的 orchestrator bundle 里,
服务文件名为 services 目录下的 streak 模块(createDesktopStreak.fetch).
注意那是**上游**路径, 不要写成仓库相对路径形态.

要改这条链路, 先读 `src/web/store/signin/` 三个文件:

| 文件 | 管什么 |
|---|---|
| `store.ts` | 防抖状态(手动 18h / 自动 25h)与`alreadySignedToday` 判据 |
| `run.ts` | 逐账号: 读 streak -> 已签跳过 -> 发最小消息 |
| `auto.ts` | 自动签到调度(默认关闭, 每轮重读开关) |

**成本纪律**(最容易踩): `admit = 买断一小时`. 所以顺序必须是
[先读 streak], `todayCredited/todayUsed` 为真就跳过 ---- 已签过的账号
绝不重复付费. 状态读不到时**不猜也不试**, 记 failed 而不是默默花钱.

## 六,改动清单(照抄)

| 场景 | 要改的文件 |
|---|---|
| 下游工具有官方等价物 | `src/upstream/signals/tool-name-map.ts`(Node 侧)+ `cli-bridge/lib/tool-map.ts`(bun 侧),两张表逐条一致 |
| 参数形态与官方不同 | `src/upstream/signals/tools/param-rules.ts` |
| 参数翻译引擎要动 | `src/upstream/signals/param-map.ts` |
| 官方工具集的元数据(分组/说明)变了 | `src/upstream/signals/tools/official-tool-select.ts` + `docs/reverse/captures/official-tools.json` |
| 新增下游声明形态的测试 | `test/fixtures/dsh-tools.json` + `test/suites/entries/verify/tool/param/dispatch-ready.ts` |

改完必须跑:

```bash
npm test            # 含 dispatch-ready / param-idempotent / tool-name-mapping
npm run typecheck && npm run check:gates
```

## 七,反向纪律(不要做的事)

1. **不要为没有下游对应物的官方工具补映射. ** 映射表里加一个下游从不声明的名字,
   只会让回程造出下游不认识的别名(实测 `unknown tool "ls"`).
2. **不要跳过 `cli-bridge/lib/tool-map.ts`. ** Node 侧与 bun 侧是两张表,
   只改一张会让同一官方名在不同协议路径上还原成不同的下游名.
3. **不要把"参数翻译"做成"照抄官方字段". ** 下游普遍声明
   `additionalProperties: false`,多一个键就整条被判非法.
4. **不要用"看着对"代替实测. ** 本仓反复出现过"源码看起来该如此,实测相反".

## 八,本轮已落地的两个先例

**先例一: suggest_prompts -> ask_user_question.** 官方 worker system 模板明文要求
模型调用它,而下游没有同名工具. 载荷 prompts:[{prompt,label}] 与下游的
questions[].options[] 同构,所以走 OFFICIAL_NATIVE_TO_CLIENT 映射,参数翻译把
N 个建议合成一题多选(不拆成 N 个问题). label 官方可选而下游必填,缺失时用
prompt 截断兜底.

**先例二: 官方 system 提示词可配置.** 控制台[上游与工具]区有[官方系统提示词]卡,
三态: 照抄官方原文(默认) / 使用自定义正文 / 不带官方系统提示词,另有[查看官方原文]
与[恢复官方原文]两个按钮. 真源在 src/web/store/config/settings-store.ts 的
officialSystemPromptMode,经 RPC 透传到 cli-bridge/lib/endpoints/chat-payload.ts
的 buildSystemMessages.

改这条链路时注意一个坑(已踩过): none 的语义是[不加官方 system],不是
[清掉所有 system 消息]. 把下游客户端自己的 system 一起删掉是另一回事.
