# Agent Note: 官方 system 模板的动态段必须在运行时重算

Status: implemented

## Problem

我们发出去的官方 system 模板里, 有几处是**抓包那一刻被冻住的值**, 一直原样转发:

```
Current date: October 3, 2026.          <- 抓包当天
<repository_stats>
repository_visibility: unknown
indexed_project_files: 69               <- 抓包那台机器的统计
detected_test_files: 5
</repository_stats>
```

这不只是[内容过期]. 更硬的问题是**形态与官方不同**, 而形态本身就是上游判定
第三方客户端的依据之一:

1. `renderWorkerSystem` 把 `<repository_stats>` 整块替换成 `JSON.stringify({gitAvailable,
   repositoryVisibility, fileCount, ...})`. 官方从不发 JSON ---- 它是**换行分隔的
   `key: value` 行**(见 orchestrator 的 stats 数组).
2. `<changed_file_paths>` 被替换成**空串**. 官方在无 git 时发固定文案
   `(Git metadata unavailable to this host)`, 从不发空块; 而且上面那行
   `Changed file paths (unavailable):` **本身也是动态的**(有 git 时带数量).

## Decision

按官方在 orchestrator 里的真实实现重写这两处:

- **日期**: `Intl.DateTimeFormat('en-US', {year,month,day})`(我们原有的格式与官方一致,
  保留), 每次渲染用当前时间.
- **`<repository_stats>`**: 生成[换行分隔的 `key: value` 行]. 没有 git 数据时只发官方
  也一定会有的一行 `repository_visibility: unknown` ---- 官方对每项都是[有值才发该行],
  所以少发是官方行为, 而不是我们漏了.
- **`<changed_file_paths>`**: 整块替换(开标签到闭标签), 无 git 时填官方固定文案,
  同时把 `Changed file paths (...)` 那行的括号内容改成 `unavailable` 或文件数.

git 数据来源: 官方的 `fileContext.gitChanges` 是**客户端本地仓库**的上下文, 而本代理
不接触用户的仓库, 所以这里如实发 unknown / unavailable ---- 那正是官方在无 git 时的
真实形态. 参数口(`opts.repositoryStats` / `opts.changedFilePaths`)留着, 将来若能从
请求里拿到仓库信息可直接接上.

## Alternatives considered

**什么都不做, 把抓包值当模板的一部分原样发.** 否决: 抓包的日期与统计数字是**一台特定
机器在特定时刻**的事实. 每次请求都向上游声明 [今天是 2026-10-03] 与 [项目有 69 个文件],
既错又不一致 ---- 而且这是可被上游直接观测到的自相矛盾.
**把 stats 的 JSON 换成 YAML 或别的结构化文本.** 否决: 形态只有一个正确解 ---- 官方用什么
就用什么. 自选一种[差不多]的格式等于继续制造第三方信号.
**无 git 时干脆删掉整段 `<repository_stats>`.** 否决: 官方模板固定含这段, 删掉会让模板
与官方结构不一致; 官方自己遇到无 git 也是发 `repository_visibility: unknown`.
**从我们自己的仓库(`freebuff-proxy`)读 git 统计填进去.** 否决: 那是**代理的**仓库, 不是
用户项目的. 把我们的统计冒充用户项目的, 比发 unknown 更糟 ---- 它是有内容的假信息.

## Consequences

- 日期每次请求重算(实测渲染出 `Current date: October 6, 2026.`).
- `repository_stats` 与 `changed_file_paths` 的形态与官方一致; 无 git 时发官方文案.
- 抓包残留(`October 3, 2026` / `69` / `5` / JSON 形态)全部消失, 有断言钉住.
- 新增套件 `test/suites/entries/verify/system-prompt-dynamic.ts`(18 断言).
  可证伪: 去掉日期替换, 套件立刻变红(实测 exit=1).
- `opts.repositoryStats` / `opts.changedFilePaths` 是预留的接线口, 当前无人传.