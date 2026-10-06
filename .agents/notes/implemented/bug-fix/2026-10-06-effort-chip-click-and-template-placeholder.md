# Agent Note: 思考强度芯片点了没反应 + 控制台显示渲染稿而不是官方模板

Status: implemented

## Problem

用户实报两个缺陷, 都是[界面看起来对, 但用不了 / 内容错]:

**一, 思考强度卡的档位芯片点不动.** 卡片渲染出芯片(有模型的机器上能看到 low/high/max 一排),
点上去没有任何反应, 选中态与配置都不变. 用户原话: [即便有模型的情况下, 我也无法去选择它的那个思考强度].

根因是**芯片没有挂事件处理器**: `effortChips` 造 `button` 时只写了 class 与 data-* 属性,
没有任何 click 绑定; 整张卡片里唯一的事件处理只在总开关上. 渲染路径全对, 交互路径根本不存在.

**二, 官方系统提示词显示的是[抓包那次渲染出来的结果], 不是官方模板.**

用户在编辑器里看到的是:

    Current date: October 3, 2026.
    ...
    <repository_stats>
    repository_visibility: unknown
    indexed_project_files: 69
    detected_test_files: 5

日期是抓包当天, 69/5 是抓包那台机器的统计. 点[恢复官方原文]拿到的也是这一份.

根因: 抓包文件 `docs/reverse/captures/official-system-prompts.json` 存的是**渲染后**的文本,
而控制台的编辑器与[恢复官方原文]都直接读它. 官方源码里的同一份模板写的是
`${PLACEHOLDER2.CURRENT_DATE}` / `${PLACEHOLDER2.KNOWLEDGE_FILES_CONTENTS}` /
`${PLACEHOLDER2.GIT_CHANGES_PROMPT}`. 把渲染稿给人看再让人保存, 等于把[别人那次运行的
日期与仓库统计]写成他的出站文本.

## Decision

**一, 选中态归卡片, 保存处理器只负责落盘.** 芯片的 click 先调
`toggleEffortChip`(同一模型内互斥)再调保存回调. 把切换塞进保存处理器会让
[点了没反应]与[存失败]长得一模一样 ---- 保存失败时用户还需要看到自己刚点了什么.

**二, 控制台给的是模板形态.** 新增 `src/upstream/official-template.ts` 的
`toPlaceholderTemplate`: 按锚点把渲染稿还原成占位符形态, 只做形态还原, 不取任何值.
运行时渲染仍然只在 cli-bridge 的 `renderWorkerSystem` 一处.

三处替换(锚点判定, 缺锚点就原样返回, 不按猜测截断):

| 渲染稿里的内容 | 还原成 |
|---|---|
| `Current date: <任意>` | `{CODEBUFF_CURRENT_DATE}` |
| git 摘要首句 -> `</changed_file_paths>` 整块 | `{CODEBUFF_GIT_CHANGES_PROMPT}` |
| 该块之前的空行(知识文件渲染成空串留下的) | `{CODEBUFF_KNOWLEDGE_FILES_CONTENTS}` |

编辑器上方加一行常驻说明, 写明[看到的是占位符形态, 运行时替换] ----
否则用户会把 `{CODEBUFF_CURRENT_DATE}` 也当成一处[没渲染好的错].

## Consequences

- 芯片: 点击即选中, 同模型互斥, 再点一次取消; 每次变更都 POST 整份表.
- `/api/settings` 的 `officialSystemPromptDefault` 改为占位符形态, 编辑器与[恢复官方原文]共用它.
- 还原规则可往返自证: 用原值渲染回去必须与抓包快照**逐字节相同**(测试里有一条断言钉死).
- 静态部分(开场白 / 规则条目 / Desktop 段)逐字节保留, 测试对四条正文断言.

## Alternatives considered

- **什么都不做, 只把抓包文件换成模板**: 抓包文件是[客户端真值]的证据, 直接改成模板会污染
  证据链(以后无法分辨哪份是原样抓到的). 否决, 改为在读取侧还原.
- **不还原日期, 只在运行时替换日期**: 统计与变更文件块同样是别人机器的值, 且它们不在
  `applyPlaceholders` 的五项里, 只修日期等于把另一半问题留给用户. 否决.
- **让[恢复官方原文]填模板, 但编辑器仍显示渲染稿**: 两处内容不一致会让[恢复]看起来像[改内容].
  否决, 两处共用同一个占位符形态真源.
- **芯片用 `onchange` + `input[type=radio]` 代替按钮**: 视觉上要重做一版样式, 且和卡片里
  其它按钮的交互语言不一致. 否决, 保留按钮 + 显式 click.
- **把还原逻辑放进 cli-bridge 的 system.ts**: 那是[渲染]的唯一真源, 塞进[反向还原]会让
  两个方向互相纠缠; 控制台(Node 侧)只需要只读的形态还原. 否决, 单独一个纯函数模块.
