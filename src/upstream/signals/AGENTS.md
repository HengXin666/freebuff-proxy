# AGENTS.md -- src/upstream/signals

> 本目录管一件事: **下游客户端与上游官方客户端之间的[名字与形态]翻译**.
> 本文件只写在本目录里改代码必须遵守的约定, 目标 <= 150 行.

## 这个目录是什么

上游把[工具集与客户端形态是否像官方 CLI]当第三方客户端判据. 本目录是这条
判据的**唯一翻译层**: 进来时把下游工具名换成官方名, 出去时把官方名换回下游名,
中间把参数形态一并翻译. 任何"名字对不上/参数对不上"的故障, 真源都在这里.

| 文件 | 管什么 |
|---|---|
| `tool-name-map.ts` | **名字双向映射唯一真源**: `CLIENT_TO_OFFICIAL_TOOL` 下行, `buildOfficialToClientMap` 构造上行还原表 |
| `declared-names.ts` | 把[本次声明]归一成名字集合(Set / 数组 / OpenAI 工具数组) |
| `param-map.ts` | 参数翻译**引擎**(按规则改字段并裁剪) |
| `tools/param-rules.ts` | 参数翻译**规则数据**(官方字段 -> 下游字段) |
| `tools/official-tool-select.ts` | 官方 37 工具的元数据 + 本次该注入哪些 |
| `mcp-names.ts` | 官方 MCP 载体名形态的本地镜像 |
| `detect.ts` | 外部客户端信号判定 |

## 铁律

1. **名字表有两份, 必须逐条一致.** Node 侧 `tool-name-map.ts` 与
   bun 侧 `cli-bridge/lib/tool-map.ts` 是同一张表的两次书写,
   `test/suites/entries/verify/tool/name-mapping.ts` 有断言. 只改一张 =
   同一官方名在不同协议路径上还原成不同下游名.
2. **没有规则的组合一律返回 null**, 调用方原样保留参数.
   宁可下游看到陌生的官方字段, 也不要用错误规则把参数改坏.
3. **翻译后必须按下游 schema 裁剪.** 下游普遍声明
   `additionalProperties: false`, 多一个键整条被判非法.
4. **下游要而官方没有的字段, 用 synth 补.** 靠"下游自己会兜底"是错的:
   `bash` 的 `description` 是必填而官方没有, 不合成就是
   `missing required property "description"`.
5. **回程还原按[本次声明]过滤.** 下游这次没声明过的客户端名不许被造出来,
   否则模型调用官方原生工具时会得到下游不认识的别名(实测 `unknown tool "ls"`).
   声明集为空时才退化为全表 ---- 这个退化路径是已知风险, 别扩大它.
6. **参数不是"翻译了"就等于"下游能用".** 官方合法值可能是下游非法值
   (实例: 官方 `timeout_seconds: -1` = 不限时, 下游 `timeoutMs <= 0` 直接抛错).
   写规则时要拿**下游的 schema 或校验器**实跑一遍, 不能只看字段名对上了.

## 加新工具时按这个顺序做

完整流程见 [docs/guide/tool-compat.md](../../../docs/guide/tool-compat.md)(主题 `tool-compat`).
这里只写本目录内的落点:

1. 判通道: 官方有等价物 -> 加 `CLIENT_TO_OFFICIAL_TOOL`(两份表都加);
   没有 -> 什么都不用改, 自动走 `src/proxy/transport/tool-carrier.ts` 的载体通道.
2. 比对 schema: 官方 schema 取 `docs/reverse/captures/official-tools.json`,
   下游 schema 取调用方本次声明(夹具 `test/fixtures/dsh-tools.json`).
   **逐字段比对字段名 / 类型 / 必填性.**
3. 有必要就加 `PARAM_RULES` 一条.
4. 补 `test/suites/entries/verify/tool/param/dispatch-ready.ts` 的官方参数样本与断言.
5. 可证伪: 临时把实现改坏, 确认测试变红, 再还原.

## 不变量(改动前后都必须成立)

- `injectableOfficialTools(declared)` 返回的每个名字, 其还原目标必须都在
  `declared` 里 ---- 否则那个工具注定 `unknown tool`.
- 官方 37 工具里, 只有存在下游对应物的才会被注入; 其余(浏览器预览 / 写文档 /
  提议后续提问等)注入后模型选中必然失败.
- 官方 worker system 模板**明文要求**模型调用 `suggest_prompts` / `write_todos` /
  `ask_questions` 等名字. 裁掉 `tools` 里的定义消不掉提示词里的字符串 ----
  模型仍可能"提到"它们. 这是官方提示词与下游能力之间的固有缺口, 不是本层缺陷.

## 中文标点

本目录代码注释与文档一律 **ASCII 标点**, 门禁逐文件棘轮只许降. 下面这些
本体里的全角字符是**故意保留**的, 不要在清理标点时一起改掉:

- `tools/official-tool-select.ts` 的 `desc` 字段是给控制台看的中文说明;
- 各文件里表示[概念标签]的全角方括号是书写约定, 不参与标点判据.

## 验证

```bash
node test/suites/entries/verify/tool/param/dispatch-ready.ts   # 一次调用可用性(本目录主判据)
node test/suites/entries/verify/tool/param/idempotent.ts # 翻译规则性质
node test/suites/entries/verify/tool/name-mapping.ts     # 两张名字表一致
npm test && npm run typecheck && npm run check:gates
```
