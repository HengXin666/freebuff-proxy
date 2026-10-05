# Agent Note: src/proxy.ts 从 2232 行拆到 933 行(薄门面 + 职责子目录)

Status: implemented

受影响代码: `src/proxy.ts`(保留原路径与原导出名),`src/proxy/**`(17 个新模块)

## Problem

`src/proxy.ts` 拆前 **2232 行**,其中 `createProxyHandler` 一个函数就 **2109 行** ----
它是个闭包,选号 / 会话 / 流式 / 错误映射 / 白名单 / 路由分发六套逻辑全在里面,
靠 `ctx` 解构出的四个变量与模块 import 捕获依赖.读它的人必须同时装下六件事.

用户硬标准:后端每文件 ≤300 行,函数 ≤80 行,同一目录 ≤5 文件.

## Decision

**薄门面 + 职责子目录**:`src/proxy.ts` 保留原路径与原导出名(只 re-export),
实现按职责搬进 `src/proxy/**`.

### 搬法:加显式 `ctx` 参数,而不是改成类

闭包函数搬到模块级时,最小改动是**函数签名加一个 `ctx` 参数**,函数体内对闭包变量的
引用改成 `ctx.xxx`.相比"把闭包改成类"(要动所有调用点)或"到处传 8 个参数"(签名爆炸),
这条最容易被逐行核对.

`createProxyHandler` 内保留一个 `ctxValue` 对象把这些依赖打包,避免每个调用点重复写字面量.

### 目录结构(每层 ≤5 文件)

```
src/proxy.ts                        933   薄门面 + handleChatCompletionsInner（重试状态机）
src/proxy/routes/catalog.ts         163   模型表 + 状态快照
src/proxy/routes/accounts.ts        217   账号导入/删除
src/proxy/routes/chat-request.ts    167   chat 前置解析与校验（原 141 行内联段）
src/proxy/routes/auth.ts             75   authorize + releaseSessionUnlessPaid
src/proxy/routes/router.ts          119   路由分发 + endAllSessions
src/proxy/config/limits.ts           64   5 个超时/预算常量（有单测）
src/proxy/transport/forward.ts      273   forwardCompletions 重试状态机
src/proxy/transport/forward-body.ts 203   buildForwardBody
src/proxy/transport/official.ts     140   official 通道 RPC 委派
src/proxy/transport/passthrough.ts   94   非 chat 的 /v1 透传
src/proxy/transport/errors/           3 文件  错误映射 + 上游回执归一化
src/proxy/transport/stream/           3 文件  槽位 + 流管道
```

`handleChatCompletionsInner`(722 行)**留在 `src/proxy.ts`**:它有 14 个可变局部状态
(`lastKey` / `attempt` / `sameAccountRetries` / `pendingGateCode` / `skipKeys` ...),
读写分散在重试循环各处.搬它需要先把状态封装成对象(约 140 处引用要改)----那是
真正的重构而非搬移,不在本次范围.

`router.js` 的 `handle` 通过**参数注入**拿 `handleChatCompletions`,而不是 import:
后者留在 `src/proxy.ts` 且依赖这个 `ctxValue`,反向 import 会成环.

## Alternatives considered

- **把 `createProxyHandler` 整体改成类(`ProxyHandler`),方法搬成原型方法**:
  最强的理由是"类天然有 `this` 承载状态,搬方法不用传 ctx,且 `handleChatCompletionsInner`
  那 14 个状态可以直觉地变成实例字段".否决原因:那会把 14 个**每请求独立**的状态
  提升成**跨请求共享**的字段.本服务是长驻进程,两个并发请求会互相覆盖对方的
  `lastKey` / `pendingGateCode` ---- 这是并发 bug 的温床,而且它在单请求测试里看不出来.
- **保持单文件,只把注释压缩,合并空行**:最强的理由是"零风险,不碰任何逻辑".
  否决原因:2232 → 1900 这种幅度对"读它的人要同时装下六套逻辑"毫无改善;
  而用户给的是**行数硬标准**,不是"读起来稍好一点".
- **按行号区间机械切块**:最强的理由是"最快,一次脚本搞定".否决原因:实测踩到 ----
  区间偏了几行就把相邻的 `buildForwardBody` 尾部一起删掉,而 `node --check` 通过
  (删完仍是合法 JS),坏在运行时,直到 `npm test` 报 `admit_failed` 才暴露.
  最终改用**函数名 + 大括号配对**定位(`scripts/gates/meta/drop-proxy-fn.ts`).
- **把 `handleChatCompletionsInner` 一起拆掉**:最强的理由是"它 722 行,是最后一根刺".
  否决原因:见上.凑合拆(按行切)会引入并发状态泄漏;正确拆(状态对象)是独立的重构题,
  混在"纯搬移"里做会让这次改动失去"行为零改动"这个可核对的属性.

## Consequences

- `src/proxy.ts` 2232 → 933 行;`createProxyHandler` 2109 → 869 行.
- **17 个模块的 `import()` 逐个验证可加载**;导出集合与 HEAD 逐名一致
  (`requestSlotStats` / `shouldSwitchAccountOnError` / `upstreamBodyEmbeddedError`).
- 搬移过程中由 `declared` 门禁抓到 4 轮"缺 import"(共 20+ 个符号,如 `hasClientTools` /
  `logger` / `apiKeyMatches`),以及 2 个真实运行期 bug(`_rpcResponse is not defined`,
  `sessionModel is not defined`).这两类 `node --check` 都抓不到 ---- 它们是门禁存在的理由.
- **纪律(三条,本仓已各踩过)**:
  1. 切函数块用**大括号配对**,不要用"第一个 `  }`"或行号区间;
  2. 往文件顶部插 import 要**从文件头连续吃掉所有 import**(含多行),
     不能 `lastIndexOf('\nimport ')` ---- 那会命中文件中部的多行 import;
  3. 搬完后跑三件套:`node --check` + `node scripts/gates/checks/guard/declared.ts` +
     **一次真实调用路径**(后两条分别抓"缺 import"与"`this.` 残留 / 漏解构").
