# Agent Note: 会话轮询的 setInterval 必须 unref, 不得独自撑住事件循环

Status: implemented

## Problem

`src/session/observe/probe.ts` 的 `_armPoll()` 用 `setInterval` 发持有心跳, 是
本仓唯一没有 `unref()` 的计时器 -- `_idleTimer` / `_releaseRetryTimer` /
`_waitForIdle` 的内层 timer 全都 unref 了, 只有它带 ref, 而它偏偏是 `setInterval`.

这个缺口平时被 "释放路径最后一定会走到 `_clearPoll()`" 掩盖着. 一旦有条路径
**提前返回**, 那条 interval 就留下来把进程钉死.

2026-10-06 触发路径: 付费时段保护(见
2026-10-06-paid-window-guard-on-bulk-release-and-secret-tunables.md)让
`releaseWhenIdle` / `releaseStrict` 在付费时段内直接 `return`, 于是不再经过
`_clearPoll()`.

症状与"测试失败"完全不同, 因此极易误判: 用例全部通过, 日志末尾打完 `smoke ok`,
然后**进程不退出**. 实测 `timeout 240 node test/suites/entries/smoke/smoke.ts`
稳定超时, 而单独跑任何一个 part 文件都 exit 0 ---- 因为那些 part 自己不起 server.

定位方法(单变量可复现):
- 逐段跟踪 88 个 `await import()`, 挂点稳定落在最后一个 part 之后;
- `process.getActiveResourcesInfo()` 显示 smoke 结束后仍有 7 个 Timeout,
  干净 HEAD 是 5 个;
- 给该 `setInterval` 加 `unref()` 后, 同一份改动立刻 EXIT=0.

## Decision

`_armPoll()` 建完 interval 就 `unref()`.

判据不是"所有计时器都要 unref", 而是**它承载的工作是否值得让进程活着**:
持有心跳是 best-effort(失败只记 warn, 见 `refresh()` 的调用点), 没有任何东西
依赖"进程必须活着才能继续发心跳" ---- 进程都该退了, 心跳本来就不该发.

清理路径(`_clearPoll()`)保持不动: unref 解决的是"忘了清就退出不了",
不是"可以不清".

## Alternatives considered

- **在付费时段提前返回的那几处补 `_clearPoll()`** ---- 治的是本次症状, 但把
  判据绑在"调用方记得清"上. 本仓已经有一处漏了(`_armPoll` 自己没有 unref),
  再依赖"每个新分支都记得清"就是把同一个缺陷复制到下一个分支. unref 是结构性
  的: 无论谁忘了清, 进程该退就能退.
- **给测试加 `--test-force-exit` / 在 smoke 末尾 `process.exit()`** ---- 最省事,
  也最容易让所有人以为"本来就该强制退出". 但它把一条真实缺陷(有 ref 的 interval
  泄漏)变成约定的静音, 下一个遇到同样现象的人会先去查测试而不是查计时器.
- **什么都不做(接受 headless 必须超时退出)** ---- 代价是 CI 与本地每次跑测试都
  白等几分钟, 且真正的失败会被超时掩盖: 用例红不红与进程退不退得出, 在这条路径
  上变成同一个退出码.

## Consequences

- 带未清轮询的进程现在能正常退出; 心跳在进程退出时自然停止, 行为不变.
- 清理路径仍然必要: unref 只是让"忘了清"退化成"能退出", 不退化显内存占用.
- 这条改动暴露了一个更一般的判据: 本仓新增计时器时, 要先回答"它该不该让进程活着",
  而不是默认带 ref.

## Testing

`npm test` 全绿且进程自行退出(不再需要 `timeout` 兜底).

可证伪: 把 `if (this._pollTimer.unref) this._pollTimer.unref()` 这一行删掉, 重跑
`timeout 240 node test/suites/entries/smoke/smoke.ts` ---- 用例仍然全绿并打印
`smoke ok`, 但进程在 240s 后被杀(exit 124). 加回即 EXIT=0.
