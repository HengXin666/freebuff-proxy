# Agent Note: 识别上游 200 响应体内嵌的 free_mode 错误码

Status: implemented

## Problem

上游并不总是用 HTTP 状态码表达失败.它可能返回 **200**,却在响应体里夹
`free_mode_*` 错误串.本仓库 `src/proxy.js` 只在 `!upstreamRes.ok` 分支解析错误体:

```js
if (!upstreamRes.ok) {
  const text = upstreamErrText ?? (await safeText(upstreamRes))
  ...
}
```

于是 200 + 内嵌错误会被**当成成功**,错误被静默吞掉 —— 下游收到一个空/残缺回答,
日志里没有任何线索,控制台也记不上冷却.

这条缺口是在考究第三方实现时发现的(lza6/Freebuff-2API 的
`upstream_body_error` 对 200 也扫错误串),本仓库此前没有等价处理.

## Decision

**新增 `upstreamBodyEmbeddedError(text)` 导出(`src/proxy.js`),
识别响应体里内嵌的 free_mode / 账号级错误码.**

- 扫描码表:`free_mode_invalid_agent_model` / `free_mode_invalid_agent_hierarchy` /
  `free_mode_cli_required` / `free_mode_rate_limited` / `free_mode_capacity_deferred` /
  `account_suspended` / `model_unavailable`.
- **纯识别,不改任何转发行为.** 返回命中的码或 `null`.
- 非字符串,空串一律返回 `null` —— 宁可不识别也不误报.

 **本次刻意不接进流式管道.** 流式路径下响应体已被消费,
要接必须在 `pipeWebStreamToNode` 里缓冲并回扫,属于行为改动;
且接上后会改变"什么算失败"的语义,需要单独的验证与 note.
先落判据函数,让缺口可观测.

## Alternatives considered

- **什么都不做** —— 最省事,且 200 内嵌错误未必高频.
  但它的代价是**静默**:症状是"回答变差或空",而没有任何日志指向真因,
  排查只能靠猜.这与本仓库已有的一条原则冲突:
  "503 这类错误不带业务体时最难排查 —— 没有它只能猜".
- **直接接进 pipe 并触发冷却换号** —— 这才是根治.
  但 (1) 需要在流式转发中缓冲响应体,改动面与内存开销都不小;
  (2) 它把"200"重新定义成"可能失败",会影响所有下游分支判断.
  行为改动必须单独验证,不与"先补判据"混在一次提交里.
- **只记日志不返回码** —— 返回码才能被后续归因/冷却复用,
  只记日志等于把信息丢掉一半,将来接入时还要重写一遍.

## Consequences

- 新导出为纯函数,无 IO,可单测;已覆盖 6 个用例
  (内嵌错误命中 / 正常响应 null / 空串 / null / suspended / capacity).
- 现有行为零变化:`npm test`(smoke ok)与 `npm run typecheck` 全绿.
- 未被识别的响应表现与改前完全一致.

## Evidence

- 代码核对:`src/proxy.js` 的错误解析整段位于 `if (!upstreamRes.ok)` 分支内,
  200 分支无任何错误码扫描.
- 第三方佐证:lza6/Freebuff-2API `src/api.rs:5314` `upstream_body_error()`
  在 `CODES` 里对 `free_mode_*` 扫串,不依赖 HTTP 状态.
- 实测:6 个用例通过.
