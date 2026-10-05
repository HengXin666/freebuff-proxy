# Agent Note: src/ 顶层 5 个超限文件按职责拆进子目录(状态对象化, 不改并发语义)

Status: implemented

受影响代码: `src/proxy.ts`,`src/app-context.ts`,`src/session-handles.ts`,`src/free-mode.ts`,
`src/account-state-store.ts`,`src/model/list-response.ts`;
新增 `src/proxy/chat/**`(8 文件), `src/context/{select,acquire}/**`(3 文件),
`src/session/handles/**`(4 文件), `src/free-mode/**`(3 文件), `src/account-state/**`(1 文件),
`src/model/response/**`(4 文件)

## Problem

`.gates/sizes-baseline.json` 里本子树有 6 个超限文件(proxy 933 / app-context 706 /
session-handles 491 / free-mode 340 / account-state-store 316 / model/list-response 310),
`src/` 直接挂 12 个受控文件而硬标准是 ≤5(`.gates/dirs-baseline.json` 记着 `"src": 12`).

真正的难点不是行数, 是**两个结构性约束**:

1. `src/proxy.ts` 的 `handleChatCompletionsInner` 是一个 722 行的**闭包**, 14 个可变局部状态
   (`lastKey` / `attempt` / `sameAccountRetries` / `pendingGateCode` / `skipKeys` / `heldRt` /
   `releaseReserved` / `agentOverride` ...)分散在重试循环各处. 上一轮拆分
   (见 `2026-10-05-proxy-js-split-by-responsibility.md`)**故意把它留下**, 理由就写在
   note 的 Alternatives 里: 拆它必须先决定"状态放在哪", 而错误的选择(类实例字段)
   会把每请求独立的状态变成跨请求共享.
2. `src/` 顶层 12 个文件**全部**被冻结分区(test/ bin/ src/web/)按路径直接 import;
   `test/` 还对 `src/proxy.ts` / `src/app-context.ts` / `src/session-handles.ts` /
   `src/server.ts` 做**源码文本断言**(读文件正则匹配). 因此顶层路径是契约面.

## Decision

**门面保留路径 + 按职责拆子目录; 状态放进"每请求一份"的对象, 不放进类.**

### 一:`src/proxy.ts`: 闭包状态 -> 请求级状态对象(不是类)

`createProxyHandler` 保持闭包(它无状态, 只是装配), `handleChatCompletionsInner`
按四段拆进 `src/proxy/chat/**`:

| 文件 | 行 | 职责 |
|---|---|---|
| `state/state.ts` | 126 | 请求级槽位 + 状态的**构造与装配**(预算归一 / `dropChatHold` / `chatWaitMs`) |
| `state/fields.ts` | 139 | 字段表(纯数据): 只读字段 + 重试游标 |
| `acquire/acquire.ts` | 91 | 选号 + 接管 runtime(交还预留 / 重置同号计数 / 清 agentOverride) |
| `acquire/chat-lock.ts` | 142 | 账号锁有界等待 + 满员/被顶替两道处置 |
| `run/turn.ts` | 120 | 一次上游调用(会话快照校验 -> 转发 -> FINISH 上报) |
| `run/agent-run.ts` | 127 | startAgentRun 与 agent 回退判据 |
| `run/loop.ts` | 219 | 主循环 + 结果回收 |
| `run/errors.ts` | 229 | 失败的归类与去向(5 条终态判据 + 2 条重试分支) |

关键点: `createChatState(ctx, req, parsed)` 在 `handleChatCompletionsInner` 里
**每次请求调用一次**, 产出一个随请求生灭的对象; 14 个字段全部挂在它上面.
`proxy.ts` 里只有一处调用点, 且该处在请求作用域内.

### 二:其余 5 个文件

- `app-context.ts` 706 -> 208: 选号排序(`context/select/candidates.ts`),
  选号与重试入口(`context/acquire/acquire.ts`)按本仓既有"模块级函数 + self 首参 +
  `context/methods.ts` 装配回原型"模式搬出; 三个落盘路径函数移到
  `context/ops/paths.ts` 并从 app-context import(同一份路径判据只有一处).
- `session-handles.ts` 491 -> 161: 装载 / 本地账本操作 / 两段扫尾 拆进 `session/handles/**`.
- `free-mode.ts` 340 -> 35: system 门禁 / 工具签名判据 / 请求体归一 拆进 `free-mode/**`.
- `account-state-store.ts` 316 -> 263: 读盘归一与退款记录拆进 `account-state/records.ts`.
- `model/list-response.ts` 310 -> 22: 对外行 / 清单合并 / 白名单判据 拆进 `model/response/**`.

### 三:不改的

顶层 12 个文件**一个都不搬走**: 它们全是冻结分区按路径 import 的契约面,
其中 `src/proxy.ts` / `src/app-context.ts` / `src/session-handles.ts` 还被 test
读源码文本断言(断言点名这三个路径). 搬走它们会在别人分区里制造红.(见 Consequences 第 3 条)

## Alternatives considered

- **什么都不做 / 保持现状**: 最强的理由是"棘轮已经拦住了继续增长, 存量可以慢慢还".
  否决原因: `src/` 顶层 12 个文件卡在硬标准 5 的红线上, 后续任何人在 `src/` 顶层
  新增一个文件都会直接被门禁拦下 ---- 这是所有并行工作流的公共阻塞点; 而且
  `handleChatCompletionsInner` 722 行是"改一处坏一片"的结构性根源.
- **把 `createProxyHandler` / 状态改成类(实例字段承载 14 个状态)**:
  最强的理由是"类天然有 `this`, 搬方法不用传 st, 那 14 个状态可以直觉地变成实例字段".
  否决原因: 长驻进程里两个并发请求会互相覆盖对方的 `lastKey` / `pendingGateCode` /
  `heldRt`, 表现为"A 的失败被记到 B 的账号上""B 释放了 A 的锁". 这种 bug 单请求测试
  完全看不出来. 实测验证方式: 把 `createChatState` 改成模块级单例后, 我的
  "两份 st 必须是不同对象 / B 的字段不受 A 影响" 断言立刻变红(可证伪探针跑过).
- **顶层文件改薄门面(像 config.ts / auth-store.ts 那样只 re-export)**:
  最强的理由是"上一轮 `src/proxy.ts` 就是这么做的, 形状一致". 否决原因: 那 12 个文件
  是冻结分区按**路径** import 的入口(`src/config.ts` 有 22 处引用, `src/model.ts` 19 处,
  `src/auth-store.ts` 20 处, 其中 `src/web/**` 与 `src/upstream/**` 都不在我的写范围内);
  把它们变成纯 re-export 不会减少任何一行真实代码, 只是把行数搬到 `src/<domain>/`,
  却给别人的分区制造 60+ 处 diff 风险. 行数红线要的是"可读", 不是"数字好看".
- **按行号区间机械切块**: 最强的理由是"最快". 否决原因: 上一轮 note 已记着这条
  踩过的坑(区间偏几行就把相邻函数尾部一起删掉, 而 `node --check` 通过). 本次改用
  **函数边界 + 归一化逐行比对**核对(见 Consequences 的自证).
- **把 14 个状态拆成"每组重试用一组新变量"以缩短函数**: 否决原因: 那是改写状态机
  语义, 不是搬移; 且会让同号重试计数等跨轮状态的可见性变模糊.

## Consequences

- `src/` 顶层受控文件仍为 **12** 个(契约面, 见 Decision 第三条), 但
  **每个文件都 ≤300 行**: 最大的 `account-state-store.ts` 263 行.
  本子树 84 个受控 `.ts` 文件中, 无一个超过 300 行.
- 自证(命令与实测数字):
  - `node scripts/gates/checks/code/syntax.ts` -> `ok`(tsc 解析 298 个);
  - `node scripts/gates/checks/guard/declared.ts` -> TS2304 **0 处**(`upstream/**` 正在
    并行改时一度报出 `signPayload` / `device-signing.ts`, 那是分区 A 的在途改动,
    与我无关);
  - `sizes.ts` / `dirs.ts` / `functions.ts` / `notes.ts` / `md-in-comment.ts` 对本子树全绿;
  - `node -e "import('./src/proxy.ts')"` 导出面 **逐名一致**:
    `createProxyHandler, requestSlotStats, shouldSwitchAccountOnError, upstreamBodyEmbeddedError`;
    另外 12 个顶层文件的导出名也逐个对比过, 无新增无缺失.
- **搬移核对方式(这次不靠 `node --check`)**: 写了一个归一化比对器, 把
  `this.` / `self.` / `st.` 前缀与 `ctxValue -> ctx` / `heldRt -> rt` 这类机械改写
  归一之后, 拿旧文件在新文件集合里逐行找. 结果: 6 个文件的**函数体语句 100% 命中**
  (proxy 239 条 / app-context 174 / session-handles 177 / free-mode 72 /
  list-response 70 / account-state-store 107), 0 条漂移. 剩下的差异只有两类:
  声明形态(`let lastKey = null` -> `lastKey: null`)与函数签名改形.
- **并发语义靠三条可证伪验证钉住(不是靠"看起来对")**:
  1. 每请求独立: 两份 `createChatState` 的 `lastKey` / `pendingGateCode` / `attempt` /
     `agentOverride` / `skipKeys` / `chatGone` / 派生方法全部互不影响;
  2. 失败判据表: 10 条 `UpstreamError` 逐个过 `handleTurnError`, 终态 7 条必须收场,
     可重试 3 条必须不收场, 且"重试用尽"必须走**一次**统一释放入口(原因码
     `final upstream error`),`client_gone` 必须不写响应;
  3. 账号级串行化: 真实 `AccountRuntimes` 下 8 个并发抢同一账号的 chat 锁, 在途峰值
     不超过并发上限(3), 恰有 3 个拿到锁, 其余拿到 `account_busy`(而不是无限等待),
     释放后在途归零. 共 31 条断言.
  可证伪探针(用完即还原, 都实测过): 把 `createChatState` 改成模块级单例 ->
  第 1 组变红; 去掉 `client_gone` 终态判据 -> 第 2 组变红.
- **本子树之外仍有红, 全部归属并行分区**(不是本次改动引入):
  `src/upstream/**` 的 `functions`(buildRpcCfg 94 行) / `notes`(device-signing 5 个符号) /
  `format`(2 个文件超长行) / `response-contract`(`errors/codes.ts` 新增裸读),
  `dashboard/**` 的 `format`+`types`,`cli-bridge/upstream.ts` 的 `md-in-comment`,
  以及 `.agents/notes/**` 里另一篇 note 的标点. 判断依据是可执行命令的输出
  (逐条 FAIL 都打印了文件路径), 不是推测.
- `src/context/sched/account-settle.ts` 里 `logger.warn('account ensureSession failed')`
  会把上游抛错压成 `Cannot read properties of undefined (reading 'get')`(真堆栈被吞).
  这是本次排查中"白查一轮"的原因 ---- 本该由 `UpstreamError` 归一的地方用了
  `new UpstreamError(message)`. 这条不在本次写范围内(它属于 `src/context/sched/`,
  写范围允许但改动会与分区 A 的 `upstream/**` 修复混在一次提交里), 留作待办:
  下一步应让该处保留原始 `code`/`status`.
