# 09 — 第三方实现考究:marktantongco/freebuff-proxy

> 考究对象:https://github.com/marktantongco/freebuff-proxy
> (Go 实现,fork 自 ferdiunal/freebuff-proxy;自称 "JA3 stealth transport +
> multi-token session pool + SOCKS5 proxy pool + monitoring dashboard")
> 结论:**拒绝采纳**.它走的是我们早已证伪或明确不做的路径,且能力 strictly weaker.

## 9.1 一句话结论

它**自己承认不产生工具调用**(README:286):

> "Tool definitions are best-effort converted to OpenAI function tool format;
> **the current upstream chat service returns text responses so Anthropic
> `tool_use` response blocks are not produced in this version.**"

而本次任务的目标正是[200 + 文本 + **工具调用**].它在目标上就不达标.

## 9.2 逐项对比

| 维度 | 本仓库 | marktantongco | 判定 |
|---|---|---|---|
| 上游 host | `https://www.codebuff.com` | 同 | 一致 |
| chat 端点 | `/api/v1/chat/completions` | 同 | 一致 |
| `run_id` | 在 `codebuff_metadata.run_id` | 同(`/api/v1/agent-runs`) | 一致 |
| **设备签名(Ed25519)** | **已实现** `src/upstream/device-signing.js` | **完全没有**(grep 无 ed25519/device signing) |  它缺 |
| **catalog 协议** | 已实现 `catalog-protocol.js` | 无对应实现 |  它缺 |
| system 开场白 | base2 **与** base3 双版本,按 agent 世代选 | 只有 base2 一句(`cliSystemMarker`) |  它只有旧世代 |
| agent id | `base3-free-catalog`(目录模式) | `base2-free`(写死) |  旧世代 |
| **工具调用** | 目标能力;工具签名已实现 | **自认不产出 tool_use** |  不达标 |
| JA3 / TLS 指纹伪装 | 无(也不做) | 有(uTLS,chrome120 等) |  见 §9.3 |
| 代理池 / 地理校验 | 有(按账号稳定哈希) | 有(SOCKS5 + ip-api 校验) | 相当 |

## 9.3 它的核心卖点是"伪装",而这正是我们不要的路

它的差异化全在 `internal/stealth/`(约 2000 行):

```
tls.go        uTLS JA3 指纹冒充（chrome120 / firefox120 / safari17 / random）
profiles.go   TLS 扩展、椭圆曲线、签名算法的逐项伪造
headers.go    请求头伪装
proxy.go      SOCKS5 代理池 + 地理校验（PROXY_STRICT_GEO 只收 US 代理）
randomizer.go 随机化
```

即它的思路是:**把代理伪装成浏览器/真客户端,靠换 IP 与换 TLS 指纹躲检测.**

这与本仓库的定位与红线冲突:

1. **AGENTS.md 定位红线**:只做免费链路,不顺带提定位之外的路线.
   大规模代理池轮换 IP 恰恰是上游点名的"账号农场"特征
   (AGENTS.md:[上游把[轮换健康账号]直接当账号农场特征]).
2. **我们已有的实测结论**:账号被封的判据是 `status: banned`,
   是**账号级**的,换出口 IP 救不回来 ——
   (实测同一出口下 admission 首次 200,后被封;`region_locked` 只是伴随说明).
   靠换 IP 绕检测,方向与证据相反.
3. **它缺我们已有的一切关键协议件**:设备签名,catalog 协议,base3 世代.
   它没有这些还能跑通文本,是因为**它根本没往带工具的方向走**——
   一旦要 tool_calls,这些件一个都少不了.

## 9.4 一个值得抄的点(仅此一项)

`session_recovery.go` 与 `types.go` 把 session 状态显式建模成枚举:

```go
SessionBanned / SessionCountryBlocked / SessionRateLimited / SessionDisabled ...
```

并在多处把 `SessionBanned` 归入"不可恢复"分支集中处理.
本仓库目前靠 `extractAccountBanError` 归一到 `banned`,语义等价,
但**显式枚举 + 集中分支**在可读性上更好.这属于风格改进,非协议差异,
不构成本次任务的阻塞项,需要时可单独做.

## 9.5 裁决

**拒绝采纳其路线.** 理由:

1. 它不产出工具调用 —— 与任务目标直接矛盾.
2. 它的差异化(JA3 伪装 + 大规模 IP 轮换)是我们已证伪或明令禁止的方向:
   封禁是账号级,换指纹换 IP 不解决,且代理池轮换本身是上游点名的农场特征.
3. 它缺设备签名与 catalog 协议 —— 这两件是本仓库已具备,
   且带工具请求必需的能力.抄它等于降级.

**继续沿本仓库现有协议链路推进**,不引入其任何实现.
