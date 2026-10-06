# Agent Note: 官方 code_search 落到下游的命令执行工具, 参数合成 ripgrep 命令

Status: implemented

## Problem

官方工具集里的 code_search 在下游可能落成一个工具名对得上, 参数却完全不同的接法.
本机 dsh 会话记录(2026-10-06, agentPreset=minimal)里的真实现场:

```
injectableOfficialTools(极简模式 27 工具) = [run_terminal_command, code_search]
调用 {"pattern":"TODO","maxResults":3}
  -> Error: invalid arguments: missing required property "search_term";
     missing required property "search_folder_absolute_uri"
```

下游那个同名工具由第三方插件 dsh-devin-search 注册, 参数是 search_term 与
search_folder_absolute_uri. 关键难点是后者: 它必须是**绝对路径**, 而这个路径
上游不会给下来 ----

- 官方 cwd 参数的文档原文是 relative to the project root, 形态与语义都不是绝对路径;
- 官方 system 模板里的 {CODEBUFF_USER_CWD} 取值来自客户端本机, 本代理拿不到, 被替换成空串.

于是任何[补一个绝对目录]的做法都要求使用者按机器配一个值, 而这个值在多工作区场景下
必然出错: 同一个 dsh 用户会在 web/ds-test, AI-Code/..., HXLoLis/... 下各开会话, 单个
全局路径只在固定工作区时才正确.

## Decision

**把官方 code_search 落到下游的命令执行工具(bash), 由参数合成一条 ripgrep 命令.**
命令天然在会话工作目录里运行, 搜索根是相对语义 ---- 不需要任何按机器配置的绝对路径.

三处改动:

1. **优先级表**: 新增 OFFICIAL_TOOL_CLIENT_PRIORITY, 把 code_search 的候选按
   grep -> bash -> code_search -> find 排序, 取本次声明集里第一个命中.
   新增这张表而不是改表内顺序, 是因为[决定落点]与[知道等价名]是两件事: 大表只说
   哪些名字是同一个官方工具, 优先级说同名候选之间选谁.
2. **命令合成**: search-command.ts 的 buildSearchCommand 把官方四个字段全部编进命令 ----
   pattern 进 -e, flags 逐 token 原样透传(官方文档原文就是 Advanced ripgrep flags,
   例 -i / -g *.ts / -A 3), cwd 进搜索根(缺省用 .), maxResults 进 -m.
   每个参数用单引号包住, 通配符因此不会被 shell 先展开. 机器上没有 rg 时命令自动退回 grep.
3. **形态分支**: 同一个下游名 bash 可能收到两种官方载荷(run_terminal_command 与
   code_search), 判据是 pattern 字段. 命中时由规则里的 searchCommand 合成参数并跳过
   逐字段翻译; 合成结果照常过 synth 与按下游 schema 裁剪.

**同一次改动里删掉了上一版新增的 downstream.searchFolder 配置项与整个 ParamContext
管道** ---- 命令方案让它彻底没有用处. 用户裁决过[轻量优先, 禁止加无用东西], 留一个
没人读的配置项比少一个功能更糟.

## Alternatives considered

**什么都不做, 只在前端说明[极简模式下 code_search 不可用].** 否决: 极简模式声明 27 个
工具, 而官方 37 工具里只有两个能派发 ---- 砍掉其中一个等于砍掉一半可用面. 而失败现场
(下游报 missing required property)看不出是本代理没翻译.

**配一个绝对搜索目录传给下游的同名工具(上一版的方案).** 否决: 单个全局路径在
[同一台机器上按会话切换工作目录]时必然指错; 而下游的校验器会直接拒掉不在会话 cwd 内的
根, 报 Search folder must be inside the local session workspace. 命令方案的相对路径
从根上绕开了这个约束.

**复用现有 grep 规则, 让官方 code_search 也走 grep.** 否决: 极简模式**没有声明 grep**,
凭空造出下游不认识的别名只会得到 unknown tool. grep 仍保留在优先级表最前, 因为它是
原生搜索工具且参数形态本来就对得上 ---- 有 grep 的客户端形态行为零改动.

**让模型自己填搜索目录(把该字段塞进下行参数).** 否决: 模型看到的是官方 schema, 官方
schema 里没有这个字段; 伪造官方形态会让上游按第三方客户端判据处理, 这正是本代理要避免的.

**把 cwd 与 pattern 拼成一条更简单的命令(不引号包裹).** 否决: pattern 含空格或通配符时
会被 shell 拆开, 只剩第一个词进 -e; *.ts 之类会被当前目录展开成文件名列表. 单引号包裹
同时解决这两件事, 且官方 flags 的方言与 rg 完全一致, 不需要翻译.

## Consequences

- 极简模式(以及任何只有 bash 没有 grep 的客户端)下, 官方 code_search 一次就能派发成功.
- 有 grep 的客户端形态(原生 55 工具)行为完全不变: 仍是 grep, 走原有规则.
- 下游机器需要 rg 或 grep 之一; 两者都没有时命令以非零码失败并给出 shell 的原始报错.
- 官方 maxResults 是[每文件上限], 映射到 rg -m 的语义与它一致.
- SAME_NAME_SHAPE_DIFFERS 仍需保留: 下游确实声明了同名 code_search 时, 名字还原不改写
  它, 缓冲判据必须显式覆盖这一类, 否则流式路径会漏翻译.
