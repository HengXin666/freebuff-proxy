# Agent Note: 对外模型名统一为可读口径(消灭裸目录 key 与派生 agent)

Status: implemented

**Affects:** `src/model.ts`, `src/web/api.ts`, `dashboard/app.ts`, `dashboard/i18n.js`

## Problem

用户要求把[前端显示的模型名]与[对外 API 提供的模型名]统一成**一种可见的模型名**,
不要再出现上游不透明标识 `m-00032eaeec`.实测(2026-10-03,本地 `node bin/serve.ts` +
CDP 抓控制台)复现两处:

1. **控制台[模型管理]的[模型 ID]列仍是裸目录 key**.`/api/models/upstream` 的
   `models[].id` 直接取 `rateLimitsByModel` 的键(目录 key),前端 `known.set(m.id, …)`
   与表格首列都用它 → 页面渲染出 5 行 `m-00032eaeec` / `m-096e75164d` / ....
   同一行的 AGENT 列渲染成 `base2-free-m-00032eaeec` —— 这是 `deriveAgentId()` 对目录
   key 做通用 slug 化的产物,**上游根本不存在这个 agent**(真值是统一 agent
   `base3-free-catalog`,见 2026-10-01-catalog-agent.md).
2. `/v1/models` 已按 `catalogId || displayName || key` 取可读口径(2026-10-02/10-03 两轮
   修复),但 `/api/models/upstream` 没跟上,两条出口口径不一致,同一个模型在
   两个界面上一个叫 `mimo/mimo-v2.5`,一个叫 `m-00032eaeec`.

## Decision

**可读口径只定义一次,两个出口共用**:`可读名 = catalogId || displayName || key`.

1. `/api/models/upstream` 的 `models[].id` 改用该可读口径,并新增 `key` 字段保留目录
   key 真值.key 是调度/白名单的判据(`isModelAllowed` / `handleFor` 都认它),
   **不能**被展示名覆盖,所以它是**并列字段**而不是被替换掉.
2. 控制台表格首列改显示 `id`(可读),目录 key 退到该列 `title` 悬停提示里
   (排障仍要能对上上游日志);[删除/隐藏]仍提交 `key`,避免 hidden 表从调度口径
   漂移到展示口径.
3. `agentIdForModel` / `agentFallbackForModel` 增加**目录 key 判据**:输入是目录 key
   (`m-xxx`)或句柄(`fbm1.`)时直接返回 `CATALOG_UNIFIED_AGENT_ID`.这与
   `proxy.js` 的 `isCatalogMode`(`snap.model` 以 `m-`/`fbm1.` 开头)同源,消除
   `base2-free-m-00032eaeec` 这类凭空推导出来的 agent.
4. `/api/models/upstream` 的 agent 列直接写 `CATALOG_UNIFIED_AGENT_ID`:该接口的条目
   **全部**来自会话回执/实时目录,而 proxy.js 对目录模式用的就是这个 agent.
5. 顺带修掉 CI `i18n` job 的三处硬编码中文(`t('key') || '中文'` 兜底与
   `` `${name}（${model}）` ``)——它们让 v1.17.1 / v1.18.0 两次镜像构建在
   `i18n` 关卡失败,`build-push` 被跳过.

## Alternatives considered

- **让 `/api/models/upstream` 保持裸 key,只在前端做映射** —— 前端确实已有
  `state.modelNames`(key → displayName),改前端最省事.**否决**:用户的要求是
  [对外提供的 api 也不要再用那个模型 ID],只修前端等于把问题留在 API 里;
  而且前端拿不到 `catalogId`(无 catalogId 的新模型就没有可读 id 可用),
  映射只能在有 digest 索引的后端做.
- **把 `/v1/models` 的 id 全改成 `displayName`(`MiMo 2.6 Flash`)** —— 最"人话".
  **否决**:`catalogId`(`deepseek/deepseek-v4-flash`)才是 OpenAI 兼容生态与上游
  共用的模型名,带空格的 displayName 会让下游 Agent 的模型选择器与日志解析别扭,
  且会与已落库的自定义模型 id 全面失配.裸目录 key 才是要消灭的那个东西.
- **给 `deriveAgentId` 对 `m-xxx` 特判成 `base2-free`** —— 改动最小.**否决**:
  `base2-free` 是 legacy 世代的通用 agent,目录模式下上游要的是
  `base3-free-catalog`,返回 `base2-free` 仍是错的,只是错得没那么显眼.
- **完全不显示 agent 列** —— 表格信息少一列,用户看不到"调度到底会用哪个 agent",
  而这一列的意图正是暴露映射错误.**否决**.
- **什么都不做,等用户报障再修** —— i18n 三处是 CI 稳定失败(本地可复现
  `node scripts/check-i18n.ts` → exit 1),镜像推不出去,没有"等待"的余地.

## Consequences

- 控制台[模型管理]首列显示 `mimo/mimo-v2.5` / `Solar Pro 4`,AGENT 列显示
  `base3-free-catalog`,不再是 `m-00032eaeec` / `base2-free-m-00032eaeec`.
- `/v1/models` 与 `/api/models/upstream` 的 id 口径完全同源,同一个模型在控制台与
  下游 Agent 里叫同一个名字.
- `isModelAllowed` / `handleFor` / 调度行为**不变**:`key` 字段与
  `upstreamModelIds` 都原样保留(判据真值不动,只改展示口径).
- i18n 红线恢复通过,镜像构建链路可继续.
- note 备份:`fbm1.` 句柄目前只出现在调度内部,未走本函数路径,判据一并覆盖以防未来
  有调用方传句柄进来时又推导出一个不存在的 agent.

## Evidence

- 实测(本地 `FREEBUFF_PROXY_PORT=28287 node bin/serve.ts` + CDP 抓 `#accounts` 视图文本):
  修复前 `m-00032eaeec	MiMo 2.6 Flash	limited	10 FB/h	base2-free-m-00032eaeec	base2-free	上游`
  (共 5 行同形);`/v1/models` 已无裸 key(`裸key条数: 0`).
- `node scripts/check-i18n.ts` 修复前 `exit=1`,报 3 项硬编码中文
  (`app.js:565` / `app.js:572` / `app.js:2727`);CI run 37064022127 与 37111896574
  的 `i18n` job 复现同一组报错,`build-push` 因 `needs: [test, image-boot, i18n]` 被跳过.
- 目录抓取实测:`handles: 53`,`recommendedKey: m-00032eaeec`,
  `displayNames` 含 `m-00032eaeec → MiMo 2.6 Flash`,`m-9a7e098cc1 → Solar Pro 4`
  (后者无 catalogId,属上游有,内置 catalog 未收录的新模型).
