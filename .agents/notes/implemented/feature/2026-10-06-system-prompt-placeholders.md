# Agent Note: 系统提示词支持官方占位符, 自定义正文也能用动态值

Status: implemented

## Problem

上一版把官方模板里的动态段改成运行时重算之后, 引出一个新问题: **自定义提示词用不了那些动态值.**

`buildSystemMessages` 的 `custom` 分支是 `sysText = systemPrompt.text` ---- 直接取用户文本,
不做任何替换. 于是用户在正文里写 `Current date: {CODEBUFF_CURRENT_DATE}.` 也只会原样发出去.

而官方模板本身就是靠占位符生成动态内容的: 它的 worker 模板里写着
`Current date: ${PLACEHOLDER2.CURRENT_DATE}.`, 由 `formatPrompt` 在运行时替换.

## Decision

**沿用官方占位符语法, 不自己发明.** 官方(orchestrator 的 `PLACEHOLDER`)是
`{CODEBUFF_<NAME>}`, 名单 13 个, 替换机制是简单字符串替换:

```js
for (let varName of placeholderValues) {
  let value = await (toInject[varName] ?? (() => ""))();
  prompt = prompt.replaceAll(varName, value);
}
```

沿用它的三个理由: ① 用户从官方模板里抄来的占位符在我们这里直接可用; ② 不必让用户学第二套语法;
③ 形态与官方一致这件事本身有价值(上游按形态判客户端).

**只填我们能填的五个**, 其余八个替换成空串:

| 能填 | 取值来源 |
|---|---|
| `CURRENT_DATE` | 当前时间 |
| `AGENT_NAME` | 恒为 Buffy |
| `USER_INPUT_PROMPT` | 本次用户消息 |
| `INITIAL_AGENT_PROMPT` | 首轮提示(有则填) |
| `REMAINING_STEPS` | 剩余步数(有则填) |

另外八个(`FILE_TREE_PROMPT*` / `GIT_CHANGES_PROMPT` / `KNOWLEDGE_FILES_CONTENTS` /
`PROJECT_ROOT` / `USER_CWD` / `SYSTEM_INFO_PROMPT`)的取值来自**客户端本机**的上下文
(用户的文件树 / git 仓库 / 工作目录 / 系统信息), 本代理不接触用户机器, 无从获知.
替换成空串与官方行为一致 ---- 官方对 `toInject` 里没有的占位符也是 `() => ""`.

前端在编辑器上方列出全部 13 个占位符(能填的绿色, 取不到的灰色并在 tooltip 说明), 点一下插入到光标处.

## Alternatives considered

**自定义正文不做替换, 只让[照抄官方]模式有动态值.** 否决: 自定义模式正是用户要写
[今天几号 / 你叫什么]这类内容的地方; 那里没有动态值, 用户只能手写死日期 ---- 而这恰恰是
我们上一版刚修掉的缺陷.
**自己发明一套更短的语法(如 `{{date}}`).** 否决: 用户从官方模板里抄来的 `{CODEBUFF_*}`
会失效, 等于迫使他们记两套; 而且自造语法与官方形态不一致.
**把取不到的占位符原样留在文本里, 或替换成 `[unavailable]` 之类的标记.** 否决: 官方是替换成
空串, 留标记会让出站文本出现官方从不产出的字符串 ---- 又一处形态不一致.
**让用户自己去查有哪些占位符.** 否决: 编辑器上方直接列出来是零成本的事, 而且[取不到]这件事
必须让用户知道, 否则他写了 `{CODEBUFF_PROJECT_ROOT}` 却永远得到空, 只会以为是 bug.

## Consequences

- `cli-bridge/lib/system.ts` 导出 `PLACEHOLDER_NAMES` 与 `applyPlaceholders`;
  `renderWorkerSystem` 末尾统一过一遍占位符.
- `chat-payload.ts` 的 `custom` 分支改走 `applyPlaceholders`; 官方分支把用户消息一并传下去.
- `/api/settings` 暴露 `promptPlaceholders`(名字 + filled + 说明)供前端渲染说明块.
- 前端: 编辑器上方新增[可用占位符]折叠区, 芯片可点击插入.
- 测试: `system-prompt-dynamic` 扩到 27 断言(新增 9 条占位符判据, 含
  [取不到时必须变成空串且不得是字符串 undefined]).