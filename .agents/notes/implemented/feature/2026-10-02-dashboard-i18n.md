# Agent Note: Dashboard i18n (zh-CN / en) With CI Red Lines

Status: implemented

**Affects:** `dashboard/i18n.js`（新）、`dashboard/app.js`、`dashboard/index.html`、
`dashboard/style.css`、`scripts/check-i18n.mjs`（新）、`.github/workflows/docker-image.yml`

## Problem

控制台全部文案硬编码中文（约 350+ 处）。英文用户无法使用。
而多语言最容易**静默退化**：有人图快在 `app.js` 里直接写一句中文，
中文用户完全看不出问题，英文用户看到一块中文，code review 极难发现。
所以要的不只是"支持英文"，而是**日后新增文案必须走字典**的强制机制。

## Decision

轻量方案（项目铁律：无构建、无第三方库）：
- `dashboard/i18n.js`：普通对象字典 + `t(key, vars)`，`{name}` 占位符替换。
  基准语种 `zh-CN`，另含 `en`。语种存 localStorage，**后端零改动**。
- `app.js` 改为 ES module（`index.html` 用 `type="module"`）以便 import。
- 顶栏 `<select>` 切换；切换后 `render()` 整页重渲染（只重画 DOM、不重拉数据，
  所以在途请求与已买断会话不受影响），并同步 `<html lang>`。

**红线** `scripts/check-i18n.mjs`，CI 独立 job `i18n`，且 `build-push` 依赖它：
1. `app.js` 不得有硬编码 CJK（豁免：块注释/行注释/`console.*`）
2. 各语种 key 与基准语种完全一致（缺/多都失败）
3. 代码引用的 key 必须存在于字典
4. 字典不得有重复 key（JS 对象后者**静默覆盖**前者，并行编辑易引入）
5. 死词条只警告不失败（冗余而非故障，但要在输出里可见）

## Consequences

- 419 词条 × 2 语种，代码引用 419 个 key，0 硬编码中文，0 死词条。
- 新增文案漏写某语种 → CI 直接 fail，不会静默退化。
- 字典元数据（语种自己的名字 `LOCALE_LABELS`）放在 `i18n.js` 而非 `app.js`：
  它**故意不翻译**（切换器必须让每个人认出自己的语言），且红线只扫 `app.js`。
- `POOL_LABELS` 这类存 key 名、运行时 `t(POOL_LABELS[x])` 的间接引用，
  红线扫描会单独识别（否则会被误判成死词条）。
- 曾踩坑：批量删除多行词条时只删了首行，留下语法破损的残余行 ——
  清理字典必须按**条目块**删（从 key 行到闭合 `},`）。

## Alternatives considered

### 1. 引入 i18next / vue-i18n 等库

**Rejected:** 项目铁律是"轻量优先，禁止加无用东西"，运行时依赖只有
`undici` / `yaml`。419 个词条用普通对象完全够，加库是纯负担。

### 2. 只做英文版，不做机制

**Rejected:** 用户明确要求"日后都要支持这种配置，要有红线来检查"。
没有红线的多语言必然退化。

### 3. 用构建步骤做编译期检查

**Rejected:** 引入构建会破坏"零依赖原生 JS SPA、改完刷新即生效"的现有形态，
收益（编译期报错）用 CI 脚本已经拿到。

### 4. 把语言存到后端 /data

**Rejected:** 语言是纯前端偏好，进后端会增加 API 面与状态，无收益。

## Related

- `scripts/check-i18n.mjs`：红线实现（含各条检查的注释说明）
- CI：`.github/workflows/docker-image.yml` 的 `i18n` job
- 本轮同时修的模型名显示：`.agents/notes/implemented/bug-fix/2026-10-02-catalog-key-display-name-bridge.md`

## Addendum: 语言切换器不能用 `<select>`（顶栏被撑宽）

初版用原生 `<select>` 做语言切换，**实测宽度 780px**（同页面普通按钮 56px）—— 顶栏被顶出一条很宽的选项栏，正是用户反馈的"选项栏变得非常宽"。
根因：原生下拉在没显式限宽时按内容/容器撑开，而 option 是全名（"简体中文" / "English"）。

改为 **`globe` 图标 + 短码按钮**（`中` / `EN`），点一下切到另一种语言；全名放进 `title` 与 `aria-label`。
实测 **56px，与相邻普通按钮完全一致**。

短码与全名都在 `dashboard/i18n.js`（`LOCALE_SHORT` / `LOCALE_LABELS`）：短码是 UI 文案的一部分，但红线只扫 `app.js`，放字典里也能和 `LOCALE_LABELS`（故意不翻译）挨在一起说明。

只有两个语种时"点一下切换"比下拉少一次操作；语种变多（>2）时应改回下拉，但需显式 `width` 限死。
