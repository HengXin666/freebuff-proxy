# Agent Note: bun 通道总开关 FREEBUFF_DISABLE_BUN

Status: implemented

## Problem

`catalog / session / DELETE / device-keys` 陆续改走 bun 之后，smoke 测试
出现一类新问题：**bun 侧每个动作都会先 `fetchCatalog()`**
（`upstream.mjs` 的 `if (act !== 'catalog') await bridge.fetchCatalog()`），
而 smoke 的 mock 上游不响应 `/api/v1/freebuff/models` → 动作整体失败
→ 虽然会回落 Node，但"释放/注册"这类用例会变得依赖回落时序而不稳定
（实测：`代理切换后旧 session 优雅释放` 等待超时）。

需要一个总开关把 bun 通道整体关掉 —— 用于测试与排障。

## Decision

新增 `FREEBUFF_DISABLE_BUN=1`：置为 `1` 时四个 bun 通道
（`makeBunFetcher` / `makeSessionViaBun` / `makeReleaseViaBun` /
`makeDeviceKeysViaBun`）全部直接返回 null → 走既有 Node 实现。

- 生产默认**启用** bun（不加该变量）。
- `test/smoke.mjs` 在文件顶部设置 `process.env.FREEBUFF_DISABLE_BUN = '1'`。

理由：smoke 测的是**代理的调度与容错逻辑**，不是"请求跑在哪个运行时
上"；后者由本地镜像对照单独验证（`docs/reverse/21` §21.6）。

## Consequences

- 测试不再受 bun 前置 catalog 抓取影响，回到确定行为。
- 排障时可一键切回 Node 路径做对照（谁出问题一眼可辨）。
- 开关只在通道入口判一次，无性能开销。

## Alternatives considered

- **让 bun 侧动作跳过前置 fetchCatalog**：会改变副仓库的动作语义，
  且 catalog-fetch 是签名必需（fetchId），不该为测试弱化。
- **在测试里 mock 掉 catalog**：可行但要给 mock 上游加目录响应，
  改动面比加一个开关大，且会让 smoke 依赖更多 mock 细节。
- **不加开关、让测试依赖回落**：实测不稳定（释放等待超时），不行。

## Verification

- `FREEBUFF_DISABLE_BUN=1` 时四个通道均返回 null，走 Node。
- smoke 中"代理切换后旧 session 优雅释放"不再超时。
- 生产（不设该变量）bun 通道照常启用，本地镜像实测头集与客户端一致。
