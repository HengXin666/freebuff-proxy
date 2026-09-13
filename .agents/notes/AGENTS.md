# AGENTS.md — Agent Notes

Agent Note 记录的是「为什么是这个形状, 以及为此放弃了什么」—— 代码和普通文档都放不下这两样.
Agent 每次会话从零开始, 读到的只有当下的代码, 所以一个已权衡过的取舍在它眼里就是多余的复杂度,
于是被"顺手简化"掉. Note 就是那道护栏.

- **路径即身份**: `.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`.
- `proposed/` 是还没建的决策; `implemented/` 是已上线、且与代码保持同步的; `rejected/` 是输掉的
  提案, 只在还能拦住一个有人可能重犯的错误时保留.
- 极少数确实不需要 note 的受保护改动, 把理由写进本目录的 `NOTE-EXEMPT.md`:
  `note-exempt: <为什么这次不需要 note>`, 覆盖率门禁会用这个豁免代替 note.
- **一篇 note 只管一条决策.** 只有事实移动(路径、名字、默认值)时就地更新那篇;
  绝不把它改写成另一条决策 —— 要取代它, 并双向互链.
- **每一篇 active note 都要带 `## Alternatives considered`.** 没写打败了什么的决策, 会被重新论证.
- **不要 `INDEX.md`**: 目录树本身就是索引; 一个共享索引会把每次并行改动都变成冲突.
- archived/ 是冻结的. 已封存的 note 永不编辑、翻译、重排版或移动.

**小标题用英文, 正文随你.** `## Problem` / `## Decision` 这类标题是被机器校验的词元; 正文写中文
(或任何语言)完全不影响门禁. 但别在一篇里混用两种语言的小标题.

动手改一个声明之前, 先读它旁边引用的那篇 note(任何 `.agents/notes/<lifecycle>/<class>/<file>.md` 路径).
任何改动之后跑 `node .agents/skills/hx-agent-notes/scripts/verify-all.ts`; 动了受保护的源码, 就必须在同一次改动里带上 note.
