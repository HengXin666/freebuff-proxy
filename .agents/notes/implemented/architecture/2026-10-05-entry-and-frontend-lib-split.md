# Agent Note: 入口与前端工具层的体量收敛 (bin/serve.ts + cli-bridge/upstream.ts + dashboard/lib)

Status: implemented

受影响代码: `bin/serve.ts`,`bin/serve/boot/**`(新建),`cli-bridge/upstream.ts`,
`cli-bridge/lib/upstream/**`(新建),`dashboard/lib/boot/**`(新建)

## Problem

三条硬标准(后端每文件 ≤300 行 / 同目录 ≤5 个受控文件)在三个入口侧文件上超限:

```
bin/serve.ts           445 行(其中 main 一个函数 177 行)
cli-bridge/upstream.ts 313 行
dashboard/lib/         6 个文件 > 5
```

`bin/serve.ts` 的 `main` 把五件事挤在一个函数里(参数解析 / 数据自检 / 管理员引导 /
上游预热 / 优雅关闭),读它的人必须同时装下五种失败模式;`cli-bridge/upstream.ts` 的
入口块是 125 行 `if / else-if` 链,与上面的 126 行 `Bridge` 签名逻辑混在一个文件里;
`dashboard/lib/` 里 `download.ts`(23 行)与 `hooks.ts`(56 行)是纯 IO/注册表,
没有反向依赖却占了目录名额.

## Decision

**按职责搬移 + 抽子函数, 不动任何对外契约.** 三个文件各自的迁法与理由:

### 一,`bin/serve.ts` -> `bin/serve/boot/`(5 个新模块)

`main` 保留为 51 行的编排(顺序本身就是它要表达的东西:参数 -> 端口等待 ->
users.json 准入 -> store 装配 -> 管理员引导 -> 监听 -> 上游预热 -> 信号注册).
四段实现搬进 `bin/serve/boot/`:

```
boot/data-audit.ts        56  数据文件巡检(启动横幅)
boot/bootstrap-admin.ts   77  管理员引导 / 密码来源判定
boot/upstream-warmup.ts  161  CLI 版本对齐 / 句柄扫尾 / 退款追问 / 就绪日志
boot/lifecycle.ts         93  优雅关闭 + 前端[重启服务]
boot/stores.ts           143  store 装配 + 两条启动准入判定
```

`startUpstreamWarmup`(99 行)额外按职责抽成四个子函数(版本对齐 / 扫尾 / 退款 /
就绪日志),因为它的四条动作互不相干,只是共享"一律不 await"这一条纪律.

`lifecycle.ts` 用 `getServer: () => server` **getter 注入**而不是传 server 值:
server 是 `await startServer(...)` 的返回值,建立晚于 shutdown 的定义 ---- 传值会让
"关闭时 server 还是 null" 变成一次静默的早退(表现为 SIGINT 后进程不退出).
这与 `src/proxy.ts` 拆分里"加显式 ctx 参数"的同一条思路:让依赖在**调用时刻**解析.

### 二,`cli-bridge/upstream.ts` -> `cli-bridge/lib/upstream/`(2 个新模块)

```
lib/upstream/bridge.ts   193  Bridge(凭据 / 设备签名 / 16 个端点转发)
lib/upstream/actions.ts  215  action 名 -> 端点方法的映射与编排
upstream.ts               29  入口(读入参 -> createBridge -> runAction -> 输出一行 JSON)
```

`bridge.ts` **刻意不 export class**:对外只给 `createBridge()` 与 `BridgeLike` 类型.
理由有二,都必须同时成立才选这条路:
1. 16 个端点方法是一字转发(`return chat(this, opts)`),各写一段 JSDoc 只会复述
   `lib/endpoints/**` 里已有的契约 ---- export 它们会被 `check-notes` 判成 16 条新债;
2. 不 export 就等于把"怎么签名, 怎么持有 cfg"锁在文件内, 改它不必看消费者.

迁移时顺手清掉 6 行**无人引用的 import**(`collectRepoSnapshot` /
`renderManagerSystem` / `dumpReq` / `loadOfficialAssets` / `MAP_TOOLS` / `crypto` 的部分导出):
代码已搬到 `lib/`,那些符号留在原文件里再无调用点. 这类"搬完没删的 import"
正是下一轮 review 最容易漏的东西.

原入口链里 `release` 分支**写了两遍**(第二处永远不可达,两分支体逐字相同),
迁成 `ACTIONS` 表时只留一条 ---- 行为等价,且这类死分支不该被"逐字搬移"的原则保留.

### 三,`dashboard/lib/` 6 -> 4

搬 `download.ts` 与 `hooks.ts` 进 `dashboard/lib/boot/`(跨模块装配与浏览器 IO,
与 `dom`/`ui`/`api`/`state` 那些视图原语不同层).

**刻意没搬 `dom.ts`(104 行)与 `ui.ts`(109 行)**:它们带着 `.gates/format-long-lines.json`
里登记的既有长行债(`dom.ts` 13 行 / `ui.ts` 1 行),而 `check-format` 与 `check-notes`
的棘轮 key 是**文件路径** ---- 移动一个带债文件会让它的债以新路径重报为"新增",
在不能改 `.gates/` 的前提下必然红. 搬两个零债文件同样满足目录上限, 且不制造假红.

## Alternatives considered

- **把 `bin/serve.ts` 的 `main` 只做搬移, 不抽子函数**:最强的理由是"搬移是最小风险,
  抽函数才是重构". 否决原因: `main` 是 177 行, 而**函数长度上限是 80 行**;
  只搬走 `startUpstreamWarmup` 等既有函数, `main` 仍有约 150 行, 文件过了函数不过,
  等于把红线从一个判据挪到另一个判据.
- **`cli-bridge/upstream.ts` export `Bridge` 类并给 16 个方法补 JSDoc**:
  最强的理由是"显式导出更符合模块惯例". 否决原因: 那 16 段 JSDoc 全是
  `@param {any} opts` 这类复述, 而真正的契约在 `lib/endpoints/**` ---- 写了也是
  第二份会漂移的真相; 不写则 16 条新债进 `check-notes`.
- **把 `Bridge` 改成不用类的工厂函数(闭包返回一批函数)**:最强的理由是
  "前端已用闭包包状态, 后端也可以". 否决原因: `lib/endpoints/**` 的每个函数
  第一个参数都是 `bridge` 实例, 且 `signHeaders` / `ensureKey` / `ensureKeyId` 读写
  `this.priv` / `this._registering` 三个实例级缓存 ---- 改成闭包要把这些缓存提升成
  模块级变量, 那是**跨实例共享**签名密钥状态, 属于真正的语义改动.
- **搬 `dom.ts` / `ui.ts` 进子目录以让 `dashboard/lib/` 更"整齐"**:
  否决原因见上(会以新路径重报既有长行债). 目录整洁不值一次假红.
- **什么都不做, 靠 `.gates/whitelist.txt` 挂豁免**:否决原因: 白名单**本仓刻意保持为空**
  (用户明确要求体量/目录红线全仓生效), 且"豁免一个文件"就是又签一张空白支票.

## Consequences

- `bin/serve.ts` 445 -> 118;`cli-bridge/upstream.ts` 313 -> 29;
  `dashboard/lib/` 6 -> 4 个文件. 全部 9 个受控目录 ≤5 个文件.
- **实测(不是只看门禁)**:在只含本改动的 pristine worktree(cf0b54d + 这三处改动,
  排除其它分区的半成品 `src/`)上起服务(CREATE: `FREEBUFF_PROXY_PORT=879x
  node bin/serve.ts`), 结果:
  - `/healthz` 200, `/` 200, `/app.ts` 200(`text/javascript`), 三个 css 均 200;
  - dashboard 下 **33 个 .ts 模块全部 200**, 且 `node --check` 逐个确认
    `stripTypeScriptTypes` 剥离后是**合法 JS**(33/33);
  - 33 个模块里 **146 条**相对 import 逐条 HTTP 探测, 只有 1 条 404, 人工核对
    确认它在**注释里**(`hooks.ts` 的引用反例), 不是真 import;
  - 用 DOM 桩把剥离后的 `locale/index.ts` + `app.ts` **在真实 JS 引擎里完整求值**,
    通过(即无 TDZ ---- 2026-10-04 那次白屏的形态).
- **cli-bridge 的行为等价性用离线用例钉死**:假 bridge + `bun` 跑 11 个 action,
  逐个断言输出形状与调用序列(含 `full` 的 admit -> startRun -> chat -> finishRun
  顺序). 真实入口另跑一次: 拿无效 token 打 catalog 仍是
  `{"action":"catalog","error":"catalog 401: ...","ok":false}` -- 与拆分前同形.
- **`bin/serve/boot/*` 的 `src/` import 深度是 `../../../src/`**(三层, 不是两层):
  首版写成两层, `checkJs` 立刻报 26 条 TS2307 且 `bin/serve.ts` 一跑就
  `ERR_MODULE_NOT_FOUND`. 归零后 `bin/` 与 `cli-bridge/` 的 checkJs 错误均为 **0**.
- 前端 checkJs 错误总数 57 -> 57(**零净增**); 后端 `bin/` 侧从把 177 行 `main`
  展开成 6 个文件后仍为 0 条新增(RATCHET: 总数棘轮在其它分区改 `src/` 时另有波动,
  与本改动无关).

## Testing

- `node scripts/gates/checks/code/syntax.ts` -> ok
- `node scripts/gates/checks/size/sizes.ts` / `size/dirs.ts` -> ok
- `node scripts/gates/checks/code/functions.ts` -> ok
- `node scripts/gates/checks/code/notes.ts` / `code/format.ts` / `style/style.ts` /
  `style/md-in-comment.ts` -> 本改动路径零违规(残留违规在 `src/upstream/device-signing.ts`
  与 `src/proxy/chat/run/*.ts`, 属并行分区)
- `node scripts/check-i18n.ts` -> ok(466 条 × 2 语种, 无硬编码中文)
- `node scripts/gates/checks/guard/declared.ts` -> TS2304 0 处
- 前端实机: 见上 Consequences 的 33 模块 / 146 import / TDZ 求值三条
