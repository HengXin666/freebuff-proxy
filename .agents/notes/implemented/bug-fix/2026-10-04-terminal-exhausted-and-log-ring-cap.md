# Agent Note: 全池额度耗尽是终态(不白轮重试);日志缓冲必须够回溯一次故障

Status: implemented

## Problem

用户问:[高频重试到底是为啥?为什么重试你要高频呢?而且为什么没有重试次数限制呢?]

读远程日志(2026-10-04 14:01:47-14:02:00)后确认,**用户看到的现象与真实成因不同**,
但两个问题都真实存在.

### 一,纠正一个误读(我自己的)

我最初说"13 秒内几百次请求"——那是**把日志条数当成了请求数**.
按 `reqId` 分组后实测:**13 个客户端请求,每个 11 条左右日志**,共约 120 条.
请求间隔 1~5 秒,**不是代理在轰炸**,是客户端(dsh→sub2api)在反复重试.

### 二,真问题:重试是**无效的**,且轮数没意义

每个请求都走满 `maxAttempts = min(账号数+1, 5)` 轮,而**每一轮的结果完全相同**:

```
skip account: freebucks cannot afford model  balance=0 price=15 reason=daily_exhausted
skip account: freebucks cannot afford model  balance=0 price=15 reason=daily_exhausted
upstream error; switching account  code=freebucks_exhausted  attempt=1/2/3
```

两个账号余额都是 0,单价 15 → 买不起.这是**确定性的,不会因重试改变的状态**.

根因在 `app-context.js` 的 `allExhausted` 分支:**全池都买不起时抛的是单账号级的
`freebucks_exhausted`**,而外层 `shouldSwitchAccountOnError(429, …)` 把 429 判成
"该换号" → 再轮一遍全部账号 → 全部买不起 → 抛同样的错 → 循环到 `maxAttempts`.

**但"全池都买不起"是遍历完所有账号才得出的聚合结论**,换号不可能改变它.

### 三,连带伤害:日志缓冲被冲爆

每轮遍历都刷几十条日志.13 个请求 × 3 轮 ≈ 120 条,而**日志环形缓冲上限只有 500**,
且**不落盘**(纯内存).用户想查 30 分钟前的记录时,缓冲里只剩最近 16 分钟 ——
**取证彻底不可能**.

顺带发现一处**骗人的注释**:`src/util/log.js` 写着"可由 config.log.ringCap 调整",
但 `config.js` 里**根本没有 `ringCap` 这一项**,`configureLogBuffer` 也从未被调用 ——
容量永远锁死 500.

## Decision

### 一,加 `terminalExhausted` 终态标记

`UpstreamError` 新增 `terminalExhausted`(与 `fatal` 区分):
- `fatal` = 出口属性(地理封锁),换号无用
- `terminalExhausted` = **池内每个账号都被额度闸门拒过**(遍历完才得出的聚合结论)

`allExhausted` 分支带上它;外层 `isTerminal` 据此**一次收场**,不再轮 `maxAttempts`.

保留 `code`(`freebucks_exhausted` / `units_exhausted`)以兼容既有调用方 ——
只加标记,不改码.

### 二,日志缓冲:接线配置 + 默认 500 → 5000

- `config.js` 新增 `logging.ringCap`(默认 **5000**)+ `KEY_MAP` 的 `ring_cap`
- 订正 `log.js` 那句骗人的注释
- 可在 `config.yaml` 覆盖;`0` = 不保留

代价:每条日志约几百字节,5000 条约几 MB —— 对容器可忽略.

## Alternatives considered

- **给重试加退避(sleep 后再试)** —— 治标:问题不是"试太快",是"试了也没用".
  退避只是把同样的无效轮次摊开.**识别终态**才是根本.
- **把 `maxAttempts` 调小** —— 会伤到真实需要换号的场景(限流/封禁/5xx 时
  换号确实可能成功).不能因为额度类故障而降低整体重试能力.
- **额度类错误直接冷却全部账号** —— 会掩盖"哪个号还有钱"的差异,
  且冷却一个只是暂时没钱的号没有意义(它到期就好).
- **改 `code` 为 `no_available_account`** —— 会破坏既有消费方(多处按 code 匹配),
  且丢失"是额度耗尽"这个更精确的信息.加标记比改码更稳.
- **日志落盘(滚动文件)** —— 更彻底,但涉及磁盘占用与轮转策略,
  是另一个决策;本次先解决"容量不够"这个直接挡路的问题.
- **日志缓冲不设上限** —— 长时间运行会无界增长.必须有界.

## Consequences

- **全池耗尽时一个请求只遍历账号池一次**(此前是 `maxAttempts` 次).
  日志量与上游调用量都随之下一个量级.
- **`terminalExhausted` 是可选字段**:不带的错误对象行为不变.
- **日志缓冲从 500 提到 5000**:内存多几 MB;控制台[日志]页能多回溯约 10 倍.
- **`ring_cap` 是新增配置项**:老 `config.yaml` 没有它,用默认值 5000.

## Evidence

- 远程日志按 `reqId` 分组的实测:**13 个请求**(不是几百),每个 11 条日志,
  间隔 1~5 秒;每轮内容完全相同(`balance=0 price=15 daily_exhausted`).
- 缓冲实测:`limit=1000` 只回 500 条,时间范围 `14:00:44 ~ 14:17:07`(16 分钟);
  `since=` 参数无效(数据不在内存里).
- 配置链路实测:`loadConfig('/tmp/t-rc.yaml')` 带 `ring_cap: 12345` →
  `logging.ringCap === 12345`.
- 新增测试(`test/smoke.mjs`):
  1. 全池买不起时抛出的错误必须带 `terminalExhausted === true`(且保留额度类 code)
  2. 日志缓冲默认 ≥2000,`ring_cap` 可覆盖,`configureLogBuffer()` 真的改到容量
- **反向探针实证可证伪**:
  - 去掉 `terminalExhausted: true` → 断言红
    (`got code=freebucks_exhausted terminalExhausted=false`)
  - `ringCap` 默认改回 500 → 断言红(`got 500`)
- 门禁:typecheck 过;`npm test` 全绿;`check-config-consistency` 过.

## Correction

本次先纠正了我自己的一个误读:把"日志条数"当成了"请求数",据此说
"13 秒内几百次请求轰炸".实测按 `reqId` 分组只有 13 个请求.
教训:日志条数 ≠ 请求数,多轮重试的日志天然放大条数.
