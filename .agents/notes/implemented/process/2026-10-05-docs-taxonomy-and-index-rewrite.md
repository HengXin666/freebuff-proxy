# Agent Note: docs 按主题分类 + 索引/AGENTS/README 重写

Status: implemented

## Problem

`docs/` 顶层堆积 13 份散落的 `.md` + 1 个 `.html`，读者无法从目录名判断
"想了解 X 该看哪份"。同时文档里大量本仓路径引用停留在 TS 化之前
（`.js`/`.mjs`），与"全仓 0 个 js/mjs、Node 原生直跑 .ts"的现状不符 ——
这些引用既误导读者，也躲不过 `check-docs` 的"本仓路径必须存在"判据
（判据只扫反引号包裹的路径，历史遗留写法恰好绕过了它）。

另一处结构性问题：`docs/code-quality/` 目录同时装着"工程质量全景"（描述现状，
**必须**参与 `check-docs` 全部判据）与"文档审计报告"（故意引用错误端点与已删
文件作反例，参与判据必然自噬）。两者的排除需求相反，却共用一个目录前缀，
于是排除粒度只能取更粗的那个 —— 全景被迫一起被排除。

## Decision

**按主题建四类目录，`code-quality` 目录撤销，`reverse`/`evidence` 原地不动：**

| 新位置 | 内容 | 归类理由 |
|---|---|---|
| `docs/guide/` | deployment / configuration / proxy / web-console / connection-health / development / screenshots | 面向使用者：装、配、用、排障 |
| `docs/design/` | scheduling / account-scheduling-and-refund / api / freebucks-strategy.html | 内部口径：调度、计费、对外 API 契约 |
| `docs/quality/` | code-quality-landscape / docs-audit | 工程质量与它的审计记录 |
| `docs/research/` | multimodal-image-input | 调研：结论性、建议未采纳 |

`freebucks-strategy.html` 是 `scheduling` 的图解，跟着 `scheduling.md` 走
（真源仍是 `design/scheduling.md`，HTML 不另立 key）。

**排除粒度随目录拆分收窄**：`DOC_EXCLUDE` 从 `docs/code-quality/` 改为
`docs/quality/docs-audit`。原来"为了排除审计报告，把整份代码质量全景也排除"
是一种误伤；拆开后全景重新回到判据覆盖内（真源声明数从 11 涨到 12 就是这条
修复的直接证据）。`copy-sweep.ts` 的 `REFUND-COPY` 豁免前缀同步收窄。

**引用重映射走脚本按行处理，不用字符串盲替**：搬家后所有指向这些文件的引用
（`docs/**` 内部相对链接、`AGENTS.md`/`README.md`、`.agents/notes/**`、
门禁与源码注释里的仓库相对路径）一次性重算。要求：逐行处理、跳过围栏代码块、
不重建行结构（第一版脚本按段落拼接字符串，把换行吃掉了，全仓 91 个文件的
行结构被毁 —— 已 `git reset --hard` 回滚重做）。

**以文件为粒度的排除清单**，而不是目录（见上表 "docs/quality/" 那行）。

## Alternatives considered

- **只加 `docs/README.md` 导航、不搬家**：最强的理由是"零风险，不动引用面"。
  否决原因：13 份散落文件里，读者要看的不是索引而是目录本身 —— 目录名
  `deployment.md` 与 `scheduling.md` 看不出"前者给使用者、后者是内部口径"。
  且引用面问题不会消失，只会随着文件继续增加而更贵。
- **保留 `docs/code-quality/` 目录，把全景挪到别处**：最强的理由是"改动最小"。
  否决原因：这会制造第五类目录只为装一份文件；而 `docs/quality/` 这个类别
  本身是必要的（工程质量的现状与审计都属于它），拆开的真正需求是**排除粒度**，
  那是改一行常量就能解决的事。
- **把 `docs/reverse/` 也按主题细分（协议/工具/封禁）**：否决原因：`AGENTS.md`
  「按症状查文档」表与 22 份文档的编号（`00`–`21`）是稳定引用面，细分会同时
  打断编号语义与表里的路径；且该目录整块被排除在判据外，分类收益低。
- **不重写 `AGENTS.md`/`README.md`，只改路径**：否决原因（这条是用户明确指示）：
  `AGENTS.md` 缺 TS 化、17 条红线、docs 新结构这三块已变化的事实；
  `README.md` 仍写"仅 2 个 JS 运行时依赖"与过时的自测版本号。只改路径等于
  把"文档已过时"从路径层搬到事实层，没有解决问题。
- **让 `npm run pricing` 类命令保留在 README 的"计费"节**：否决原因：那是
  面向使用者的命令，但它的输出是给维护者看的价目表；正文保留命令、细节链接
  到 `docs/design/scheduling.md` 是更合适的层次。

## 影响

- `docs/README.md` 重写：按四类目录组织"想了解 X 看哪个文件"，
  保留三条硬约定与真源地图，登记链接 39 条（下限 24）、覆盖 14 份文档。
- `AGENTS.md` 重写并压到 150 行（原 198 行）：保留全部生效约定与铁律，
  新增"语言与运行时"与"代码质量红线（17 条）"两节，更新 docs 结构。
- `README.md` 重写：面向使用者，新增"三步接入""配置入口""常见问题"三节。
- `.gates/style-baseline.json` 与 `.gates/fingerprint.json` 用门禁官方
  `--update` 重录：前者是搬家导致键名变更（**水位未变，只换键**），
  后者是 `check-docs.ts` 常量变更（`DOC_EXCLUDE`/`INDEX` 引用）。
