# Agent Note: 会话清单来自上游(跨部署可见)+ 槽位被占时显式接管

Status: implemented

## Problem

用户提出一个拓展方向(原话):

> 按理来说,我们不是应该能获取到,就是我们活跃的会话有哪些吗?这样子的话,
> 即便分布式的部署,或者说你在本地这里创建了一个会话,我在远程也能读取到你
> 创建的会话,这样就不会因为会话占用而怎么样子了.

这个想法**完全正确**,而且官方就是这么做的.三个实测问题指向同一处缺口:

### 一,跨部署看不见彼此的会话

上游一次 admit = 买断一小时,槽位 `slotLimit: 1`.**谁占着槽位只在上游那里**,
而本地账本(`data/sessions.json`)只记自己创建的会话 —— 分布式部署下彼此看不见.
实测(2026-10-04):我在本地建的会话占着槽位,远程拿同一账号请求就撞
`purchase_capacity`,而远程面板显示 `status: none`,两边各说各话.

### 二,上游其实把答案直接给了我们

`GET /api/v1/freebuff/session` 回执(**任何 status,包括 `none`**)实测含:

```json
"desktopSessionCounts": { "premium": 1, "unlimited": 0,
                          "nextExpiryAt": "2026-10-04T14:01:37.143Z" },
"desktopPurchases": [{ "model": "mimo/mimo-v2.5",
                       "expiresAt": "2026-10-04T13:31:37.143Z",
                       "holderInstanceId": "6c5b0c7e-5d8c-467b-8719-1094b77621b8" }],
"desktopRefunds": []
```

`holderInstanceId` 就是**占用者**(实测那个 `6c5b0c7e` 正是另一个容器建的会话).

### 三,我们没有解析这几个字段

上一轮逆向时就发现 `grep desktopRefunds src/` **只命中注释**——代码完全没有解析.
于是:

- `knownHolder(model)`(官方 `orchestrator.js:208639`)无从实现 ——
  **发请求之前**无法知道槽位被谁占着;
- takeover 只能靠"撞到 `purchase_capacity` 之后从错误回执里捡 id",慢一拍,
  且每次都要先付一次必然失败的请求.

## Decision

### 一,解析并保留会话清单

新增 `SessionManager._absorbInventory(body)`:
- `desktopPurchases`(过滤出带 `holderInstanceId` 的)→ `this.desktopPurchases`
- `desktopSessionCounts` → `this.desktopSessionCounts`
- `desktopRefunds` → `this.desktopRefunds`

 **`GET` 回执也要吸**(不只在 `_apply` 里吸).`status: none` 的回执**同样带**清单 ——
而"谁占着槽位"恰恰只在**没有自己会话**时才重要(有自己会话就直接复用了).
首版只在 `_apply`(仅 active 路径)里解析 → `holderFor()` 永远读不到,
"发请求前先接管"等于没接上(**测试抓到**).

### 二,`holderFor(model)` —— 发请求前就知道占用者

逐字对齐官方(`orchestrator.js:208639`):

```js
knownHolder: (model) => this.desktopPurchases
  .find(p => p.model === model && p.holderInstanceId
             && Date.parse(p.expiresAt) > Date.now())
  ?.holderInstanceId
```

这是**跨部署可见**的来源:真值在上游,本地/远程各建过会话时上游回执会把
**全部持有者**列出来.

### 三,首次 POST 就带 takeover

admission 的 POST 在发之前先 `holderFor(model)`:若占用者存在且**不是自己**,
直接带 `x-freebuff-takeover-instance-id`(官方 `orchestrator.js:208152-208155`).
省掉一次必然失败的 `purchase_capacity`.

保留"撞到 `purchase_capacity` 后兜底重试"那条路径(清单可能过期).

## Alternatives considered

- **只在本地账本里共享会话信息** —— 正是当前的问题:分布式部署下各记各的,
  没有任何一方能看到对方建的会话.真值必须来自上游.
- **启动时轮询一次会话清单** —— 违反零自动探测(启动不许发上游请求).
  清单在每次 `GET /session` 回执里顺带就有,零额外请求.
- **只在 `_apply` 里吸清单** —— 已实测证伪:`_apply` 只在拿到 active 时调用,
  而"没有自己会话,但槽位被占"的场景恰恰走不到它.
- **不带 takeover,只等 `purchase_capacity` 后重试** —— 能工作,但每次多一次
  必然失败的请求;且用户要的是"提前知道".两条路径都保留(互相兜底).
- **解析字段后直接自己 DELETE 占用者的会话** —— 危险:那是**别人的**会话
  (可能是另一个部署正在用的).官方用的是 takeover(把剩余时长**移交**),
  不是删除.

## Consequences

- **每次 `GET /session` 多解析 3 个字段**(纯本地对象操作).
- **本地/远程不再"互相看不见"**:`holderFor()` 读的是上游清单.
- **首次 POST 可能多一个头**;不带 takeover 的形态不变(保持官方默认).
- **`desktopPurchases` 会过期**:靠 `expiresAt > now` 过滤;过期项不参与占用判定.
- **面板已展示会话清单**(同次改动补齐):`getSnapshot()` 带出 `inventory`
  (`purchases` + `sessionCounts`)→ `app-context.list()` 的 `session.inventory`
  → 前端账号行渲染[上游占用中(N)]+ 每条的
  [本机 / 其它部署]+ 模型名 + 剩余时长.刷新即更新(走 `_apply`).
  用户据此一眼看出"占着槽位的是不是我自己,还能占多久".

## Evidence

- 上游回执实测(直连只读 GET):含 `desktopPurchases` / `desktopSessionCounts` /
  `desktopRefunds`;`holderInstanceId=6c5b0c7e-…` 指向另一个容器建的会话 ——
  **跨部署可见性成立**.
- 官方源码:`orchestrator.js:208639`(knownHolder),`208152-208155`(takeover 重试),
  `208818-208820`(absorb 清单),`112553`(`x-freebuff-takeover-instance-id` 常量).
- 新增测试(`test/smoke.mjs`):GET 回执带清单 → `holderFor` 读出占用者 →
  **首次** POST 就带正确 takeover → 拿到 active.
- 反向探针实证可证伪:删掉 `_absorbInventory` 调用 → 断言红
  (`holderFor 必须能从清单读出占用者（跨部署可见）`).
- 容器端到端(冷启动首个请求即发):**5 轮 HTTP 200**;
  日志 `freebuff session active` → `hold heartbeat sent` 链路完整.
- 门禁:typecheck 过;`npm test` 全绿;`check:contract`(新头已登记)/
  `check-config-consistency` 过.
