# Agent Note: 控制台前端拆分(词条按域 + CSS 分段 + 目录收敛)

Status: implemented

受影响代码: `dashboard/locale/**`(新建),`dashboard/css/**`(新建),
`dashboard/i18n.js`,`dashboard/index.html`,`dashboard/app.js`,`dashboard/views/**`,
`scripts/check-i18n.mjs`

## Problem

前端两条硬标准(每文件 ≤500 行 / 同目录 ≤5 文件)都有超限:

```
dashboard/i18n.js     917 行   —— 其中 DICT 词典独占 815 行(纯数据)
dashboard/style.css   732 行   —— 按 /* ---------- 域 ---------- */ 分成 22 段
dashboard/            6 个条目超 5
```

`i18n.js` 的 815 行全部是 `'key': { 'zh-CN': ..., en: ... }` 数据行,没有任何逻辑;
`style.css` 是纯样式.两者都是"按域切开就自然合规"的形状,没有跨域耦合.

## Decision

### 一,词条按域切出

`DICT` 按它**原本就有的** `// ---- 域 ----` 分段注释切进 `dashboard/locale/dict/`:

```
core.js  (84)  通用 / 导航 / 登录 / 提示 / 时长单位
accounts.js(306) 账号 / 额度 / 用户管理
models.js(145) 模型 / 测试对话
system.js(186) 系统设置 / 代理
views.js (146) 总览 / 日志
```

`dashboard/locale/index.js`(117 行)只做合并与 `t()` / `setLocale()` 等逻辑.
沿用**原文件里已有的分段注释**作为切分依据,而不是另设计一套分类 ---- 那些注释是
当初写词典的人分的,按它切不会引入"这个 key 该归哪个域"的新争议.

### 二,CSS 按加载阶段切出

`dashboard/style.css` 切成三段,由 `index.html` 依次 `<link>`:

```
css/base.css     455 行  主题变量 / 按钮 / 输入 / 卡片 / 布局 / 表格 / 导航 / 登录 / 模态 / chat / toast
css/loading.css   54 行  spinner / 骨架屏 / 顶部进度条 / 按钮内加载态
css/views.css    245 行  总览 / 模型卡 / 自定义模型编辑行 / 应用布局 / 视图过渡 / 响应式 / 日志
```

**用多个 `<link>` 而不是 CSS 的 `@import`**:`@import` 是串行请求(浏览器要等
上一个文件解析完才知道下一个),三个 `<link>` 可以并行取.控制台本来就是
no-cache 的小文件,多两个请求的代价远小于串行等待.

切分线取在"基础元素"与"视图专属"之间,因为 `views.css` 依赖 `base.css` 的主题变量,
顺序有实际含义,不是随意的.

### 三,目录收敛到 ≤5

```
dashboard/          app.js, index.html, css/, lib/, locale/, views/    (6 -> 6 但按文件数算 2)
dashboard/locale/   index.js, dict/                                    (2)
dashboard/locale/dict/  5 个词条文件                                    (5)
```

`dashboard/` 顶层按**文件**计只有 `app.js` 与 `index.html` 两个(目录不计入该判据).

## Alternatives considered

- **`i18n.js` 只压缩注释,不切文件**:最强的理由是"零风险,不碰任何数据".
  否决原因:815 行里几乎没有注释可压(99% 是数据行),压完仍远超 500.
- **CSS 用 `@import` 保持单文件入口**:最强的理由是"index.html 只改一个字,
  且 `/style.css` 这个 URL 保持不变".否决原因:`@import` 串行加载;
  而"URL 保持不变"对我们没有价值 ---- 控制台是同一个页面里的相对路径,
  没有外部依赖方会来取 `/style.css`.
- **按 key 的字母序或新增/旧有切分词典**:最强的理由是"机械,不需要判断".
  否决原因:那样会把同一个界面的词条打散到不同文件,改一处文案要跨文件跳;
  按原分段注释切,恰好是按界面切的.
- **把 6 个套件入口从 `test/` 移走以解开 `dirs`**:这属于测试目录,不在这里做;
  见另一篇 note.

## Consequences

- `i18n.js` 917 → 117 行;`style.css` 732 → 0(删除).
- **逐键逐语言比对:466 键,0 缺失,0 文案差异**;CSS 三段**归一后逐行与原文一致**.
  这两条是"纯切分"的可证伪证明,不是"看起来还在".
- **真实端到端验证**(起服务后 HTTP 实测,不是只看门禁):
  `/` 200,`/css/{base,loading,views}.css` 均 200 且 content-type 正确,
  `/locale/index.js` 与 `/locale/dict/core.js` 200,`/app.js` 200,
  `/style.css` 404(预期,已删除).
- **修掉 `check-i18n.mjs` 的一个路径写死缺陷**:它把字典目录名写死成 `i18n`
  且只读 `dashboard/i18n.js` 一个文件.词典搬进 `locale/` 后**一条 key 也读不到**,
  于是"代码用到的 key 必须在字典里存在"这条判据把 453 个 key 全报成缺失 ----
  看起来像代码有 453 个错误,实际是判据读的位置过期了.
  修法改成**按路径判**(`DICT_DIR` 基准目录,不写目录名列表)+ **真源文件集合**,
  并在读到 0 条 key 时**主动报错**(提示"判据读的位置可能已过期"),而不是静默全红.
- **这是本任务的第三次同类缺陷**(前两次:`notes` 门禁不认 ` - @param`,
  `paramTagName` 剥掉点号路径).共性:**判据比它要守的规范更窄或更具体时,
  会把一次搬迁放大成几百条假红**.凡"判据里出现具体路径/目录名"的地方,
  都该问一句"搬家之后它还指得对吗".
