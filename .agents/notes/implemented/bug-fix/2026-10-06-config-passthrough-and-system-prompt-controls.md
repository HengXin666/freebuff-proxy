# Agent Note: 出站配置在 bun 侧被逐项丢弃, 官方 system 提示词改为可配置

Status: implemented

## Problem

用户报"前端工具注入改了不生效": 在控制台把[官方工具注入]的勾选全部取消并保存,
出站 `tools` 一个都没少. 排查后确认前端与状态存储都是对的, 真因在 bun 侧两层
"逐项挑字段"转发:

```
cli-bridge/lib/upstream/actions.ts   actReuse   只挑 6 个字段
cli-bridge/lib/endpoints/session.ts  reuseChat  只挑 7 个字段
```

主服务在 Node 侧算好的 `officialToolNames` / `systemPrompt` / `layer` /
`reasoningEffort` 走到这两层全被吃掉, 于是下游行为与配置完全无关.
同一缺陷也存在于 `actChat`(非流式路径).

既有防线全漏的原因: `cli-bridge/` 不在 tsconfig 的 include 里, tsc 看不见
"少传一个可选参数"; 而没有任何测试真执行过 `reuse` 路径.

同期用户提出两项诉求:

1. 官方 worker system 模板里明文要求模型调用 `suggest_prompts` / `write_todos` /
   `request_elevation` / 预览类工具, 其中下游没有对应物的那些必然失败.
   需要能[看到官方原文 / 换成自己的 / 整段不带 / 一键恢复].
2. `suggest_prompts` 不该只当 orphan 丢掉 ---- 它的载荷是一组 `{prompt, label}`
   可点击项, 与下游 `ask_user_question` 的 `questions[].options[]` 同构,
   应当映射过去而不是每轮报一次 unknown tool.

## Decision

**三处执行层修复**(都在 cli-bridge):

- `reuseChat` 改为展开透传(不再逐项挑字段);
- `actReuse` / `actChat` / `actFull` 显式带上 `officialToolNames` /
  `systemPrompt` / `layer` / `reasoningEffort`.

**官方 system 提示词三态**(控制台可配):

- 新字段 `officialSystemPromptMode`(`official` / `custom` / `none`)与
  `officialSystemPromptText`, 真源在 `settings-store.ts`, 经 RPC 透传到
  `buildSystemMessages`;
- 新增控制台卡片 `dashboard/views/proxy/inject/system-prompt.ts`:
  三态切换 + 自定义正文 + [查看官方原文] + [恢复官方原文];
- `none` 的语义是[不加官方 system], **不是**清掉客户端自己的 system ----
  实测过一版把两者混同的实现, 那会连带删掉下游的 system 提示.

**`suggest_prompts` 映射**:

- 新增 `OFFICIAL_NATIVE_TO_CLIENT` 表(官方原生名 -> 下游等价物).
  为什么另立一张而不是往 `CLIENT_TO_OFFICIAL_TOOL` 里加: 那张表的键是下游名,
  一个下游名只能指向一个官方名; 而这里要表达的是**反向的一对多**
  (`ask_questions` 与 `suggest_prompts` 都落到 `ask_user_question`).
- `PARAM_RULES.ask_user_question` 增加 `prompts` 分支: N 个建议合成
  [一题多选](不拆成 N 个问题 ---- 官方形态就是一组可点击卡片, 拆开会变成
  N 次独立作答, 与[挑一个继续]的原意不符); `label` 官方可选而下游必填,
  缺失时用 `prompt` 截断兜底, `prompt` 原文进 `description`.

**新增回归判据** `test/suites/entries/verify/config-passthrough.ts`(23 断言):
验[给 reuseChat 的四项配置必须出现在最终 chat 的入参里]. 破坏 `...opts`
即红(已验证退出码 1).

## Alternatives considered

**在 Node 侧把配置塞进 `messages` 或别的字段绕过 bun 的挑字段.** 否决:
那等于在协议层伪造字段, 与[照抄官方抓包]的口径冲突; 而且真正的问题是
bun 侧不该挑字段, 绕过它等于把缺陷留在原地等下一次踩.

**只修 `reuseChat`(不修 `actReuse`).** 否决: 两层各丢一次, 只修一层仍有
一半配置到不了 -- 这正是本次能用 `config-passthrough` 把两层都钉住的原因.

**`suggest_prompts` 直接保持 orphan, 由用户手动取消勾选.** 否决: 官方模板
明文要求[几乎每轮都调用它], 模型会持续尝试; 而映射成本只是一条规则 + 一张
三行的表. 不映射等于每轮白跑一次.

**`suggest_prompts` 拆成 N 个 `questions`.** 否决: 与官方[一组建议卡片]的
形态不符, 且下游会要求逐题作答.

**官方 system 提示词只做[查看], 不做可编辑.** 否决: 用户明确要求能配置且能恢复;
只读等于把[模型照提示词去调不存在的工具]这个问题留给用户自己忍.

**`none` 态清掉所有 system 消息.** 否决: 实测会让下游自己的 system 一起消失.
`none` 的准确语义是[不加官方 system].

## Consequences

- 控制台的[官方工具注入]与[官方 system 提示词]现在真的生效(此前前者被静默丢弃).
- `suggest_prompts` 从[必失败]变成[渲染成一组可点击选项];
  55 工具形态下可注入项从 10 个变成 11 个.
- 默认路径零回归: 未配置时 `systemPrompt` 为 `undefined`, bun 侧照抄抓包原文.
- 目录重组: `dashboard/views/proxy/{official-tools,system-prompt}.ts` 移入
  `inject/`; 测试按域分到 `verify/{model,tool,tool/param}/`. 起因是
  `dir-files` 门禁的[同目录 <= 5 个受控文件]在新增两个文件后触顶.
