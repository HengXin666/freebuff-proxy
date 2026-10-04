# Agent Note: No Account Identifiers in Client-Facing Errors

Status: implemented

**Affects:** `src/app-context.js`(`sanitizeFailuresForClient` / `countReasons` / `maskEmail`),`test/smoke.mjs`

## Problem

全账号不可用时,429 响应把**每个账号的 key,email,冷却时间**原样返回:

```json
{"error":{"code":"no_available_account","details":{"failures":[
  {"key":"ec90f5ac-...","email":"gh9227684@loliko.top","code":"banned","message":"cooling down until ..."}]}}}
```

这条响应会被下游 Agent 客户端**原样转发**,落进别人的日志与报错堆栈 ——
等于把整个账号池的邮箱清单发给调用方.用户明确要求"不应该把他们返回出来".

同时用户怀疑 banned 账号仍在参与调度.核查结论:**没有** ——
`candidateKeys()` 里 `isCoolingDown()` 已过滤,banned 账号不进候选,不 admit,
不产生扣费;它出现在 failures 里只是"已跳过"的记录(用于说明为什么没号可用),
并非"被调度过".但这两件事在响应里长得一模一样,所以要把明细收掉.

## Decision

对外响应(`error.details`)只给**聚合与分类**,不给账号标识:

```json
{"model":"...",
 "failures":[{"code":"banned"},{"code":"unauthorized"}],   // 只留 code
 "reasons":{"banned":6,"unauthorized":8},                    // 聚合计数
 "tried":14, "banned":6}
```

- 保留 `code` 是因为**错误码分类依赖它**:全 `banned` / 全 `freebucks_exhausted` /
  全 `session_budget_exhausted` 会得出不同的顶层 code 与建议动作,测试也据此断言.
- 顶层 `error.message` 也改掉:原先拼接 `failures[].message`(可能含邮箱),
  改为聚合概览 `14 account(s) tried (banned×6, unauthorized×8)`.
- 出口级故障(`fatal`,地理封锁)同理:它是出口属性,与具体账号无关,只给 code.
- 新增 `maskEmail()`(`a***e@gmail.com`,保留域名掩码本地部分):供日志与 UI 用.
  管理员在**登录后的控制台**看自己的账号仍显示完整邮箱(那是管理界面,不是对外 API).

参考了 `trefeon/freebucks-proxy` 的做法:它同样对报告里的邮箱做脱敏,
且错误里只给 "第几个 token" 而非明细.

## Consequences

- 下游拿不到账号邮箱/key,PII 不再外泄.
- 排障信息不丢失:`reasons` 回答"为什么全挂了",`tried`/`banned` 给规模,
  完整且脱敏的明细仍在服务端日志与控制台.
- 测试在**真实端到端路径**上钉死(fbChat → 真实 HTTP → 断言响应不含邮箱,
  failures 条目无 email/key/message 字段).

## Alternatives considered

### 1. 完全删掉 details

**Rejected:** 调用方无法区分"没配账号 / 全被封 / 额度用完 / 出口被地理封锁",
而这四种处境的处置方式完全不同.保留分类,去掉标识才是对的粒度.

### 2. 只删 email,保留 key 与 message

**Rejected:** key 是凭据文件名(常等于邮箱或账号 id),泄露凭据目录结构;
message 里也常嵌邮箱.只删一个字段等于没删.

### 3. 加一个开关(如 `exposeAccountDetails`)默认关

**Rejected:** 项目铁律是"轻量优先,一切配置走前端",为一个应始终为 false 的
安全默认值加开关是纯负担,且会被误开.

### 4. 什么都不做

**Rejected:** PII 外泄,且用户明确要求修.

## Related

- `test/smoke.mjs`:真实端到端 PII 断言 + `maskEmail` 单测 + banned 不进候选断言
- `.agents/notes/implemented/bug-fix/2026-09-30-country-block-reason-in-200.md`(出口级 fatal 的既有约定)
