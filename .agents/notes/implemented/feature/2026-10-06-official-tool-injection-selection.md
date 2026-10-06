# Agent Note: 官方工具按[下游本次声明]自动裁剪注入, 控制台可显式覆盖

Status: implemented

## Problem

上游官方工具集 37 个, 而我们无条件把它们全量并进出站 tools. 其中 27 个在下游
没有任何对应物(浏览器预览 17 个, 加上 list_directory / end_turn / suggest_prompts /
write_doc / browser_check / report_project_profile / read_thread_context /
request_elevation / register_preview / run_file_change_hooks).

回程只给 10 个官方名备了下游落点, 所以那 27 个一旦被模型选中, 下游必然报
unknown tool. 这不是理论风险: 本机全量会话扫描(1165 个会话 / 1424 条 isError)里
suggest_prompts 一条在 2026-10-06 仍在发生, unknown tool "ls"(list_directory 的
别名)51 条, missing required property "file_path" 31 条.

根因分两半, 缺一不可:

1. 出站: 全量注入, 用户无法控制注入哪些.
2. 机制: 名字与参数必须成对翻译, 只翻名字会造出[名字对, 参数残缺]的调用.

## Decision

出站注入改成逐项可选, 默认全注入(零回归), 分类真源落在
src/upstream/signals/tools/official-tool-select.ts:

- common(10 个): 官方等价物在下游真的声明过, 回程能还原并派发. 默认勾选.
- orphan(27 个): 下游没有对应物, 默认不勾选.

分类判据是[下游真的声明过那个名字], 不是映射表里有没有写别名 ---- 表里给
list_directory 写了 ls / list_dir, 但没有任何真实下游声明过它们.

默认注入集由**自动规则**算出, 判据只有一句: 模型选中这个官方工具后, 回程能把它还原成
下游**这次真的声明过**的名字 ---- 还原得回去才可能派发.

为什么不能停在静态分类表: 静态表对不上客户端形态. 2026-10-06 活的复现(会话只声明
`run_code`)里, 模型调了 `write_todos` / `list_directory` / `read_files` / `suggest_prompts`
全部 unknown tool; 而静态表判为可派发的那 10 个同样是死路 ---- 下游压根没声明 `read` /
`bash` / `write`. 实测两种形态:

| 客户端形态 | 声明数 | 自动规则注入 | 当年静态表结果 |
|---|---|---|---|
| 原生(dsh) | 55 | 10 | 10(一致) |
| PTC | 1(仅 run_code) | 0 | 37 个全部派发不了 |

自动规则对任意客户端零配置生效, 接新客户端不需要维护任何表.

三态语义必须分开(不能用一个空数组表达两种意思):

| 配置 | 含义 |
|---|---|
| undefined | 未配置 -> 走自动规则 |
| [] | 显式清空, 一个都不注入 |
| [名字...] | 只注入这些, 且先与真源求交集 |

链路: 控制台新增[官方工具]分区(左侧导航第 2 项) -> POST /api/settings
.officialToolNames -> SettingsStore(实时字段) -> tryOfficialChannel 解析成名单
-> RPC payload -> bun 侧 buildTools 按名单过滤官方工具集.

两处实现细节值得记住:

1. 过滤放在 mergeOfficialTools 之前. 放在之后的话, 被剔掉的官方工具仍占着
   seen 集合, 下游声明的同名工具会因为它而被丢掉(名字在, 工具从两边一起消失).
2. 名单在 bun 侧裁剪而不是在主服务删 tools 键: 删键会让[下游没声明工具]与
   [控制台配成不注入]在 wire 上完全一样, 事后无法区分.

回程参数翻译同步补一条说明: read_url 的 max_chars 下游没有对应字段, 只能丢;
显式写进规则注释, 是为了说明[为什么这个字段不在表里]而不是漏了它.

## Consequences

默认路径逐字节不变: 未配置时 officialToolNames 是 undefined, 主服务传 undefined,
bun 侧不做过滤 ---- 出站 tools 与改动前完全一致, 所以既有判据
(chat-payload-contract / tool-name-mapping / tool-restore-declared /
tool-param-idempotent / tool-stream-rewrite)全部保持原状.

配置过之后才有行为差异: 不勾的官方工具不再出现在出站 tools 里, 模型看不到也就
不会选中, unknown tool 那一类随之消失. 代价是官方工具集指纹不再完整 ----
所以默认是不裁剪, 由用户按需取舍.

## Alternatives considered

- **什么都不做 / 让用户忍**: 最省事, 但默认配置下就带着 27 个必然失败的注入项,
  而且故障形态是[模型选中才炸], 偶发且难归因. 否决理由: 默认值应当是能工作的那个.
- **默认只注入 common 10 个**: 直接消除故障, 但会永久改变出站形态. 官方工具集是
  上游识别客户端形态的一部分(docs/reverse/18 §4), 默认就裁掉 27 个等于替所有用户
  做了这个权衡. 否决理由: 默认不动, 把选择权交给用户.
- **在回程给那 27 个硬凑下游落点**: 表面上能让调用[不报错], 但落点是我们编的,
  语义会被改(把 end_turn 收敛到哪个下游工具都别扭), 而且下游没有的东西骗不过去.
  否决理由: 命名要诚实, 宁可让用户看见 unknown tool 也不要静默走错工具.
- **出站删 tools 键而不是在 bun 侧过滤**: 少一个字段, 但丢掉了[为什么没注入]的
  事后可辨识性. 否决理由: 两种原因在 wire 上不可区分等于把排障成本推给下一个人.
