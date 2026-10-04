# Agent Note: 上游主机必须硬编码（api_base 可配曾让全新部署误报「凭证失效」）

Status: implemented

## Problem

用户报远程 Docker 部署上账号凭证「**一直显示失效**」，而**同一份凭证**在本地
实例探测 `ok=true`。差异只剩部署环境。

按用户要求**删掉本地 docker、全新空卷重新部署做对照复现**（不靠猜测修）：

```
全新空卷 + v1.20.0 镜像 + 同一份凭证
  导入 → ok（tokenFingerprint e2a120c1702a / tail d602c3，与本地同源）
  检测 → 401 auth_unauthorized「Missing or invalid Authorization header」
```

容器日志给出决定性一行：

```
registering device key  url: https://codebuff.com/api/v1/freebuff/device-keys
                              ^^^ 少 www
```

三处取值对照：

| 来源 | api_base |
|---|---|
| 全新容器生成的 config.yaml | `https://codebuff.com` ❌ |
| 本地能通的实例 | `https://www.codebuff.com` ✅ |
| `src/config.js` 默认值 | `https://www.codebuff.com` ✅ |

`config.example.yaml` 第 13 行写的是不带 www 的主机。全新容器把它复制成
`/data/config.yaml`，于是**所有**上游请求打到不带 www 的主机：

```
401 Missing or invalid Authorization header
  → 设备密钥注册失败（拿不到 keyId）
  → session GET 无签名（它是抓包里唯一必签的端点，165 条中 13 次）
  → 控制台显示「凭证失效」
```

**token 全程有效** —— 这解释了"同一凭证本地通、远程不通"。

它能潜伏到用户头上的原因：两个值都是"看起来合理的 URL"，少一个 www 肉眼看
不出来；本地开发读的是仓库根那份 config.yaml（写对了），只有**全新部署**
（Docker 空卷走 example）才踩中。

## Decision

用户裁决：上游主机硬编码，不可能有人会去改这个。

- `src/config.js` 新增 `UPSTREAM_API_BASE` 常量作为**唯一真源**；
  `loadConfig` **无条件以它为准** —— 配置文件里写错也一并纠正，
  而不是"没配才用默认值"（老配置文件同样受益）。
- 唯一覆盖口是 `FREEBUFF_UPSTREAM_API_BASE` 环境变量，仅供本地镜像对照
  / 离线契约测试（docs/reverse 里有这条用法），生产不设。
- `config.example.yaml` **移除** api_base 项：不给写错的机会。
- 新增 `scripts/check-config-consistency.mjs`：钉住"配置模板不得再出现
  api_base" + "硬编码值必须是带 www 的官方主机"。

## 顺带：bun 侧惰性注册（同一条链上的第二道保险）

主机修对之后，全新卷上仍有 keyId 缺失隐患：密钥文件由 **Node 侧
`DeviceSigner`** 生成，而 session 走 **bun 通道**时不经过它 → 文件永不创建
→ 无签名（死锁）。故补两处：

- `official-rpc.js` 的 `buildRpcCfg`：密钥文件缺失时**就地生成**（纯本地 IO，
  不发请求）并把 publicKey 带上；
- `cli-bridge/upstream.mjs` 新增 `ensureKeyId()`：有私钥但无 keyId 时自行
  注册（此前 `signHeaders()` 见 keyId 为空直接返回 `{}`，等于放弃签名）。

## Alternatives considered

- **什么都不做，只把 example 里的值改对** —— 能救本次，但留下同一个可写错
  的入口；下次有人再改一次就复发。用户明确要求"不应该写到配置里面去"。
- **保留可配、只加校验（启动时校验必须是 www 主机）** —— 校验本身也要写对，
  且失败模式变成"拒绝启动"，比"自动纠正"更粗暴。硬编码后这个类错误
  **根本无法表达**，是最强的防线。
- **保留可配 + 文档里警告** —— 文档不执行，没人改配置时会读它。
- **把 api_base 也一起从 DEFAULTS 删掉、只留常量** —— DEFAULTS 仍需要它
  （`deepMerge` 的键结构与多处读取），保留引用常量的写法，避免多点漂移。
- **连 login_base 一起硬编码** —— login_base（`https://freebuff.com`）目前
  取值正确且有实际可调场景（登录站点切换），本次不过度扩大改动范围。

## Consequences

- **配置文件里的 api_base 被完全忽略**：写错的老配置会在加载时被自动纠正
  （实测：`https://codebuff.com` → 生效 `https://www.codebuff.com`）。
  代价是失去"改配置指向别的主机"的能力 —— 这正是本决策的目的。
- **`FREEBUFF_UPSTREAM_API_BASE` 是唯一的逃生口**：仅本地镜像对照使用，
  CI/生产均不设。
- **`config.example.yaml` 少了 api_base 一项**：全新部署不再生成它，
  用户也不会以为它是可调项。
- **新增一个门禁脚本**：`scripts/check-config-consistency.mjs`，
  防 api_base 悄悄回到配置模板里。
- 过程中踩到一次 **TDZ**：`UPSTREAM_API_BASE` 声明在 `DEFAULTS` 之后却被它
  引用 → `ReferenceError: Cannot access ... before initialization`。
  已将声明移到 `DEFAULTS` 之前。与前端 `rows`/`staleCount` 属同一类错误，
  教训一致：`node --check` 与 typecheck 都抓不到 TDZ，必须实际加载。

## Evidence

- 复现（全新空卷 + v1.20.0）：导入 200，检测
  `401 auth_unauthorized` / `Missing or invalid Authorization header`。
- 容器日志实测：`registering device key url: https://codebuff.com/...`。
- 修复后对照（全新空卷 + 修复镜像 + **同一份凭证**）：
  `ok=true`、Freebucks 25；修复版 config.yaml 已无 api_base，
  实际生效 `https://www.codebuff.com`。
- 纠正验证：`loadConfig('/tmp/fb-fresh/data/config.yaml')`（该文件写着
  少 www 的错误值）→ `apiBase = https://www.codebuff.com`。
- 门禁：typecheck 过；`npm test` 全绿（smoke + frontend smoke + 目录 13 条）；
  `check:contract` 通过；`check-config-consistency` 通过。

## Correction

上一轮"无 bun 也能通"的对照**不成立**：它复用了本地卷里**已注册好**的密钥
（`keyId=6fVFpAL0XcQOB8qZ2yz_VH`），没有模拟"全新卷"，因此不能据此排除
bun 缺失这一变量。已在本次改为真正的空卷对照。
