# Agent Note: 429 回执必须带 Freebucks 这笔账(花了多少 / 剩多少 / 何时恢复)

Status: implemented

## Problem

真实部署(单账号)里的完整困惑链:

1. 用户刷新控制台,看到 **Freebucks 25**;
2. 发一个请求 → 失败(服务端 503/429);
3. 之后再发一律 429,`no_available_account` / `freebucks_exhausted`;
4. 用户的核心质疑:**"刚刚不是 25 吗?为什么就失败了?"**

而回执只说 `No available Freebuff account for model X. Tried 1 account(s).`
—— 既不说**这次花了多少**,也不说**什么时候恢复**,更不说**为什么一个请求
就能把 25 打光**.用户判断不了"账号坏了还是额度没了",只能反复重试,
**每试一次都在烧钱**.

根子在语义没被传达:**一次 admit = 买断一整小时**,POST 当场扣掉整小时单价,
不是按用量扣.`25` 是**每日池的上限**而非余额,一个请求就能打光.
叠加"早退/失败不退 Freebucks"(实测只回 `freebucksRefundPending`,
观察 2 分钟未到账),于是"钱花了,服务没拿到,下一个请求又买不起".

## Decision

**429 错误体带上这笔账的聚合数值**,两处都带(`freebucks_exhausted` 与兜底的
`no_available_account`).

字段:`price / balance / dailyRemaining / dailyLimit / resetAt / reason / note`.
`note` 一句话把机制说清:**买断制,预扣整小时,早退不退**.

###  脱敏纪律(与 `sanitizeFailuresForClient` / `maskEmail` 同源)

**只带聚合数值,绝不带 key / email / 账号标识.** 429 响应会被下游整段转发
与写进日志,带标识等于泄露账号池规模.多账号时取"余额最小"的那份
(它最先卡住请求),而不是列出全部.

###  取数必须回查 runtime,不能只在 failures 上挂

第一版只在选号闸门那条 `failures.push` 上挂 `freebucks`,**实测字段一个都没
出现**:额度拦截有多条路径(选号闸门 / admit 失败后的通用 err 分支 / 冷却
分支),换一条触发路径就拿不到数字.

改为:`summarizeFreebucks(failures, this, model)` 以 failures 为主,
**缺失时按 key 回查 runtime 现取**,一处覆盖所有路径.

###  查价必须用目录 key,不能拿可读名

`freebucksFor()` 按目录 key(`m-096e75164d`)在 prices 表取值;传可读名
`"DeepSeek V4.1 Flash"` 取不到 → `price=null` 被当成"不计费模型" →
回执出现 `price 0 / dailyLimit 0` 这种**假数字**(实测踩到).
聚合时走 `resolveModelAlias()` 与选号闸门同一口径.

## Alternatives considered

- **什么都不做(保持笼统的 no_available_account)** —— 用户已经在真实部署上
  为此困惑并反复重试,每次重试都在烧钱.回执不解释机制 = 用户只能猜.
- **只在 message 里写清楚,不动 body** —— message 会被下游整段转发,且
  AGENTS.md 明令禁止把账号标识拼进 message;结构化字段才是给程序读的.
  两者都做(message 给概要 + body 给明细),但 body 里绝不放标识.
- **带上账号邮箱方便排障** —— 直接违反脱敏纪律;429 会被转发与记日志.
  排障信息走控制台(有登录态),不下发到 API 错误体.
- **改 Freebucks 的计费/退款逻辑** —— 那是上游行为(买断制,早退不退),
  本机改不了.本次只做**如实告知**,不改计费语义.
- **把 25 显示成"每日池上限"而不是"余额"** —— 控制台口径问题,与本次
  API 回执是两件事;本次不扩大范围(API 侧已用 `dailyLimit/dailyRemaining`
  把两个概念分开表达).

## Consequences

- **429 响应体新增至多 7 个字段**;无额度信息时返回 null,**不塞空壳字段**
  (避免给下游"看起来有值实则全 null"的误导).
- **多了一步 runtime 回查**:仅在 failures 未挂账时触发,且 `get()` 失败
  (账号已删等)被 catch,不放大故障.
- **顶层 message 变长**:多了余额/单价/重置时间与一句买断制说明.
  这是刻意的 —— 用户缺的正是这句话.
- **既有 code 不变**(`freebucks_exhausted` / `no_available_account`):
  调用方按 code 匹配的逻辑不受影响.

## Evidence

- 真实触发(本地单账号,余额已归零):
  ```
  code    = no_available_account
  message = ... Freebucks: balance 0 < price 15 (daily pool 0/25);
            refills 2026-10-04T16:00:00.000Z.
            One admit buys a whole hour and is charged upfront.
  details = {price:15, balance:0, dailyRemaining:0, dailyLimit:25,
             resetAt:'2026-10-04T16:00:00.000Z', reason:'daily_exhausted'}
  ```
- 修复前对照:同一请求只回 `No available Freebuff account for model X.
  Tried 1 account(s).`,无任何额度字段.
- 中间态踩坑已记录:挂在 failures 上漏字段(改回查),
  传可读名导致 `price 0 / dailyLimit 0` 假数字(改 `resolveModelAlias`).
- 脱敏实测:`details` 序列化后不含 `6199d6e9` / `@gmail` / `email`.
- 门禁:typecheck 过;`npm test` 全绿(smoke + frontend smoke + 目录 13 条);
  `check:contract` 通过;`check-config-consistency` 通过.

## Correction

排查过程中曾把远程失败判为"槽位被占(`purchase_claim_released`)".
该判断**与 `balance=25` 矛盾**:买断制下槽位被占意味着钱已扣.
真实原因是额度被那个失败请求买断后归零(`daily spent 25/25`).
本 note 只记录回执改进那一条决策;额度语义见
[2026-09-14-paid-hour-hold.md](../architecture/2026-09-14-paid-hour-hold.md).
