# 门禁、脚本与 CI

每个门禁都是一个**独立的 TypeScript 脚本,零第三方依赖**,所以能直接丢进任何 Node 18+ 的项目,在 CI 里不需要安装步骤就能跑. 它需要一个能执行 TypeScript 的运行器:`tsx`(走 `npx`,或者作为 devDependency),或者原生剥类型的 Node >= 22.6. `init-agent-notes.ts` 会在当前 Node 能剥类型时选 `node`,否则选 `npx tsx`;`assets/hooks/pre-commit` 先试原生 Node,失败再退回 npx.

## 脚本

| 脚本 | 检查什么 |
|---|---|
| `verify-all.ts` | 按顺序跑下面所有门禁,给出一个结论. CI 和 pre-push 用这个. |
| `verify-tree.ts` | 生命周期与类别目录、路径层数、`yyyy-mm-dd-topic.md` 文件名、不许有 `INDEX.md`、不许有杂文件、以及 note 之间的相对 markdown 链接能否解析. |
| `verify-format.ts` | 头部块、状态与生命周期是否一致、`Status:` 是否只有一行、首节是否为 `## Problem`、各生命周期的必需章节、`implemented/` 里被禁的提案期标题、必填的 `## Alternatives considered`、译文骨架配对. |
| `verify-coverage.ts` | 守住这次改动:被修改的路径若落在 `coverage.guarded` 内,同一次改动里就必须有 note 变动,除非 `NOTE-EXEMPT.md` 记录了理由. |
| `verify-backlinks.ts` | 源码里对 note 路径的每一条引用都能解析 —— 取代动作归档 note 之后最常见的腐化. 打开 `backlinks.required` 时,还会要求每一篇已落地的 note 都被源码引用到. |
| `seal-archive.ts` | 归档件与 manifest 哈希是否匹配、seal 相对一个可信的早期版本是否仅追加(`--baseline <ref>`,默认 `HEAD` 或 `AGENT_NOTES_BASE_REF`)、每篇归档 note 是否都带 `Archived:` 行. `--write` 封装新归档件,并且在还有违规未清时**拒绝写入**. |
| `archive-note.ts` | 把某一篇 implemented note 移进归档区、盖上 seal 行、报告来自其他 note 与源码的入站引用、重新封装 manifest. `--dry-run` 只报告不写入. |
| `new-note.ts` | 按对应骨架创建一篇 note,路径、日期、状态都填好. |
| `init-agent-notes.ts` | 装出目录树、契约文件、配置和 package scripts. 幂等. |
| `build-board.ts` | 产出看板页面,实时链接版或内嵌版. |
| `notes-lib.ts` | 共享的配置发现、目录遍历、链接解析、glob 匹配、manifest 处理. 被其余脚本 import;**不要直接运行它**. |

## 调用方式

```sh
# 整套门禁(CI 跑的)
npx tsx .agents/skills/hx-agent-notes/scripts/verify-all.ts

# 只查已暂存的,给 pre-commit hook 用
npx tsx .agents/skills/hx-agent-notes/scripts/verify-all.ts --staged

# 指定比较基准,给 CI 或长命分支用
npx tsx .agents/skills/hx-agent-notes/scripts/verify-all.ts --base origin/main
```

## 配置

`.agents/notes.config.json` 是可选的;每个键都会回落到同一个默认值. 它能配:

- `root`、`archive`、`lifecycles`、`classes`、`rootAllowlist` —— 那些封闭集合. **扩展一个集合是一次刻意的配置改动**,外加项目 notes `AGENTS.md` 里的一行说明. `rootAllowlist` 列出允许出现在 notes 根目录的文件;如果你用逃生舱,记得把 `NOTE-EXEMPT.md` 留在里面.
- `translationSuffixes` —— 视为同一篇 note 的对照件后缀(默认 `[".zh.md"]`;`[]` 关掉整项配对检查).
- `formatAdopted` —— 从这个日期起 `## Alternatives considered` 才必填,这样从旧实践迁移过来的 note 可以带 grandfather 注释.
- `proseBannedPhrases` —— 格式门禁直接拒绝的字面短语,用来对付你总在手工清理的、语言或项目特有的口水话.
- `coverage.enabled` 关闭这项保护;`coverage.guarded` / `coverage.exempt` 说明哪些源码路径会强制要求 note. 把 `guarded` 指向**真正承载决策**的目录;一个会对生成文件或 vendored 文件报警的保护,最后会被整个关掉. `coverage.label` 是在 `NOTE-EXEMPT.md` 的理由里搜的字面词元(默认 `note-exempt`).
- `backlinks.enabled` 关闭这项门禁;`backlinks.roots` / `extensions` 说明去哪儿找引用、找哪些文件类型;`backlinks.exclude` 把工装、vendored 目录、以及**故意构造合成 note 路径的测试夹具**排除在扫描之外.
- `backlinks.required` —— 是否要求**每一篇** implemented note 都被源码引用到. 默认关闭,而且打开前值得想一想:上游 DSH 只引用了大约八分之一的已落地 note,很多决策并不对应任何一行代码. 如果你的仓库里所有决策都是实现层面的,可以打开;如果"一次绿跑"比"一张完整的地图"更重要,就让它关着.

`AGENT_NOTES_ROOT` 覆盖目录树位置,`AGENT_NOTES_CONFIG` 指定一份显式配置,`AGENT_NOTES_BASE_REF` 设定比较基准,`AGENT_NOTES_COVERAGE=off` 关掉覆盖率保护,`AGENT_NOTES_SCRIPTS_DIR` 告诉安装器 skill 在目标项目里的位置.

当 skill 安装在仓库之外(比如用户级 skills 目录)时,给每个脚本传 `--repo <dir>`,或者从仓库根目录运行;目录树是通过从工作目录向上查找 `.agents/notes.config.json` 定位的. 运行安装器之前先设好 `AGENT_NOTES_SCRIPTS_DIR`,这样它写出的 package scripts 指向的路径才真实存在.

## CI

把 [../assets/ci/github-actions.yml](../assets/ci/github-actions.yml) 拷到 `.github/workflows/agent-notes.yml`,或者把 [../assets/ci/gitlab-ci.yml](../assets/ci/gitlab-ci.yml) 拷进 GitLab 流水线. 两者都通过 npx 取 tsx、拉取完整历史(这样覆盖率 diff 才有合并基)、并把可信的基准提交传给归档校验.

有两个性质让这条流水线**可信而不只是好看**:

- 归档校验比的是**变更前的那个提交**,不是工作区 —— 所以本地改一篇冻结的 note 再重跑封装脚本,依然会失败.
- **分支保护必须把这个 job 设为必需. 没有被要求的门禁,只是一条建议.**

## 本地 hook

[../assets/hooks/pre-commit](../assets/hooks/pre-commit) 跑格式、反向引用和已暂存的覆盖率这三项 —— 就是能在错误离开本机之前抓住它的三项 —— 能原生剥类型时走 Node,否则走 `npx tsx@4`. 完整门禁集留在 CI 里,那里慢一点不要钱.

## 把门禁交给 agent

当你委派一次非平凡的改动时,**要求 note 与代码在同一次提交里**,并要求 agent 在汇报前跑完整套门禁. **门禁失败却报告"做完了"的改动,不算做完**;门禁的输出是交付物的一部分.

## 覆盖率语义

`covered` 的意思是**同一次改动里有任何一篇 active note 的 markdown 发生了变动** —— 新建、更新,或因取代而移动. 这项门禁是**刻意机械**的:它看得见 notes 树动了,看不见动的那篇是不是**在讲这次改动**. 只改译文的变动不算,只碰 `AGENTS.md` 的也不算,因为契约文件本身不承载任何决策.

这个后果值得点明:**更新一篇无关的 note 也能满足这项门禁.** 这是一台机器能诚实做出的检查所付出的代价,而补上缺口的是评审者 —— 或者读 diff 的 agent. **不要把一次绿色的覆盖率运行读成"这次改动被记录了".**

`--staged` 拿索引区跟 HEAD 比,这才是 pre-commit hook 应该看到的. 默认是拿工作区跟 HEAD 比,适合那种 agent 很少提交的项目 —— 注意:一旦某次 note 改动被提交了,一个尚未提交的源码改动就会被读成"没覆盖",而这是正确的答案.
