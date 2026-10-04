# Agent Note: 缺 bun 的部署必然烧钱；已买断的一小时绝不允许被释放

Status: implemented

## Problem

用户远程部署上「花了钱、请求失败、积分归零、账号进冷却」，反复复现。本地同样
的账号同样的请求却成功。远程日志给出完整链条（2026-10-04 09:34:06）：

```
admit        200 active  instanceId=b6924285  expiresAt=10:34:06   ← 扣 10 FB，买断一小时
agent-runs   200         runId=01a10643
chat         428 {"error":"waiting_room_required",
              "message":"Your free session has ended. Send your message again to start a new one."}
session error; will re-acquire   code=waiting_room_required
skip re-admit: freebucks cannot afford model      ← 钱已扣光，重试买不起
account cooling down  code=freebucks_exhausted    ← 用户看到的"冷却"
releasing session to free the slot → DELETE       ← 把已付费的一小时扔了
warn official channel rpc failed, falling back to legacy   error="spawn bun ENOENT"
```

三处独立缺陷叠加：

1. **远程镜像里没有 bun**（`spawn bun ENOENT`）→ 每次 chat 都回退 legacy 形态
   → 必然被上游拒。即：**没有 bun 的部署 = 每次 chat 都在白烧一小时额度。**
2. **428 被当成"要重新购买"**：`waiting_room_required` 在
   `isSessionRecoverableGate` 里 → 走 `forceReadmit()`
   = `_releaseUnlocked()` + `_admitUnlocked()`，**先扔掉已买的一小时再买**。
   而上游原话是 "Send your message again" —— 它要的是**重发**，不是重买。
3. **7 处无条件早退释放**：重试/换号/最终失败路径上散落
   `runtimes.releaseSession(key)`。而 Freebucks 是买断制，早退**不退钱**
   （实测只回 `freebucksRefundPending`，观察 2 分钟未到账）。

用户原话概括第 2、3 点：「花了钱买了东西，上游说重发一遍，你却把钱交了又买一遍」。

## Decision

### 一、bun 进镜像（治本）

- 基镜像 `node:22-alpine` → **`node:22-slim`**。
  **必须换**：bun 官方二进制是 glibc 动态链接（`NEEDED libc.so.6`、
  `interpreter /lib64/ld-linux-x86-64.so.2`），alpine 是 musl —— 直接 COPY
  进去报 `Error relocating: __pthread_key_create: symbol not found`
  （实测；装 `apk add gcompat` 也一样缺符号）。`node:22-slim` 实测
  `bun --version` → `1.4.2` 正常。
- 构建时从 GitHub Release 下载 **锁定的 bun 1.4.2**（`ARG BUN_VERSION`），
  装到 `/opt/bun/bun`，并设 `FREEBUFF_BUN_BIN=/opt/bun/bun`
  （bridge.mjs 的 resolveBun 优先级：env > ./bun > PATH）。
- `su-exec`（alpine 专有，Debian 报 `Unable to locate package`）→
  Debian 自带的 **`setpriv`**（entrypoint 两处调用点同步改）。

### 二、428 改走「续用」，不走「重买」

新增 `SessionManager.readmitToContinue(model)`：复用**同一 instanceId** 重新
admission（`officialSessionHeaders()` 在有 instanceId 时自带
`x-freebuff-purchase-continuity: 1`），**绝不释放**既有会话。

`app-context.js` 的 gate 重试路径按门类分流：`waiting_room_required` 走
`readmitToContinue()`，其它 gate 维持 `forceReadmit()`。

**顺序关键**：该分支必须在 freebucks 闸门**之前** —— 续用不产生新购买，
不该被"买不起"拦下（那正是本次把它拦死的那道闸）。

> ⚠️ **该顺序在首版实现里没有被落实**（2026-10-05 修正）。当时新增了 428 分支，
> 却把它写在 `unitGate` / `fbGate` 两道额度闸门**之后** —— 注释写着"必须在
> freebucks 闸门之前"，代码却在之后，注释与代码相反。已经 `npm test` 全绿，
> 因为**测试完全没有覆盖 428 路径**（无任何用例走 `readmitToContinue`）。
>
> 症状复现（远程 2026-10-04T18:52:34Z，账号 llh282000500）：
> ```
> admit  200  扣 15 FB，余额 25→10   ← 买断一小时
> chat   428  waiting_room_required
> skip re-admit: freebucks cannot afford model   balance 10 < price 15  ← 被闸门拦死
> account cooling down  code=freebucks_exhausted
> → 全池没有买得起的号 → 客户端 429 rate_limit_error
> ```
> 即：这一小时**已经付过款**，续用不花新的钱，却因为"买不起下一个小时"被拦下 →
> 号被冷却 + 已付的一小时白扔。用户观感正是「花了 15 点、一次没用上、账号还被警告」。
>
> 修正：把 428 分支整体**前移到两道额度闸门之前**；并补测试
> （`test/smoke.mjs` 的 (3.4) 段，mock 模式 `waiting_room_once`，让 admit 回执
> 带**扣费后**余额 10 以真实命中闸门）。反向探针：把 428 挪回闸门之后 →
> 「不得因 428 续用被冷却（旧行为：code=freebucks_exhausted）」立即变红（已实测）。

官方真值（官方 desktop 0.0.158 解包 `orchestrator.js`）：
`179243` `waiting_room_required: {status:428, endsTheSession:!0}`；
`180126` 命中后存进度 → 重新 admission → **用同一条消息重跑**；
`207147` 重新 admission 带同一 instanceId + purchase-continuity；
**官方从不先 DELETE**。

### 三、释放收敛为唯一入口

新增 `proxy.js` 的 `releaseSessionUnlessPaid(key, why)`：**付费时段内直接拒绝**
（并留日志），只允许付费时段已过时释放。7 处散落的
`runtimes.releaseSession(lastKey)` 全部改调它 —— 这样将来新增重试路径也不会漏。

### 四、附带（用户要求的控制面可达性）

- `getSessionUser()` 除 cookie 外**也认 API Key**（`Authorization: Bearer`）：
  此前同一把 key 在 `/v1/models` 是 200、在 `/api/logs` 是 401，用户拿不到
  日志、排障全靠猜。命中 Web 用户按其 role；命中 `server.api_keys` 按 admin。
- 日志页新增**导出 `.jsonl`**（按当前筛选，含账号维度），文件名带筛选条件。

## Alternatives considered

- **只改 428 的逻辑、不装 bun** —— 治标。`spawn bun ENOENT` → legacy → 428
  这条链还在，每次 chat 照样烧一小时。用户明确指出"先把 docker 那个可执行
  的东西接进去"。
- **保持 alpine、装 gcompat 兼容层** —— 实测缺符号
  （`__pthread_key_create symbol not found`），bun 起不来。换 slim 更干净。
- **bun 提交进 git 仓库** —— 79MB 二进制入库，克隆永久变慢；用户选择
  "构建时从 GitHub Release 下载"。
- **从官方 AppImage 解包 bun** —— 字节同源最理想，但构建要下载 AppImage
  并解压，复杂且脆弱；Release 版同为 1.4.2 且实测可用。
- **主仓库上游调用直接删光** —— 用户裁决"保留代码但禁止调用（标废弃）"，
  少删一些、但运行时不再可达。
- **保留"早退释放拿退款"的行为** —— 前提已被实测证伪（早退不退 Freebucks）。
  保留等于继续烧钱。
- **只修 `final` 那两处释放、其余 5 处不动** —— 换号路径同样在扔已付费会话。
  收敛到唯一入口才是结构性解法。

## Consequences

- **镜像基座从 alpine 变 slim，体积增加**（slim ≈ 80MB vs alpine ≈ 50MB，
  再加 bun 79MB）。与「超级轻量」的初衷有冲突，但**没有 bun 的镜像根本不能
  正常用**（每次 chat 白烧一小时）—— 轻量必须让位于正确。
- **`spawn bun ENOENT` 归零**（容器实测），远程不再静默降级。
- **付费时段内的会话不再被任何重试路径删除**：换号时该账号的槽位仍被占着
  （留着下一跳续用；付费时段结束后由 idle release 腾出）。
- **测试改了 3 条断言**，全部是因为它们断言的**是错误行为**（详见 Evidence）：
  不是放宽判据，是按实测机制改写。
- **API Key 现在可读控制面**（含日志与账号池）。API Key 本就是该用户的长期
  凭据（前端可见可重置），不扩大暴露面；未认证仍 401。

## Evidence

- 容器实测：`hasBun = true`、`BUN_BIN=/opt/bun/bun`、`bun --version → 1.4.2`、
  `spawn bun ENOENT` 计数 **0**（修复前远程日志里有）。
- bun 二进制与本地同源：79500640 字节。
- 基镜像对比实测：alpine + gcompat → `Error relocating … __pthread_key_create`；
  `node:22-slim` → `1.4.2` 正常。
- 测试断言改动（3 条，均为原断言的前提被实测证伪）：
  1. 「失败账号会话被早退释放（拿退款）」→ 改为 `sessionDeletes === 0`
     （本段 mock 会话是 +1 小时 = 付费时段内）。
  2. 「最终失败也必须早退释放（不等挂到过期白扣时长）」→ 同上改为不释放。
  3. 两处用例增加了**显式清场**（`releaseStrict`），因为新行为让热会话留存，
     用例不再自足 —— 这是用例间共享状态的问题，不是实现问题。
- 门禁：typecheck 过；`npm test` 全绿（smoke + frontend smoke + 链路 27 条 +
  目录 13 条）；`check:contract` 通过；`check-config-consistency` 通过。
- ⚠️ **未完成**：端到端真实请求验证。用户提供的几个 token 直连上游均为
  401 `Invalid API key`（绕过代理直打 `www.codebuff.com` 也一样），
  因此未能在容器里跑通一次真实 chat。bun 通道可用性已由 `hasBun=true` 证明，
  但"428 不再发生"需等一个有效账号才能确认。

## Correction

排查过程中我曾把远程失败归因为「槽位被占」「旧 token」「出口 IP」「缓存」，
**全部错误**。真实原因是缺 bun 导致降级 + 428 处置错误 + 释放已付费会话。
教训：没有远程日志时的推论只是假设，必须明确标注并优先取得现场证据。
