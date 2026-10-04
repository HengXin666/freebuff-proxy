# Agent Note: Catalog Key ↔ Human-Readable Id Bridge

Status: implemented

**Affects:** `src/upstream/catalog-protocol.js`, `src/web/api.js`, `dashboard/app.js`

## Problem

上游有**两套模型标识口径**,此前没有桥:

- **回执侧**(`session.model` / `rateLimitsByModel` / `freebucks.prices`)用
  **目录 key**:`m-00032eaeec`
- **catalog / 自定义模型侧**用**人类可读 id**:`deepseek/deepseek-v4-flash`

两个后果:

1. 控制台[额度]列裸显示 `m-00032eaeec 10 FB/h · ≈2 小时 30 分` —— 用户看不出是哪个模型.
2. [同步上游模型]点了没反应:它拿 `m-xxx` 当 id 写进自定义模型,
   而实际调度/匹配走的是人类可读 id,写进去的条目永远匹配不上任何模型.

## Decision

在 `CatalogHolder` 抓目录时**顺手缓存两张表**(目录响应本来就带这些字段,不额外发请求):

- `displayNames`: key → `displayName`(`m-00032eaeec` → `MiMo 2.6 Flash`)
- `keyByDigest`: legacy 摘要 → key(与既有 `legacyIndex`(摘要 → 句柄)互补)
  —— 句柄是**发出去**用的,key 是**收回来/展示**用的,两边口径不同都要能查.

web api 侧新增两个解析函数(取不到就回落原值,绝不因取不到名字而让整行渲染失败):

- `modelDisplayName(key)` → 显示名
- `catalogIdForKey(key)` → 用 legacyDigests 反查内置 catalog 的人类可读 id

出口接上:
- `/api/accounts` 额外给 `modelDisplayName`(**原 `session.model` 字段保留**——
  它是调度/寻址真值,不能被展示名覆盖)
- `/api/models/upstream` 每条补 `displayName` 与 `catalogId`
- 前端[同步上游模型]优先用 `catalogId`,`m-xxx` 只作回退

## Evidence

真实上游目录(13 行)实测:

```
m-00032eaeec  MiMo 2.6 Flash         -> mimo/mimo-v2.5
m-096e75164d  DeepSeek V4.1 Flash    -> deepseek/deepseek-v4-flash
m-5a5d0e255e  GPT-6 Luna             -> openai/gpt-6-luna
m-cb71f819fe  MiMo 2.6 Pro           -> (catalog 无对应，属上游新模型)
```

13 行里 9 行能映射到 catalog id;另外 4 行是上游有,内置 catalog 尚未收录的新模型 ——
**这几条正是[同步上游模型]该补进去的**,此前因为口径不通而永远补不进来.

## Consequences

- 额度列显示人能认的模型名.
- 同步上游模型真正生效(写入的是人类可读 id).
- 上游新模型(catalog 暂无对应)会以 `m-xxx` 兜底写入并带 `displayName`,
  至少可见可用,不会静默丢失.
- 无额外网络请求:映射数据本来就在目录响应里.

## Alternatives considered

### 1. 前端自己按 id 前缀猜显示名

**Rejected:** `m-xxx` 是不透明服务端标识,不含任何可推导信息,猜不出来.

### 2. 把 catalog 的 id 全换成目录 key

**Rejected:** 会破坏所有下游 Agent 客户端的模型名(`deepseek/deepseek-v4-flash`
是 OpenAI 兼容生态的通用写法),且已落库的自定义模型全部失效.

### 3. 只修显示名,不管同步

**Rejected:** 同步不生效是同一根因的另一半,只修一半用户仍会报"点了没反应".

### 4. 每次展示都去查一次上游目录

**Rejected:** 多一次外网往返;映射信息在已抓的目录里就有,缓存即可.

## Related

- `.agents/notes/implemented/bug-fix/2026-10-01-legacy-model-digest-mapping.md`(FNV-1a 摘要映射)
- `.agents/notes/implemented/bug-fix/2026-10-01-catalog-protocol.md`(目录协议)
