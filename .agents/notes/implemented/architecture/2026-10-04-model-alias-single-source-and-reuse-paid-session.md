# Agent Note: 模型标识映射的唯一真源;复用上游已付费会话(含跨部署)

Status: implemented

## Problem

用户连续两次指出同一个根因,措辞一次比一次重:

> [所有的对下游都会映射,所有的对上游的也会映射.你把这个给我弄好了,
> 每次去建这个模型,你每次都忘这个东西.]

> [你应该能自动窃取,就是在其他地方部署的这个会话......你他妈都能展示.
> 你为什么不能直接复用?你已经花钱买了一个东西在路上了,然后你现在看你家里
> 没有,你就花钱去买,你是蠢驴吗?]

两个问题都真实存在,且互相放大.

### 一,缺[上游 legacy id → 目录 key]这条映射

模型标识有**三套形式**:

| 形式 | 例子 | 谁在用 |
|---|---|---|
| 目录 key | `m-096e75164d` | 调度内部,上游回执(`session.model`/`rateLimitsByModel`/`prices`) |
| 上游 legacy id | `deepseek/deepseek-v4-flash` | **上游会话清单**(`desktopPurchases[].model`) |
| 可读名 | `DeepSeek V4.1 Flash` | 前端展示,`/v1/models` |

`CatalogHolder.keyForName()` 此前**只认可读名**(`keyByName`).而上游清单用的是
legacy id —— 于是 `holderFor('m-096e75164d')` 与清单里的
`'deepseek/deepseek-v4-flash'` **永远匹配不上**:

- 前端**能显示**那条已付费会话(它直接渲染清单)
- 调度**看不见它** → 以为没有可用会话 → 因余额闸门去别处买新的

`handleFor()` 早就用 FNV-1a 摘要(`legacyIndex`)解决了同一条映射,但只返回**句柄**,
没有返回 **key** —— 缺的只是一个出口.

### 二,调度不会复用[别的部署建的]已付费会话

即便清单能匹配上,调度也没走到复用:额度闸门(`freebucks_exhausted`)在
**复用判定之前**就把账号跳过了.而 `balance: 0` 只说明"**再买一条**买不起",
**不代表那条已付过钱的会话不能用**(一次 admit 买断一小时,这一小时内边际成本为 0).

实测代价:面板显示 `DeepSeek V4.1 Flash · 49 分钟`,调度却因余额跳过 → 用户看到
"有会话却一直 429",那一小时的钱白扔.

## Decision

### 一,`keyForName()` 支持三种形式(唯一真源)

在 `CatalogHolder.keyForName()` 内补一条 fallback:读 `keyByDigest`
(**与 `handleFor()` 同一张表,同一套摘要算法**,不另算一遍):

```
① 可读名 → keyByName
② 上游 legacy id → keyByDigest.get(freebuffLegacyModelDigest(id))   ← 本次补上
③ 已是目录 key → 自反
```

禁止在别处实现同一映射 —— `test/verify-model-mapping-truth.mjs` 会把第二真源扫出来.

同时把展示侧收拢:新增公开入口 `AccountRuntimes.displayNameFor(key)`(内部先
`resolveModelAlias` 归一再查名),`src/web/api.ts` 的 `modelDisplayName` 改为调它
(此前自己遍历 runtime 的 catalog,是第二套实现,既漏 legacy id 又无内置表兜底).

### 二,额度闸门之前,先问[上游有没有我能接管的已付费会话]

在 `_acquireForModelUnlocked` 里,**两道额度闸门(units / freebucks)任一即将拒绝**
时,才去 `holderFor(model)`(惰性 —— 热路径与额度充足路径零开销):

- 命中 → 跳过闸门,交给 `_admitUnlocked` 里既有的 takeover 逻辑复用;
- 本地上次快照没命中,且**已有过清单快照**时,补一次只读 `refresh()`.

 [已有过清单快照]是硬前置(`hasInventorySnapshot()`):`refresh()` 走
`GET /session`,而官方建会话路径上**这个 GET 会建出会话**.凭空调探测等于为一个
"还没决定要买"的请求造一条会话,会污染后续调度(实测把既有"5xx 换号"用例打红).

## Alternatives considered

- **把映射写在调用方(session-manager)里** —— 已实测踩坑:我起初自写了一版
  `_modelAliases()`,与仓库既有的 `resolveModelAlias` / `keyForName` 形成**第二真源**.
  用户当场指出"我们不是有映射机制吗".正确做法是复用既有真源并补它的缺口.
- **在 `_modelDisplayName` 之外再写一套展示映射** —— 同上,第二真源.
- **让调度无条件先探测上游清单(热路径)** —— 实测把既有测试打红:每个请求多一次
  `GET /session`,而该 GET 在 `get_claim_admit` 形态下会**建出会话**,凭空造出
  一条绑在别的模型上的会话 → 后续请求撞 `paid_window_model_mismatch`.
- **靠"禁止冷却"保护已付费会话** —— 试过,与 AGENTS.md 明写的纪律
  ("startAgentRun 失败 → 冷却换号")及既有换号用例**直接冲突**,两者不可能同时
  成立.已付费会话的价值由**[付费时段内绝不释放]**保护,不靠禁止冷却.
  那条与之矛盾的断言已删除,并在原处留注释说明为什么.
- **什么都不做** —— 现状是"面板能显示,调度用不上",比不显示更糟:用户以为有额度.

## Consequences

- **`keyForName()` 多一次 Map 查**(`keyByDigest`),无额外上游请求.
- **额度不足时会多发一次 `GET /session`**(仅当已有清单快照);换来的是
  "能复用已付费会话"而不是"白花钱重买".
- **`displayNameFor()` 成为展示侧唯一入口**;`web/api.js` 的本地实现已收拢.
- **`npm test` 新增一节** `verify-model-mapping-truth.mjs`(41 条断言).
-  **遗留债务**:`src/app-context.ts` 的 `_modelDisplayName`/`_modelCatalogId` 与
  `src/web/api.ts` 的 `catalogIdForKey` 仍直读 `keyByDigest`(既有邻接点).
  新测试对它们走"逐行授权 + 例外清单不命中即 FAIL"的防腐机制;
  收拢进 `resolveModelAlias`/`displayNameFor` 后应清空例外,升级为零例外.

## Evidence

**真实端到端(2026-10-04,账号 `loli@woa.qzz.io`)**:

```
请求1  → HTTP 200   balance 25→15   reusedSession=false   ← 新建（扣 10）
请求2  → HTTP 200   balance 仍 15   reusedSession=true    ← 复用，边际成本 0
[清空本地 sessions.json + 重启，模拟"别的部署建的会话"]
请求3  → HTTP 200   balance 仍 15
上游核对: daily spent=10（三次请求只扣一次）; purchases=1 条;
          holder 已接管为 9145fa5e; expiresAt 与最初完全一致(17:33:57.279)
```

**单变量实测(工具集,只有 1 个变量)**:同会话同模型同刻 —— 无工具 200 /
1 个官方工具 200 / 1 个非官方工具 200 / 1 个 Claude Code 名(`bash`) 200 /
**18 个第三方工具组合 503**.结论:**单个**非官方工具不触发 503,
"只发自定义工具会被当外来客户端"这条推断**未获实测支持**;
`detectForeignClient()` 的输出只是本地提示,不是上游判据.已写入
`docs/reverse/18-channel-guide-and-tool-mapping.md §4.1`.

**门禁**:`npm test` 全绿(含新增 41 条映射真源断言);typecheck;
`check:contract`;`check-config-consistency`;`check-i18n`(464 条 × 2 语种).

## Correction

本次先纠正了我自己两处错误:
1. 把"日志条数"当成"请求数",据此说"13 秒内几百次请求"(实际 13 个请求).
2. 自写 `_modelAliases()` 制造第二真源 —— 仓库本就有 `resolveModelAlias`.

## 追加修复:价格表查找的标识归一 + `return rt` 跳过 ensureSession

(2026-10-05 实测追查,两个都是真 bug)

### 一,`freebucks.prices` 的键是**上游 id**,而查的是**目录 key**

`freebucksFor(model)` 里 `fb.prices[model]` 直查 —— 而价格表的键是上游 id
(`deepseek/deepseek-v4-flash`),传进来的 `model` 通常是目录 key
(`m-096e75164d`)→ **查不到 → `price: null` → 走 `unmetered` 分支恒放行**
→ 两道额度闸门形同虚设(实测:测试里 `freebucksFor` 判 `known:false`,
用例失去意义).

修:用注入的 `resolveModelAlias` 把价格表键与入参都归一到目录 key 再比
(快路径先原样查,命中即返回).

### 二,`checkPaidUpstream()` 命中后 `return rt`,**跳过了 `ensureSession`**

`acquireForModel` 的契约是"**只选号,不建会话**" —— 真正建/接管会话发生在
它**更下方**的 `rt.sessions.ensureSession(model)`.早期版本在闸门处
`return rt` 直接返回 runtime,等于跳过 ensureSession →
**会话从未建立/接管 → 报 `no_session`**(实测测试红在 429).

修:只**跳过闸门**(`!paidTakeover && ...`),放行选号让它照常走到
`ensureSession` —— 那里会用 `holderFor()` 带 takeover 头接管,不新买.

### 三,`hasInventorySnapshot()` 前置过严(已移除)

早期怕"`GET /session` 会建会话"而要求"已有快照"才探测,实测这让
**从未对过账的账号**(新部署/刚导入)永远探不到 —— 而那恰恰是最需要探测的
场景.只读取形态(带 instanceId 的 `include-unused-rate-limits`)在真实上游
不建会话.
