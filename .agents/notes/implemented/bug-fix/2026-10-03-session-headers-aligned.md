# Agent Note: session 头集按客户端抓包修正（env / compact 是我方多发的）

Status: implemented

## Problem

`docs/reverse/21` 落成后，用它做对照时发现 session 与 device-keys 那两跳
我方与客户端对不上。用本地镜像抓**实际发出的**（不是读代码）后逐项 diff：

| 项 | 我方（改前） | 客户端（165 条真值） |
|---|---|---|
| `x-freebuff-env` | 发（长串环境描述符） | **0 次** |
| `x-freebuff-compact-session` | 发 | **0 次** |
| `x-freebuff-client` | **缺** | `desktop` |
| `x-freebuff-install-id` | **缺** | 有（登录态值） |
| `x-freebuff-include-unused-rate-limits` | 仅 `if (opts.instanceId)` 时发 | 查询形态**恒带** |
| `User-Agent` | `Bun/1.3.14`（session）/ `node`（device-keys） | `Bun/1.4.2` |

两个多发的头来源：
- `x-freebuff-env` 来自官方 **CLI** 源码（`cli/src/utils/client-environment.ts`），
  desktop 客户端不发 —— 我们走 desktop 路线，带它等于自报 CLI 身份。
- `x-freebuff-compact-session` 同源于 CLI 分支判断。

## Decision

按客户端真值逐项修正 `officialSessionHeaders()`：

1. 删 `x-freebuff-env`、停发 `x-freebuff-compact-session`。
2. 补 `x-freebuff-client: desktop`、`x-freebuff-install-id`（读取
   `~/.config/freebuff-desktop/state.json` 的 `installId`，只读 best-effort）。
3. `x-freebuff-include-unused-rate-limits: 1` 改为 **GET 恒带**（与有无活跃
   会话无关 —— 以前塞在 `if (opts.instanceId)` 里，导致首次查询反而不带，
   与客户端恰好相反）。
4. `BUN_USER_AGENT` 从 `Bun/1.3.14` 改为 `Bun/1.4.2`（客户端实测值）；
   device-keys 也补上 UA 与 `Accept-Encoding: gzip, deflate, br, zstd`。

## Consequences

- session / device-keys 的**业务头集**与客户端一致。
- 仍走 Node 发出，因此保留 3 项运行时差异（见下）。
- `installId` 读客户端登录态是只读的；读不到就跳过该头（不影响可用性）。

## Alternatives considered

- **把 session / device-keys 也搬到 bun**：能彻底消除剩余 3 项，但
  session 带签名、device-keys 有注册副作用（keyId 落盘），改动面和回归
  风险都比 catalog 大。本轮先把"我方多发的 / 缺的"修完，bun 化另做。
- **保留 `x-freebuff-env`**：它是 CLI 特征，与 desktop 路线冲突，必须删。
- **只改 UA 不动其余**：其余差异里 `x-freebuff-client` 缺失是明确的
  客户端标识缺失，比 UA 更显眼，不能只改一半。

## Verification

1. 本地镜像抓改前报文 → 确认多 `x-freebuff-env` / `compact-session`、
   缺 `client` / `install-id`、UA 错。
2. 改后复抓 → 前两项消失、`client` / `install-id` 出现、UA 为 `Bun/1.4.2`。
3. **决定性对照实验**（同一镜像、同一组头）：
   ```
   Node 26   → accept-language: * / sec-fetch-mode: cors / UA=node
   Bun 1.4.2 → 无这两个头 / UA=Bun/1.4.2
   ```
   证明剩余 3 项是运行时差异，`sec-fetch-mode` 在 Node 下**无法覆盖**
   （forbidden header，设空串仍为 `cors`）。
4. 真实上游回归：点「一键刷新」→ `ok: true`、`catalogRows: 13`，
   admission / chat 计数均为 0。

## 剩余（明确标注，不掩饰）

`accept-language: *`、`sec-fetch-mode: cors`、`accept-encoding` 缺 `br, zstd`
—— 这 3 项在 Node 下无解，需 session / device-keys 也走 bun 通道才能消除。
已在 `docs/reverse/21` §21.5 标注为"部分对齐"。
