# Agent Note: 上游契约单一真源 + 对账门禁（架构级防漂移）

Status: implemented

## Problem

用户要求从**架构层面**解决：上游改 API 时能快速填充、其他接口保持契约、
不牵一发而动全身。

取证发现的真实形状（不是猜的）：

1. **`cli-bridge/upstream.mjs` 不复用 `official-fingerprint.js` 的常量** ——
   18 个头名全是硬编码字符串。而它才是**官方形态的唯一实现**。
   于是出现过：主服务补了 `x-freebuff-client`、cli-bridge 里没有；
   反过来 cli-bridge 有 `x-freebuff-install-id`、主服务缺失。
   这就是"改一处、另一处静默过期"。
2. **抓包真值与代码常量没有机器可校验的链接** —— 上游改了什么，只能靠
   人读 `docs/reverse/21` 再改代码，改漏了没人知道。
3. 废弃头（`x-codebuff-api-key` / `x-freebuff-env` /
   `x-freebuff-compact-session`）的常量与发送函数仍留在代码里 ——
   随时可能被人"顺手加回来"。

## Decision

建立**单一真源 + 机器对账**三层：

1. `src/upstream/upstream-contract.js` —— 端点与头名的**唯一定义处**。
   主服务与 cli-bridge 都必须从这里取，不得各写字符串。
2. `docs/reverse/upstream-contract.json` —— 由
   `scripts/gen-upstream-contract.mjs` 从抓包 JSONL **生成**的契约快照
   （7 个必需端点 + 19 个业务头 + 首次出现顺序）。真值来自客户端流量，
   不是手抄。
3. `scripts/check-upstream-contract.mjs` —— 四条确定性判据：
   - 契约里每个**必需端点**必须在真源有常量 → 上游加端点会红
   - 契约里每个**业务头**必须在真源有常量 → 上游改头名会红
   - 源码不得出现**未登记**的 `x-freebuff-*` 字面量 → 绕过真源会红
   - `RETIRED_HEADERS` 里的头不得出现 → 废弃头回潮会红

接线：`npm run check:contract`、CI `contract` job（进 `build-push` 的
needs）、pre-commit。

## Consequences

- 上游变更的处置路径固定为：重抓包 → `npm run gen:contract` → 改真源
  **一处** → 门禁转绿。
- 删掉三个废弃头的常量与发送函数（`officialApiKeyHeaders()` 连同定义
  一起删，不留回潮入口）。
- 测试里要求"必须带 `x-codebuff-api-key` / `x-freebuff-env`"的断言，
  按客户端 0 次真值改为断言**不得带**。
- 判据 3 排除 `x-freebuff-proxy-*`（那是本代理给下游的响应头，
  不是上游契约）；判据 4 剥离块注释（注释在解释为什么废弃，不当违规）。

## Alternatives considered

- **只写文档说明"头名请统一"**：文字级规范，本项目已多次证明会被绕过
  （这次就是两端各写一份）。不采用。
- **给 cli-bridge 复制一份常量文件**：仍然是两份真源，漂移风险不变。
  不采用 —— 必须单一。
- **用 ESLint 规则限制字符串**：本项目没有 ESLint，为一个约束引入
  工具链不划算；且自定义扫描脚本更贴合"与抓包快照对账"这个专属需求。
- **不做契约快照，只在代码里集中常量**：能解决"两处写"，但解决不了
  "上游改了我们不知道" —— 快照是与真值对账的那一端，必须有。

## Verification

- **正向**：当前代码 → 退出码 0，报"7 端点 / 19 头全部登记，扫描 41 文件
  无裸字面量、无废弃头回潮"。
- **反向 · 废弃头回潮**：注入 `{"x-codebuff-api-key": 1}` → 退出码 1，
  报出准确文件；还原 → 回 0。
- **反向 · 上游改头名**：把契约快照里 `x-freebuff-client` 改成
  `x-freebuff-client-v2` → 退出码 1，报
  "契约头未登记到真源: x-freebuff-client-v2"；还原 → 回 0。
- typecheck 通过；`npm run test:catalog` 通过。

## 剩余（明确标注）

`npm run test:smoke` 仍有一条未通过：
`单账号并发上限 3 → 上游并发峰值应为 3, got 2`。
已确认配置生效（`capConfig.limits.accountMaxConcurrency = 3`，
`_getAccountConcurrency` 默认正是读它），但采样峰值得 2 ——
无法判定是采样漏帧还是 ChatMutex 容量更新时序，**未擅自改断言**，
待裁决。
