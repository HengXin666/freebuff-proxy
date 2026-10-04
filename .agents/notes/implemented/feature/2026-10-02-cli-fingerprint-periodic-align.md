# Agent Note: CLI Fingerprint Periodic Version Alignment

Status: implemented

**Affects:** `bin/serve.js`, `src/upstream/official-fingerprint.js`

## Problem

CLI 指纹版本号(chat UA 里的 `ai-sdk/openai-compatible/<v>/codebuff`)随官方发版变化.
`refreshCliVersion()` 已存在,但只在**启动时调用一次** —— 长跑进程(Docker 常驻数天)
会一直用启动那一刻的版本.若官方发版,我们的 UA 版本落后,本身就是可被上游用来
区分"真客户端 / 第三方"的指纹面.

同时:版本变化是静默的.即使刷新成功,运维也只能翻日志比对,看不出"该跟进官方了".

## Decision

保留启动时的首次对齐,**追加一个 6 小时周期刷新**,并在版本实际变化时 `warn` 一条
`cli fingerprint version changed upstream; realigned`(带 from / to).

定时器 `unref()`:绝不挡进程退出.
刷新失败静默保留现值(best-effort,与既有语义一致).

## Consequences

- 长跑进程的版本号自动跟随 npm `freebuff` 最新版,无需重启.
- 版本变化在日志里是显式 `warn`,可被 grep / 告警管道接走.
- 6h 一次,单次 8s 超时,失败静默 —— 对上游与本地可用性均无额外负担.
- 版本号只影响 UA 形态,不影响设备签名(签名与 CLI 版本无关).

## Alternatives considered

### 1. 只在启动时刷新一次(现状)

**Pros:** 零额外代码,零定时器.
**Rejected:** Docker 常驻场景下版本会永久停在启动时刻,与官方差距随时间拉大.

### 2. 每个请求都拉 npm 版本号

**Rejected:** 每个请求多一次外网 RTT,且 npm registry 不可达时会影响请求路径.
版本号的时效性要求远低于请求延迟 —— 6h 粒度足够.

### 3. 硬编码最新版本号,定期手工更新

**Rejected:** 需要人工跟进,且版本写死在代码里必然滞后于官方发版.

### 4. 什么都不做

**Rejected:** 落后版本是已知的指纹风险,且已有 `refreshCliVersion()` 基础设施,
接一个周期调用的边际成本极低.

## Related

- `src/upstream/official-fingerprint.js`:版本真源与 `refreshCliVersion()` / `getCliVersion()`
- 协议逆向总结:`docs/reverse/11-tls-fingerprint.md` § CLI 指纹(`REVERSE_ENGINEERING_SUMMARY.md` 已废弃删除:它写的 CLI 版本号 `0.2.12` 与真值 `KNOWN_CLI_VERSION` 不符)
