# Agent Note: 上游端点白名单 —— 只发客户端真实发过的请求,且零自动探测

Status: implemented

## Problem

用户裁决:[所有对上游的请求全部扒出来,看看哪些是我们没有从客户端
对齐过的 —— 这些请求全部都不能用.必须从客户端对齐过的请求才可以使用.
之前的所有请求全部作废.]

把仓库在用的端点与客户端 165 条抓包做对齐后发现两类问题:

**一,我们发了客户端从不发的端点**

| 端点 | 客户端抓包次数 | 我们在用 |
|---|---|---|
| `GET /api/v1/me` | **0 次** | 启动自检 + 状态接口 + doctor |
| `POST /api/chat/stream`(web 世代) | **0 次** | 历史残留通道 |
| `x-codebuff-api-key` 头 | **0 次** | session / agent-runs / chat / device-keys 全带 |

客户端真实端点全集只有 15 个(models / device-keys / session ×3 /
agent-runs / chat/completions + 广告/遥测/HEAD 这些可免项).

**二,自动探测**

服务启动,导入账号,`/v1/models` 首访,后台"预热"都会自动发上游 GET.
这等于"下游刷新一次页面 = 上游看见一次我们主动发起的探测".

**三,缓存被当成了次等数据源**

拿不到数据就补一发请求,而不是如实说"还没探测".

## Decision

1. **端点白名单**:只保留客户端真实发过的 7 个必需端点.
   - 删 `GET /api/v1/me`(启动自检 / `handleStatus` / doctor 全部改掉).
   - 删 `POST /api/chat/stream` 及其两个孤儿文件.
   - 删 `x-codebuff-api-key` 全部发送点(只发 `Authorization: Bearer`).
   - 顺带把 device-keys 注册的 body 从 `client: 'freebuff-proxy'` 改成
     官方的 `client: 'desktop'`(前者是自报家门的第三方特征).
2. **零自动探测**:只有用户主动点[一键刷新]/[检测]时才发请求.
   - 启动不发任何上游请求.
   - 导入账号不再自动探测.
   - `/v1/models`,`/api/models`,`/api/models/upstream` 只读缓存.
   - chat 白名单命中本地表时不再后台预热.
   - 停用启动时的 GitHub catalog 自动同步(它写的正是已作废的静态快照).
3. **缓存是第一数据源**:没数据就返回空 + `notProbed: true`,由前端引导
   用户点刷新,**绝不回落 2026-08 的静态 catalog**(那份 13 行只命中 3 行,
   当清单给下游比给空更糟).
4. 清理本地过期凭证(10 条)与 36 个无用设备密钥,只留有效账号.

证据与端点矩阵:`docs/reverse/20-upstream-endpoint-whitelist.md`.

## Consequences

- 服务启动**零上游流量**;上游看到的请求全部由用户动作触发.
- 首次 `/v1/models` 在没有缓存时返回空清单 + `notProbed`,下游客户端
  必须接受"先刷新才有模型表"这一前提(控制台有明确提示).
- `GET /v1/freebuff/status` 不再返回上游 `user` 字段(曾经的 `/me` 结果),
  依赖它的调用方要改读本地账号信息.
- doctor 的"身份自检"改为 `GET /api/v1/freebuff/session`(客户端 17 次).

## Alternatives considered

- **保留 `/api/v1/me` 当健康检查**:它是"客户端从不发"的端点,留着就是
  持续暴露一个非客户端特征.删.
- **保留自动探测但加长缓存 TTL**:方向错了 —— 问题不在频率,在于
  "我们不请自来地发".用户明确要求零自动探测.
- **未缓存时回落静态 catalog**:那份是 2026-08 快照,13 行只命中 3 行,
  给下游等于给一份错的模型表.改为给空 + 提示刷新.
- **保留 GitHub catalog 自动同步**:它打的是 GitHub 不是上游(不消耗账号),
  但它持续用陈旧数据覆盖缓存,且与"清单只认上游目录"冲突.停用.

## Verification

- 启动日志中 `"path":"/api..."` 与 `device signature generated` **计数为 0**
  (改前每次启动至少 2 次).
- 未探测时 `/v1/models` 返回 `{ data: [], notProbed: true }` 且日志无请求.
- 用户登录后点[一键刷新]→ 目录写入缓存 → `/v1/models` 返回可读模型名
  清单,`notProbed` 消失,单价正确挂载.
