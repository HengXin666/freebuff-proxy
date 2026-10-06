# Agent Note: 参数翻译补 ask_user_question 与 bash 两处越界

Status: implemented

## Problem

上两篇 note(`2026-10-05-downstream-tool-restore-declared-names` /
`2026-10-06-tool-param-idempotent-and-multi-harness`)解决了[名字还原]与[翻译幂等],
但没有一句话回答"这 10 个注入项里, 有几个真能一次调用成功". 2026-10-06 逐项普查后,
答案是 9/10, 且另有三处[翻译了但下游用不了]的边界.

三条硬缺陷(全部有实测):

1. **`ask_questions` 有名字映射但没有参数规则.** `ask_user_question` 在映射表里指向
   它, 规则表里却没有这条, 于是官方参数原样下发. 用 dsh 自己的校验器实跑:
   `validateJsonSchemaValue(askSchema, 官方参数)` 返回
   `missing required property "arguments.questions[0].id"` ---- 下游每个问题必填
   `id`, 官方 schema 里没有这个字段. 另有 `multiSelect`(官方驼峰)对
   `multi_select`(下游蛇形)的形态差.

2. **`bash` 的 `timeout_seconds: -1` 会直接抛错.** 官方把这值定义为[不限时]且
   schema 里合法(minimum -1), 翻译规则是 `v * 1000`, 得到 `timeoutMs: -1000`;
   下游 `dsh-tool-bash` 要求 `timeoutMs > 0`, 抛 `invalid timeoutMs`.

3. **`bash` 的 `process_type` 被整条丢弃.** 官方 `BACKGROUND` 对应下游
   `run_in_background`, 规则表没收它 ---- 模型以为把命令丢到后台, 实际前台跑,
   到点被掐.

另有两处信息损失(不是失败, 但静默丢内容): `read_files.paths` 官方是
`maxItems: 10` 的数组, 翻译只取第一条; `str_replace.replacements` 是
`minItems: 1` 的数组, 同样只取第一条.

## Decision

在 `src/upstream/signals/tools/param-rules.ts` 加一条规则, 改一条规则:

- 新增 `ask_user_question`: 逐项合成 `id`(按序号, 下游要求同调用内唯一),
  `multiSelect -> multi_select`, 其余字段同名直通; 已带 `id` 的输入保持原样(幂等).
- `bash.timeout_seconds`: 只对 `> 0` 换算, 越界值直接丢弃(下游按自己默认上限).
- `bash.process_type`: `BACKGROUND -> run_in_background: true`.

新增回归套件 `test/suites/entries/verify/tool/param/dispatch-ready.ts`(78 断言), 判据是
[把名字还原 + 参数翻译串成一次真实调用], 用**下游自己声明的 `required`** 判过不过,
不依赖宿主包的私有导出(升级即碎).

多路径/多替换的截断**本次不改**: 下游 `read` 是单文件语义, 要真支持多路径需要先让
下游接受数组, 那是协议扩展不是翻译修复. 本次只把它写进已知边界.

## Alternatives considered

**什么都不做, 只在文档里写清"这 10 个里 9 个能用".** 否决: `ask_questions` 是
官方 worker system 模板**点名要求**调用的工具, 不是可选能力; 留着一个注定失败的
注入项等于让每次"想问用户"都白跑一轮.

**把 `ask_questions` 从注入名单里摘掉, 回避参数翻译.** 否决: 下游
`ask_user_question` 真实存在且是常用工具, 摘掉等于把一个本该可用的能力永久关掉,
而修复成本只是一条规则.

**`timeout_seconds` 越界时改成钳到最小值(如 1ms).** 否决: `-1` 的官方语义是
"不限时", 钳成 1ms 会让一条长命令在 1 毫秒后被掐死 ---- 比丢弃更糟. 丢弃字段
让下游按自己的默认上限处理, 语义上最接近"不限时".

**`process_type` 映射成 `run_in_background` 时把 `SYNC` 也显式写成 `false`.**
否决: 下游 `run_in_background` 是可选项, 显式写 `false` 与不写等价, 多一个键
反而增加与官方形态的差异面.

**给多路径/多替换做"循环展开成多次调用".** 否决: 一次工具调用扩成 N 次需要下游
逐次确认, 且回程要合成 N 条 `tool_calls`, 改动面远超本次范围. 下游 `read` 的
语义就是单文件, 硬凑会造出与下游契约不符的形态.

## Consequences

- `ask_questions` 从"必失败"变成可用; 官方回的多问题会自动获得互不相同的
  `q1/q2/...` id.
- `bash` 的 `timeout_seconds: -1` 不再崩, 而是落到下游默认上限.
- 后台执行意图不再丢.
- 已知边界保持: 多路径/多替换只取第一条, 且**没有日志提示** ----
  想彻底解决需要下游支持数组形态.
