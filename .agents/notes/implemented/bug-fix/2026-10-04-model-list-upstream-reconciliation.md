# Agent Note: 模型管理必须按上游目录对账,同步结果要报[对齐]而非[写了几条]

Status: implemented

## Problem

用户点[同步上游模型]后提出两点质疑,都成立:

1. **同步反馈没有意义.** 旧文案是[已同步上游(自定义 {n} 条,内置按 catalog
   为准)]—— 数字越大看着越成功,而那批自定义里绝大多数**上游目录根本没有**,
   调用必然失败.用户要的是[模型已对齐]这种以**上游为准**的结论.
2. **列表里塞满了调不了的模型.** 模型管理页把三份数据平铺进同一张表:
   内置 catalog 15 条 + 自定义 53 条(去重后 55 条),而**上游真实目录只有 13 条**.
   那些上游不存在的条目与可用模型长得一模一样,用户只能一个个试,试到失败
   才知道 —— 典型的误导.

实测(2026-10-04,单账号):上游目录 13 条;列表 55 条里能对上的只有 13 条,
**调不了的 55 条**(内置 15 + 自定义 40).

根因是判据缺位:**从来没有任何一处以[上游目录有没有这一行]来标记可用性**.
`buildModelsListResponse({includeAllCatalog:true})` 把内置目录全量吐出,
自定义条目又无条件并入,前端合并时只区分 `source`(built-in / upstream),
不区分**能不能用**.

## Decision

### 一,同步后弹[对齐报告]模态,不再用 toast

`syncUpstreamModels()` 写完自定义后,按上游目录做**三向对账**并如实报数:

- `aligned`:上游有,列表也有 → 能调用
- `added`:上游有,列表原本没有 → 本次补进来
- `stale`:列表有,上游目录没有 → 账号调不了

用模态而非 toast:toast 一闪而过,而[哪些其实调不了]是用户必须看清,
且要据此操作的结论.

`stale > 0` 时才显示[清理这 {n} 个]按钮 —— 没有脏数据时多一个按钮就是噪音.

### 二,模型表新增[账号可用]列 + 脏行淡化

判据就是 `上游目录里有没有这一行`:

- 匹配按**可读 id**(与 `/v1/models` 同源),目录 key(`m-xxx`)作兜底
  (旧自定义条目可能只存了 key).
- 命中 → 绿色[可用];未命中 → 橙色[不可用],且**整行 `opacity:.45` 淡化**,
  视觉上不再与可用模型平起平坐.
- 表头上方加对账条:`上游可用 {n} 个` / `{n} 个调不了` + 处置入口.

### 三,一键清理 `pruneStaleModels()`

不在上游目录里的:内置走 `hide`(可在[已删除的模型]区点回来),
手动添加的走 `remove`(彻底移除).幂等,可恢复.

## Alternatives considered

- **什么都不做(保留 55 条全量列表)** —— 用户已经明确说这是误导.
  下游 `/v1/models` 虽然是干净的 13 条(目录驱动),但控制台这张表是给人看的,
  人在里面挑模型,挑到必然失败的条目等于功能不可用.
- **只改文案,不动列表内容** —— 文案说[已对齐],列表里还是 55 条调不了的,
  用户点进去照样踩坑.判定(哪些能用)与呈现(怎么用)必须一起改.
- **同步时自动删掉脏数据,不弹窗** —— 更"干净",但删除是不可逆语义
  (自定义的 remove 无法回退),自动执行等于替用户做破坏性决定.
  改成**报数 + 显式按钮**,脏数据存在时给入口,不存在时不出现.
- **把脏行从表里彻底隐藏(而不是淡化)** —— 用户会以为它们凭空消失了,
  且内置的还能恢复.淡化 + 标注保留了信息,同时压低误导性.
- **用 toast 报对账结果** —— 三条数字 + 一句处置说明塞不进 toast,
  且一闪而过.见 Decision 一.

## Consequences

- **新增一个模态 DOM**(`#sync-report-backdrop`),复用既有 `.modal-backdrop`
  / `.modal` 样式(style.css 已有),无新样式依赖.
- **`model.syncDone` 词条被删除**,连带 `test/smoke.mjs` 的占位符断言
  从 `model.syncDone` 改到 `model.syncReportAligned` —— 断言若继续打在
  已删 key 上,中英两语都会回落到 key 原文,`notEqual` 必然失败.
- **判据依赖 `/api/models/upstream` 有数据**:未探测时 `upstream.models` 为空,
  此时对账条不渲染(`upstream.models?.length` 守卫),`isLiveUpstream` 全 false.
  这是刻意的:宁可不标,也不在没数据时乱标[不可用].
- **前端是 no-cache 静态文件**,改完刷新即生效,无需重建.

## Evidence

- 对账实测(2026-10-04,账号 `6199d6e9…`):上游 13 条;列表 55 条;
  能对上 13,新增 0,调不了 55(内置 15 + 自定义 40).
- 调不了的内置样例:`openai/gpt-5.6-luna`,`deepseek/deepseek-v4-flash`,
  `mimo/mimo-v2.5`,`z-ai/glm-5.3-flash`...(上游目录用的是可读名口径,
  这批是旧 provider 口径 id,故对不上).
- 调不了的自定义样例:`Qwen4.5 Plus Preview`,`Kimi K3.5 Max`,`Grok 5`...(40 条).
- 下游 `/v1/models` 实测 13 条,全部可读名 —— 目录驱动口径已是干净的,
  本次只补控制台侧的对账与呈现.
- 门禁:`node --check` 前端两文件通过;`check-i18n` 456 词条,无硬编码中文;
  `npm run typecheck` 通过;`npm test` smoke ok + 目录验证 13 条通过.
- 前端新符号已随 `/app.js` 下发(no-cache,刷新即生效).

## Addendum: 白屏事故与前端冒烟门禁(同日补记)

上表的 `staleCount` 第一版写在了 `const rows` **之前**,而它要读 `rows`
→ 命中 TDZ:`ReferenceError: can't access lexical declaration 'rows'
before initialization`,**整个控制台白屏**.

 关键教训:`node --check` **抓不到 TDZ** —— TDZ 是运行期错误,语法完全
合法,所以那次改动带着白屏过了 typecheck / i18n / smoke 全部门禁,
直到用户打开页面才发现.`node --check` 只能证明"语法对",不能证明"能加载".

因此新增 `test/smoke-frontend.mjs`:用最小 DOM 桩把 `dashboard/i18n.js` 与
`dashboard/app.js` 作为**真实 ES module 完整求值**一遍,任何 TDZ /
未定义引用都在求值阶段抛出.已接进 `npm test`.

判据函数(`isLiveUpstream`,不消费 rows)可以前置;
任何**消费** `rows` 的派生值都必须排在 `const rows` 之后.
