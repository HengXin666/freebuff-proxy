# Agent Note: 悬空的 lastSuccessKey 不得让服务起不来

Status: implemented

**Affects:** `src/app-context.js`（`_restoreAccountState` / `getAny`）

## Problem

容器**重启直接失败**，服务进不了监听状态，`restart: unless-stopped` 于是无限重启：

```
[freebuff-proxy] ✗ 启动失败（服务未能进入监听状态）
  错误: Account not found or not logged in: 31c7b96c-1565-4c42-a754-2903d0a1e1bf
UpstreamError: Account not found or not logged in: 31c7b96c-1565-4c42-a754-2903d0a1e1bf
    at AccountRuntimes.get (src/app-context.js:604)
    at AccountRuntimes.getAny (src/app-context.js:1672)
    at buildAppContext (src/app-context.js:2107)
    at main (bin/serve.js:304)
```

`account-state.json` 的 `lastSuccessKey` 是**账本里的历史指针**，指向的账号
可能早就不在凭据目录里了：用户在控制台删了旧号、换了新账号、或凭据文件是
在**另一个进程/手工**删掉的（`forgetAccount` 不在那条路径上，清不到指针）。
指针一悬空，启动路径上的 `getAny()` 必然抛错，整个服务起不来 ——
**一个纯历史字段把服务钉死在启动阶段**。

实测复现（2026-10-03，本地）：`credentials/` 只放 `new-account-id.json`，
`account-state.json` 的 `lastSuccessKey` 指向 `31c7b96c-…` → 逐字复现上面的堆栈。

## Decision

两处自愈，都不改变正常路径的行为：

1. **恢复时校验**：`_restoreAccountState` 里，`lastSuccessKey` 不在
   `this.allKeys()` 中就丢弃（置 null）。历史指针不该比当前事实更有权威。
2. **`getAny()` 不把"首选失效"升级为致命**：首选 key 不在当前 keys 里就直接用
   `keys[0]`；若 `get()` 仍抛（凭据文件此刻不可用），依次尝试其余账号，
   全部失败才抛最后一个错误。控制台/状态接口不该因为一个坏账号 500。

## Alternatives considered

- **只做 (1)，不动 getAny** —— 能修掉重启失败这个具体现象，改动更小。
  **否决**：指针在**运行期**也会悬空（并发删号、手工移走凭据文件），
  那时 (1) 已经跑完，`getAny()` 照样把可恢复的故障升级成 500。
  只修一半，等于留一条同样成因的复现路径。
- **让 `forgetAccount` 兜住所有删除入口** —— 语义上最"正"。**否决**：删除
  发生在用户自己的机器上、甚至发生在**上一个容器**里（凭据文件直接没了），
  本进程根本没有那次调用的机会；靠"记得清指针"是防御不住的。
- **启动时干脆不读 `lastSuccessKey`** —— 一行搞定。**否决**：它承载
  "最近成功用的是哪个号"的展示语义（`lastUsed` 标记），删掉会让控制台退化。
- **把坏指针写成新的 `lastSuccessKey`（改成 keys[0] 并落盘）** —— 自愈得更彻底。
  **否决**：启动路径上写盘会把"读状态"变成"写状态"，多一个失败面；
  指针本来就只是提示，置 null 后 `getAny()` 自然回落，不需要落盘。

## Consequences

- 换了账号 / 删了旧号 / 手工清理过 `credentials/` 的部署，升级后能正常启动，
  自动回落到现有账号（实测：`upstream auth ready account=new@example.com`）。
- 无账号时行为不变：`buildAppContext` 的空账号分支照旧返回空上下文，
  服务照常监听（实测 `port 28802` 正常起来）。
- 正常路径不变：`lastSuccessKey` 有效时仍优先用它（实测 `port 28803`
  起来后 `upstream auth ready` 指向该账号）。
- `npm test` smoke ok；`npm run typecheck` 无错。

## Evidence

- 复现：`/tmp/repro`（credentials 只有 new-account-id，lastSuccessKey 指向
  已删的 `31c7b96c-…`）→ 修复前逐字复现用户堆栈；修复后 `listening` +
  `upstream auth ready account=new@example.com`。
- 用户线上堆栈（RackNerd VPS，`ghcr.io/hengxin666/freebuff-proxy:latest`）：
  `app-context.js:604 → :1672 → :2107 → bin/serve.js:304`，与本地复现一致。
- 该缺陷在 v1.17.0 起就存在（`git show v1.17.0:src/app-context.js` 第 1511 行
  同样是 `this._lastSuccessKey || keys[0]`），与 2026-10-03 的模型名改动无关
  （那次未触碰 `app-context.js`）。
