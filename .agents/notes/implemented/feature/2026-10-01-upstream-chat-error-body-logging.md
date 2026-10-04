# Agent Note: 上游 chat 非 2xx 时记录响应体(可观测性)

Status: implemented

## Problem

上游 chat 返回 503 时**不带业务体**(`{"error":{"message":"The model is
temporarily unavailable. Please try again later.","code":503}}`),而我们此前
只把状态码归成 `http_503` 就抛出去 —— 排查时只能猜.

实测这一条日志的价值:它把"503 到底是什么"从猜测变成事实(上游确实只回了
通用不可用文案,没有更具体的判据).

## Decision

**在 chat 响应处理处,非 2xx 时用 `logger.warn` 记下状态码,模型与响应体
(截断 800 字符).**

这是纯可观测性改动:不改任何控制流,失败照旧走原有分支.配合控制台[日志]页
(见 [2026-09-30-console-log-viewer.md](2026-09-30-console-log-viewer.md))
用户能直接看到上游原话.

## Alternatives considered

- **不打日志** —— 改前现状.503 无体时无法区分"上游真的不可用"与"形态被拒",
  而这正是本项目花了多轮才收敛的判据类型.
- **把响应体直接透传给下游** —— 会改变客户端可见行为,且上游错误体未必是想给
  终端用户看的文案.记日志即可.

## Consequences

- 上游 chat 失败时日志里有完整响应体,排障不再靠猜.
- 日志有 800 字符上限,不会因为一个巨大错误体把日志冲爆.

## Evidence

实测抓到的体:

```
{"error":{"message":"The model is temporarily unavailable. Please try again later.",
 "code":503}}
```

端到端现状:**会话与 agent run 均已成功**(日志有 `freebuff session active`
+ `started agent run`),只剩 chat 层 503.账号 `banned: false`,额度 15/25 未消耗.
