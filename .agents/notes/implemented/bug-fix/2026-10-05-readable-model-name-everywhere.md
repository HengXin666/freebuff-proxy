# Agent Note: 对外模型名一律可读名, 目录 key 只作并列真值

Status: implemented

## Problem

用户要求模型名只有一个口径, 且明确不许再把上游模型 ID(`m-00032eaeec`)当名字
往外给. 实测改前状态:

```
$ curl /v1/chat/completions  (额度耗尽时)
message: "No Freebuff account can afford model m-096e75164d (Freebucks exhausted)..."
                                                  ^^^^^^^^^^^^ 裸目录 key
details.model = m-096e75164d
```

`/v1/models` 与 `/api/models` 的 `id` 此前已经修过(见
`2026-10-04-model-name-three-layers.md`), 但仍有三个出口在吐裸 key:

1. **错误消息与错误体**: `src/context/sched/account-callers.ts` 的四个终态分支
   (paid_window_model_mismatch / session_budget_exhausted / freebucks_exhausted /
   no_available_account)把 `model` 直接拼进 message 与 `body.model`.
   这是下游最先看到, 也最容易被整段转发的字段.
2. **`upstreamModelIds`**: `/api/models` 与 `/api/models/upstream`,
   `/api/accounts/refresh` 三处都给 `catalog.rows.map(r => r.key)` ---- 裸 key.
   前端把它当"哪些模型有额度"的表, 但字段名与用法都像模型名.
3. **`boundModels`**: paid_window 分支里来自上游回执的 `boundModel`, 同样是 key.

## Decision

**对外一律可读名, 目录 key 只作并列真值.**

- 新增 `readableModel(self, model)`: 走 `runtimes.displayNameFor()`
  (展示侧唯一映射入口), 取不到就原样返回 ---- 不隐藏信息, 与
  `catalogDisplayName` 同一条纪律.
- 错误消息与 `body.model` 用可读名; 原 key 以 **`freebuff_key`** 并列透出
  (排障要能对上上游日志, 与 `/v1/models` 既有字段名一致).
- `boundModels` 逐项同样转可读名(用户要拿它去改用另一个模型).
- `upstreamModelIds` 三处统一改成 `aliased.map(a => a.displayName || a.key)`.
  判据真值仍在 `upstreamModels[].key`, 消费方不受影响.

## Alternatives considered

- **什么都不做**: 用户明确点名这是要修的("不要再用那个模型ID了"), 且 429 错误
  是最高频的一条用户可见信息, 每次都吐一串不透明 ID.
- **只改错误消息, 不动 `upstreamModelIds`**: 那批字段名就叫 "ModelIds", 下游
  拿它当模型名用是合理预期; 只改一处等于把同样的坑留在另一个出口.
- **把裸 key 完全删掉**: 排障时"用户说的模型"与"上游日志里的模型"必须能对上,
  删掉会让归因失去锚点. 保留在 `freebuff_key` 是折中, 也复用了既有字段名.
- **在前端做映射而不是后端**: 前端已经有一层 `modelNameFor`, 但错误消息是
  下游(可能不是浏览器)直接读的字符串, 前端映射覆盖不到. 必须在产生它的地方改.

## Consequences

- 错误消息与错误体里的模型名与 `/v1/models` 的 id 同源
  (`displayNameFor` -> 目录 displayName), 三处口径一致.
- 新增字段 `freebuff_key` 出现在错误体里; 既有消费方读的是 `model`, 不受影响.
- 前端 `upstreamReadableIds()` 原本按 key 反查 displayName, 现在拿到的是可读名,
  反查会 miss 但兜底分支 `|| key` 加进去的就是可读名, 结果不变; 注释已同步说明
  两种口径都兼容(便于灰度期后端/前端不同步).

## Evidence

- 改前实测(见 Problem 段): message 与 details.model 均为 `m-096e75164d`.
- 改后实测(额度耗尽态):
  ```
  message: "No Freebuff account can afford model DeepSeek V4.1 Flash (Freebucks exhausted)..."
  message 含 m-xxx: False
  details.model = DeepSeek V4.1 Flash
  details.freebuff_key = m-096e75164d
  ```
- 门禁: typecheck 过; 17 条代码质量门禁全绿; 前端 tsc 错误数 55(改前也是 55).
