# Agent Note: config.yaml 只留 host/port，其余全部改为控制台可调

Status: implemented

受影响代码: `src/config/tunable/{specs,store}.ts`（新增）、
`src/web/store/config/{settings-store,settings-fields,tunables-store}.ts`、
`src/web/routes/control/settings.ts`、`bin/serve/boot/stores.ts`、
`dashboard/views/proxy/{index,tunables}.ts`、`config.yaml`、`config.example.yaml`、
`scripts/gates/checks/guard/tunables.ts`（新增门禁）

## Problem

用户裁决：`config.yaml` 只留 `server.host` / `server.port`，**其余全部**在前端
设置页面可调。

现状与此差得很远，而且是**两种不同形态的"不可调"**：

1. **完全不可调**：`session.*`（7 项）、`limits.*`（12 项）、`logging.*`（2 项）、
   `web.*`、`users.*` 只能改 `config.yaml` 再重启。管理员值超时、流式 idle
   阈值、请求抖动这些高频调参项，每次都要落到"改文件 + 重启"。
2. **已可调但走实时通道**：`accountMaxConcurrency` / `accountSchedulingMode` /
   `idleReleaseSec` / `maxNewSessionsPerRequest` 四项经 `settings.json` 的
   getter 实时生效（`bin/serve.ts` 的 `getAccountConcurrency` / `getSessionSettings`）。

第 2 类是好事（比"保存后重启"体验更好），但它埋了一个陷阱：如果为了"统一入口"
把这四项也搬进新的可调项机制，同一个值就会**同时**存在于实时键（`idleReleaseSec`）
与可调项路径（`session.idleReleaseSec`）两个入口，而谁能赢取决于读取顺序 ——
这是配置系统最典型的一类 bug，且症状随调用顺序漂移。

## Decision

**一张可调项声明表 + 启动时合并进 config，保存后重启生效。**

### 一、声明表是真源，三处只从它取

`src/config/tunable/specs.ts` 的 `TUNABLES` 声明每项的类型/范围/分组/标签。
后端校验、前端控件生成、门禁覆盖校验**都从这一张表取**。理由与本仓既有的
`scripts/gates/rules.mjs` 同源：同一组数字写进两处，改一处忘一处就会变成
"页面允许 9999 而校验只收 16"，而两边都看起来是对的。

### 二、生效方式 = 启动合并，而不是逐项 getter

保存后重启（用户裁决）这个选择让实现变得很干净：`bin/serve/boot/stores.ts`
在拿到 `settingsStore` 之后调一次 `applySavedSettings(config, savedTunables())`，
把值写进 config。于是全仓 `config.limits.xxx` / `config.session.xxx` 的
**读取点一行都不用改**，也不必为二十多个项各写一个 getter（那是二十多个
可能忘改的地方）。

代价明确且已在前端显式化：卡片上写"改动需重启后生效"，保存后 `restartRequired`
为真时提示"重启服务后生效"。提示不是客套，是这个通道契约的一部分。

### 三、四项实时项**不进**可调项表

`accountMaxConcurrency` / `accountSchedulingMode` / `idleReleaseSec` /
`maxNewSessionsPerRequest` 登记在 `NOT_TUNABLE` 并写明理由：它们已有实时通道，
再进可调项表就变成同值两入口。`upstream.proxy` / `upstream.proxies` 同理
（已有[代理设置]页与 `/data/proxies.json`，两个输入框会互相覆盖）。

### 四、门禁双向校验覆盖

`scripts/gates/checks/guard/tunables.ts` 判三条：DEFAULTS 里有而两张表都没有
（漏登记）、两张表里有而 DEFAULTS 没有（陈旧条目）、同一路径同时登记为可调与
不可调（自相矛盾）。**双向**是刻意的：只查漏项会漏掉"项被删了清单还留着"，
清单越长越像一片没人敢删的沼泽。

## Alternatives considered

- **给每项写一个运行时 getter，全部立即生效**。最强理由：体验最统一，用户不用
  重启 ---- 而且本仓已有四个 getter 的先例，路是通的。否决原因：二十多个项各写
  getter，就意味着二十多个"读取点是否真的走了 getter"的验证面；而超时/轮询类
  项（`upstreamTimeoutSec` / `pollIntervalSec`）要真正立即生效，还得处理"已经
  起在路上的定时器/进行中的请求用哪个值"这类语义 ---- 那是另一个量级的工作量，
  且用户已明确选了"保存后重启"。

- **不做声明表，后端按白名单硬编码、前端自己列控件**。最强理由：改动面最小，
  不用设计 schema。否决原因：前端那份清单和后端那份一定会漂移，且漂移的表现是
  "页面上有这个控件，保存却 400"（或更糟：页面没有、于是没人知道它能调）。

- **把 `config.yaml` 保留为完整清单，页面只作快捷入口**。最强理由：不破坏既有
  用户的配置文件，升级零摩擦。否决原因：那会让同一个值有两个入口，而谁能赢取决
  于加载顺序 ---- 用户裁决的正是"只留 host/port"，即只保留**启动前必须知道**的
  那两项。

- **让前端直接改 `config.yaml`**（复用它，不新建 settings.json 通道)。最强理由：
  不用引入第二种持久化格式。否决原因：`config.yaml` 是运维手写的文件，程序改写它
  会吃掉用户的注释与排版；而 settings.json 是本仓既有的控制台持久化约定
  （proxies.json / custom-models.json 同源）。

## 影响

- 新增 24 项可调项 + 8 项明确不可调（含 4 项实时项与 2 项代理项），合计覆盖
  `DEFAULTS` 的全部 35 个叶子路径 ---- 门禁双向校验，零遗漏。
- `src/web/store/config/settings-store.ts` 的 `save()` 由 100 行 if 链改为
  声明表驱动（`settings-fields.ts`）。顺带修掉一个既有隐患：原实现对**未知字段名
  静默忽略**，现在会拒绝（拼错字段名却"保存成功"是最难查的一类）。
- 端到端实测：POST 保存 `limits.slotWaitMs=3000` / `session.pollIntervalSec=7`
  → 落盘 settings.json → 重启 → 启动日志 `已应用控制台保存的可调项 count=2`，
  且 `loadConfig + applySavedSettings` 读回的值确为 3000 / 7。
- 可证伪：7 条纯函数断言（无保存不覆盖 / 合并生效 / 非法值回落并上报 / 未知键
  忽略 / 多类型 / 枚举非法拒绝 / 快照不含 host）。
