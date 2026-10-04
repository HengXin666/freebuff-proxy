# Agent Note: 单请求新会话预算的 0 表示[不限额],不是一个会被用尽的额度

Status: implemented

## Problem

控制台[额度保护]把[单请求新会话上限]的 `0` 显示成 **不限**(`dashboard/app.js` 的
`maxNewSessions \|\| '不限'`),`docs/configuration.md` 写[0 = 不限],API 校验也放行 `0`
(`src/web/api.js`:`0..16` 的整数,`0 = 不限制`).

但 `src/proxy.js` 在构造请求级预算时无条件 `Math.max(0, ...)`,把 `0` 存成了
`{ remaining: 0 }`;`src/app-context.js` 的闸门随即按 `remaining <= 0` 判[预算耗尽],
把**每一个账号**都以 `session_budget_exhausted` 跳过,`failures` 里全是这一条,最终抛出

```
No available Freebuff account for model <model>. Tried N account(s).
{"code":"no_available_account", ... "failures":[{"code":"session_budget_exhausted", ...}]}
```

症状是**整个代理固定 429**:所有模型,所有账号,所有下游请求一致失败,而账号本身健康,
上游额度充足.这是纯粹的**本地自锁**——用户按提示去查账号和额度只会白费时间,
真正的病因是一个配置值被当成"额度"而不是"开关".

## Decision

**预算的 `0` 在调度层表示不限额,用 `remaining: null` 承载.**

- `src/proxy.js`:`budgetLimit > 0 ? budgetLimit : null` —— `0`(或负数)映射为 `null`,
  而不是会被用尽的数字.
- `src/app-context.js`:闸门判据从 `remaining <= 0` 改为
  `remaining !== null && remaining <= 0`;扣减处同样跳过 `null`.
- `src/app-context.js`:全部账号都只因预算被拦下时抛**独立错误码**
  `session_budget_exhausted`(`retryAfterMs` 沿用 `earliestCooldownMs()`),
  不再混进笼统的 `no_available_account`.
- `src/proxy.js`:该错误码加入终态列表——预算在整个请求内不会恢复,重试只会白转一轮.

区分保留:`remaining` 是**数字**时语义不变(默认 2 = 首个账号 + 一次换号兜底,
issue #7 的防护完整保留);只有 `null` 才恒放行.

## Alternatives considered

- **什么都不做(把 `0` 当零预算)** — 现状"能跑"(默认值是 2,只有显式设 0 才炸),
  而且"0 = 零预算"在数值上是最直白的读法.被否决是因为它与三处已发布的用户契约直接冲突:
  控制台把它渲染成"不限",配置文档写"0 = 不限",API 校验注释写"0 = 不限制".
  用户按 UI 文案设了"不限",得到的却是"一个账号都不许用"——这是把最宽松的选项变成了最严苛的.
- **改成[`0` 即拒绝启动 / 校验层报错]** — 让配置无法进入自锁状态,看似更安全.被否决:
  `0` 是**已发布**的合法取值,改成启动失败会把"升级后服务起不来"换成"升级后配置非法",
  同一批用户的同一种损失,且没修好任何既有部署.
- **把 `0` 夹到最小值 1** — 只改一行,最小.被否决:那等于把"不限"悄悄变成"最多换一次号",
  静默改变了显式配置的语义;要限制的用户本来就有 1..16 可选.
- **保留笼统的 `no_available_account`,只修 `0` 的语义** — 改动更小.被否决:这类自锁
  之所以难排查,正是因为错误信息把"本地预算用尽"说成了"没有可用账号".修语义的同时
  必须让错误码说真话,否则下一次同类误配仍要靠读源码定位.

## Consequences

- `0`(不限)不再可能产生 429 自锁;默认值 2 的行为逐字不变.
- 新增一个对外错误码 `session_budget_exhausted`(HTTP 429).下游若按
  `no_available_account` 分支处理预算耗尽,需一并识别新码;两者都是 429 且都带
  `retryAfterMs`,不识别也能重试.
- 代价是 `sessionBudget.remaining` 成为可空类型,闸门与扣减两处都必须显式处理 `null`——
  漏一处的表现是"不限额被当成耗尽"(旧 bug 复发)或"限额永不递减"(预算失效).

## Testing

- `test/smoke.mjs`:预算 `0` 时首个请求正常 admit(`sessionPosts === 1`);3 个账号全 500
  时 `failures` 里不得出现 `session_budget_exhausted`.
- 既有预算用例改为断言新的独立错误码(原先断言 `no_available_account`),
  并保持 `sessionPosts === 2`——默认预算 2 的换号上限未被放宽.
- `npm test`,`npm run typecheck`,`npm run verify-notes` 全过.
