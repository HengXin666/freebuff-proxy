---
name: hx-agent-notes
description: Turn a project's engineering decisions into a living, path-indexed .agents/notes tree with mandatory quality gates and an optional GitHub/GitLab pipeline. Use when recording why a change was made and what was rejected so the next agent does not re-litigate or "simplify" it away; when bootstrapping decision governance (ADR, RFC, decision log, decision record, architecture decision) into a repo; when adding, updating, superseding, or archiving an Agent Note; when wiring pre-commit or CI gates that require a note alongside guarded source; or when auditing a decision corpus for stale and unreferenced notes.
license: MIT
metadata:
  author: Heng_Xin
  version: "1.0"
---

# Agent Notes

代码里放不下的是**为什么是这个形状,以及为此放弃了什么**. Agent 每次会话都是从零开始,读到的只有当下的代码,所以一个已经权衡过的取舍,在它眼里就是多余的复杂度,于是被"顺手简化"掉. Note 就是那道护栏.

这个机制来自 `deepseek-harness` 仓库的 `.agents/notes` 实践 —— 两个月约 1900 篇,规则是**已落地的 note 要跟着代码在同一次改动里一起更新**. 每条规则为什么存在,见 [references/mechanism.md](references/mechanism.md);规则本身没说清的时候去读它.

## 1. 判断该不该写

改动涉及行为、架构、跨文件或跨包的契约、流程与工具、测试策略,或者磁盘/线上/配置格式 —— 写. 纯格式化、无行为变化的锁文件升级、打 tag —— 不写.

判据:**半年后的读者会不会问"为什么不用更简单的那个做法?"** 会,就写. 拿不准,就写. 完整矩阵(含"该更新旧 note 而不是新建"的情形)见 [references/when-to-write.md](references/when-to-write.md).

## 2. 落地这次改动

**更新优先于新建**:先找已经在管这条决策的 note,就地修正事实. 只有真正的新决策才开新文件.

```sh
# 新建:路径、日期、对应生命周期的骨架都会填好
npx tsx .agents/skills/hx-agent-notes/scripts/new-note.ts proposed architecture session-store-handles

# 已落地的决策,其理由正在过期
npx tsx .agents/skills/hx-agent-notes/scripts/archive-note.ts .agents/notes/implemented/architecture/2026-08-27-x.md
```

Note 与代码**同一次提交**,并且**标注在它被强制执行的位置** —— 紧贴它所约束的那个声明,而不是某个不相干文件的开头:

```ts
/**
 * 会话是仅追加的,这样崩溃不会撕裂索引
 * (见 .agents/notes/implemented/architecture/2026-08-27-append-only-sessions.md).
 */
export function appendSession(...)
```

写成相对 markdown 链接也可以,编辑器里还能点;层数按该文件到 notes 根的相对深度算.

一条决策引用一次,就引在**未来某个人最可能把它"简化"掉**的那一行. 没有需要记的标记词:任何指向 note 路径的引用都算,而 `verify-backlinks` 会让**解析不到的引用**变红 —— 这就是为什么归档一篇 note 会顺手留下一张"待改代码清单". 头部块、各生命周期骨架、以及"事实可以更新但决策不许改写"的规则,见 [references/note-format.md](references/note-format.md).

## 3. 给还没有这套目录的项目装上

```sh
npx tsx .agents/skills/hx-agent-notes/scripts/init-agent-notes.ts
```

它会建出:三个生命周期 + 六个类别的目录、带 kind 子目录的归档区、契约文件 `AGENTS.md`、`.agents/notes.config.json`,以及在有 `package.json` 时写好 npm scripts. 幂等;要覆盖已有文件必须显式 `--force`.

然后还有三件必须做的事:

1. **把 skill 目录搬进项目** `agents/skills/hx-agent-notes/`:生成的 npm scripts 指向它,而 CI 拉的全新 clone 够不到你个人目录下的 skill.
2. **把 [assets/AGENTS.snippet.md](assets/AGENTS.snippet.md) 写进项目根的 `AGENTS.md` / `CLAUDE.md`** —— 没有任何东西会自动加载 notes 自己的 `AGENTS.md`,必须由根指令文件把 agent 引过去.
3. 把 `.agents/notes.config.json` 里的 `coverage.guarded` 指向**决策真正藏身的目录**.

顺序问题、小项目的轻量引入方式、以及迁移已有的 ADR 存量,见 [references/adopting.md](references/adopting.md).

## 4. 跑门禁

```sh
npx tsx .agents/skills/hx-agent-notes/scripts/verify-all.ts            # CI 跑的
npx tsx .agents/skills/hx-agent-notes/scripts/verify-all.ts --staged   # hook 跑的
npx tsx .agents/skills/hx-agent-notes/scripts/verify-all.ts --base origin/main
```

| 门禁 | 拦什么 |
|---|---|
| `verify-tree.ts` | 生命周期或类别目录写错、路径层数不对、文件名不合规、出现被禁的 `INDEX.md`、根目录混入杂文件、note 之间的死链 |
| `verify-format.ts` | 头部块坏了、`Status` 与所在目录矛盾、缺 `## Problem` 或 `## Alternatives considered`、已落地的 note 里留着提案期的措辞、译文骨架漂移 |
| `verify-backlinks.ts` | 源码引用了已解析不到的 note 路径 —— 归档之后最常见的腐化 |
| `seal-archive.ts` | 冻结的 note 字节被改、seal 被删、归档件没有 seal |
| `verify-coverage.ts` | 动了受保护的源码,同一次改动里却没有 note |

`verify-coverage.ts` 看的是 diff. 逃生舱是**显式**的:把理由写进 `.agents/notes/NOTE-EXEMPT.md` 的 `note-exempt: <为什么这次不需要 note>`,这样豁免是一个被记录下来的动作,而不是一次静默的放过.

**给 agent 下命令,而不是下政策**:要求"同一次提交里带上 note,并在汇报前跑门禁". 流水线直接取 `assets/ci/github-actions.yml` 或 `assets/ci/gitlab-ci.yml`;本地快速版是 `assets/hooks/pre-commit`. **分支保护没有设为必需的门禁,等于建议.** 完整配置项与 CI 语义见 [references/verify.md](references/verify.md).

## 5. 怎么写好

- `## Alternatives considered` 是整套动作里最值钱的一节. 每个对手都先给它最强的论据再驳回,并且**永远包含"什么都不做,或复用已有的"**这一档.
- `## Consequences` 要写**变难的部分**,不只写变好的部分. 没有基线的相对断言("更快""更小")是未经验证的声明 —— 要么给出基线,要么改成陈述事实.
- `implemented/` 一律**现在时**. 不要"原先"、不要"本 PR"、不要"后续会". 站在 HEAD 上的读者必须能**仅凭仓库**验证每一句话.
- **不要编造 alternatives 来凑满这一节**,只记录真正权衡过的.

泄漏清单与矫枉过正的陷阱见 [references/prose-checklist.md](references/prose-checklist.md). 写完后要跑的**语义自检**见 [references/quality-gate.md](references/quality-gate.md):用五行报告哪些站得住、哪些有缺口,然后交给人类决定接受还是补. **永远不要把一个语义判断塞进脚本** —— 一个会因为"动机不够强"而判失败的校验器,只会训练所有人无视它.

## 6. 出一块看板

```sh
npx tsx .agents/skills/hx-agent-notes/scripts/build-board.ts --init board.html "项目决策"
npx tsx .agents/skills/hx-agent-notes/scripts/build-board.ts --bundle .agents/notes demo.html
```

前者产出一个单文件页面,通过浏览器目录选择器**实时**读取 notes 目录,不需要构建、不需要起服务. 后者把全部 note 内嵌进去,得到可脱机分发的副本. 两者都由 [assets/board-template.html](assets/board-template.html) 渲染,按入站引用数列出**承重决策**,并给出被否决方案库、类别分布和时间线.

## 不可退让的几条

1. **一篇 note 只管一条决策.** 更新它,绝不把一条理由拆到两个文件里.
2. **决策永远不能被改写成另一个决策** —— 只能取代它,并双向互链.
3. **`## Alternatives considered` 在每一篇 active note 里都是必填.**
4. **完整的取代动作**要在同一次改动里归档旧 note,并修复**所有**入站链接.
5. **没有 seal 的东西不许进归档,进了归档的 note 永远不再编辑.**
6. 不打算推进的 proposed note,要么 rejected 要么删除,**绝不归档**.
7. **不要 `INDEX.md`. 路径本身就是索引.**

## 参考文件

按需加载;标了**总是**的,在写作时一律适用.

- [references/mechanism.md](references/mechanism.md) —— 这套目录为什么存在,以及每条规则背后的推理. 想质疑某条规则之前先读它.
- [references/note-format.md](references/note-format.md) —— 头部块、骨架、译文、以及事实必须保持现行的规则. **写或改任何 note 时,总是.**
- [references/classification.md](references/classification.md) —— 六个类别、它们的边界,以及脚本事后查不了的语义义务. **新建 note 时,总是.**
- [references/when-to-write.md](references/when-to-write.md) —— 该不该写的判据矩阵、更新与新建之分、取代的完整流程.
- [references/lifecycle.md](references/lifecycle.md) —— 保留、归档、删除,以及什么时候值得做全库体检.
- [references/prose-checklist.md](references/prose-checklist.md) —— 契约进门、推理过程出门,外加矫枉过正的陷阱.
- [references/quality-gate.md](references/quality-gate.md) —— 语义自检、汇报格式,以及怎么把规则接进项目.
- [references/verify.md](references/verify.md) —— 每个脚本、每个配置项、每个环境变量,以及 CI 契约.
- [references/adopting.md](references/adopting.md) —— 从零接入、收窄保护范围、迁移已有存量.

## 脚本

`scripts/notes-lib.ts` 是共享库 —— 配置发现、目录遍历、链接解析、glob 匹配、manifest 处理. **只 import,不要直接运行.** 其余都是入口:
`scripts/init-agent-notes.ts`、`scripts/new-note.ts`、`scripts/verify-all.ts`、`scripts/verify-tree.ts`、`scripts/verify-format.ts`、`scripts/verify-backlinks.ts`、`scripts/verify-coverage.ts`、`scripts/seal-archive.ts`、`scripts/archive-note.ts`、`scripts/build-board.ts`.

## 模板与素材

[assets/AGENTS.snippet.md](assets/AGENTS.snippet.md) 是接入时**行为侧**的那一半. [assets/board-template.html](assets/board-template.html) 是看板的底版. 写 note 可以从 [templates/proposed.md](templates/proposed.md)、[templates/implemented.md](templates/implemented.md)、[templates/rejected.md](templates/rejected.md) 起手,也可以直接让 `new-note.ts` 填好骨架.
