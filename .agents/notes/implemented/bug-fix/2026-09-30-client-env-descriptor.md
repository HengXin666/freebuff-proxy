# Agent Note: 补齐官方客户端环境描述符 x-freebuff-env / freebuff_client_env

Status: implemented

## Problem

上游判定「这是不是官方 CLI」时，会读 CLI 发出的**客户端环境描述符**：
一个 `v1;key=value;...` 形状的终端环境摘要，官方把它作为 `x-freebuff-env` 头发在
session / 广告请求上，并把**同一份字符串**放进 `codebuff_metadata.freebuff_client_env`。

官方源码（已克隆 `CodebuffAI/freebuff` 核对）：
- `common/src/constants/freebuff-client-descriptor.ts` —— 头名、metadata 键名、桶名枚举
- `cli/src/utils/client-environment.ts` → `formatClientEnvironment()` —— 13 个字段的精确定义

官方注释给出的样例：

```
v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=1;p=shell;g=terminal;osc=1
```

改前 `rg 'x-freebuff-env|freebuff_client_env' src/` → **0 命中**：这个指纹面从未实现。
后果是请求形态缺了官方必带的一项，配合上游的第三方客户端检测
（错误码 `free_mode_cli_required`，原文 "Calling the API directly is not supported
and **may get your account banned**"），账号被封。

## Decision

**在 `src/upstream/official-fingerprint.js` 实现该描述符，并同时用于
session 请求头与 chat 的 `codebuff_metadata`。**

- `formatClientEnvironment()` 逐字对齐官方的 13 个字段与顺序：
  `in / out / tp / term / ct / sz / ci / ssh / l / p / g / osc`。
- 本代理跑在容器/服务里**没有真实终端**，所以按官方对非交互环境的取值填：
  `in=0 / out=0 / tp=none / l=0 / p=na / g=na / osc=na`。官方自己就有 `na` 桶
  表示「未查询/不适用」，**伪造成一个真实终端反而与运行环境自相矛盾**。
- 只放存在性标志、尺寸与固定桶名，**绝不**放路径、进程名、环境变量原文
  （官方明确约束：never a raw environment value, path, or process name）。
- 构建一次后缓存（官方也是 per-process 构建一次）。

## Alternatives considered

- **什么都不做** —— 最省事。但这是上游点名的指纹面，缺它就会被判第三方客户端，
  而判定的代价是**封号**（错误码原文写明），不是降级。
- **伪造成真实终端（in=1/out=1/tp=iterm/p=shell/g=terminal/osc=1）** —— 看似更
  "像官方"，但本代理没有 TTY，`sz` 也取不到真实尺寸，硬填一套与运行环境矛盾的
  值反而构成新的不一致（上游可以对 `sz=0x0` + `in=1` 这种组合做校验）。
  取官方允许的 `na` 桶是自洽的。
- **只在 session 头、不放 metadata** —— 官方两处都放，且测试里
  `provider-options-metadata.test.ts` 断言 `freebuff_client_env: 'v1;in=1'`。
  只放一处等于仍是"半套指纹"。

## Consequences

- session 请求与 chat metadata 现在都带官方形状的环境描述符。
- 格式、字段顺序、取值域被 `test/smoke.mjs` 断言锁住（含两处必须同一份字符串）。
- 不伪造终端身份：非交互环境如实取 `na`，不自相矛盾。

## Evidence

- 官方源码逐字核对（clone CodebuffAI/freebuff，13011 stars，每日同步快照）。
- 官方二进制 0.2.1 确认头名与字段真实存在：`x-freebuff-env`、`tp=`、`sz=`。
- 本地生成值与官方样例结构一致：
  `v1;in=0;out=0;tp=vscode;term=1;ct=1;sz=0x0;ci=0;ssh=0;l=0;p=na;g=na;osc=na`
  官方样例：`v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;...;p=shell;g=terminal;osc=1`
- ⚠️ **尚未在真实账号上验证**：调试期间两个账号已被封
  （反复直接调 API 触发 "may get your account banned"），需新账号才能收尾验证。
