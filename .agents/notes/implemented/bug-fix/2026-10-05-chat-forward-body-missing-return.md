# Agent Note: chat 出站请求体构造函数丢了 return

Status: implemented

受影响代码: `cli-bridge/lib/endpoints/chat-payload.ts`, `test/run.ts`,
`test/suites/entries/verify/chat-payload-contract.ts` (新增)

## Problem

远程部署 (`freebuff.woa.qzz.io`, commit 66b98e1) 上任何一次 `POST /v1/chat/completions`
都回 400 `{"message":"Invalid JSON in request body"}`, 与模型, 额度, 出口全都无关.

远程日志把链路钉死在 bun 那一跳:

```
chat forward model resolved  {outgoing: "fbm1.AAEAAUPu1EjJ..."}
official channel: rpc result {status: 400, ok: false, body: "{\"message\":\"Invalid JSON in request body\"}"}
upstream chat non-ok         {status: 400, body: "{\"message\":\"Invalid JSON in request body\"}"}
```

会话已 active, run 已 start, 句柄已算出, 唯独 chat 那一跳被上游判成非法 JSON.
`official channel` 没有打印 "rpc failed, falling back to legacy", 说明 bun 通道本身
跑通了, 400 是 bun 侧真实发出去并收回来的.

根因: `buildBody` 把请求体 JSON.stringify 出来赋给 `body`, 却没有 `return body`.
于是 `chat()` 里

```js
const body = buildBody({ row, metadata, outMessages, outTools, layer, stream });
...
const res = await fetch(url, { method: 'POST', headers: hdrs, body });
```

拿到的是 `undefined`, bun 的 fetch 把 undefined body 发成空体 POST
(实测 `content-length: 0`), 上游见到零字节请求体, 回的就是这句 400.

缺陷引入点可定位到 812d946 (2026-10-05 10:19, "建立拆分 + 修拆分回归"): 该提交把
原来内联在 `cli-bridge/upstream.mjs` `Bridge.chat` 里的工具, system, metadata, body,
headers 五段按职责切进 `chat-payload.mjs`, 切分时 `buildBody` 的 return 没跟着搬.
迁移提交 cf0b54d 只做改名, 未引入也未修复.

三道既有防线为何全漏:

1. `tsconfig.json` 的 include 只有 `src` 与 `bin` 两棵子树, `cli-bridge/` 整体不在
   类型检查范围内, 所以 `npm run typecheck` 对这个错完全无感.
2. `syntax` 门禁用 `tsc --noCheck`, 按设计只解析语法不做类型检查.
3. 此前没有任何测试真执行过 `buildBody`; verify 套件里与 cli-bridge 相关的只有
   `tool-name-mapping`, 而它是读源码做正则对账, 不跑函数.

## Decision

- `buildBody` 补回 `return body`.
- 新增 `test/suites/entries/verify/chat-payload-contract.ts`, 判据分四层且可证伪:
  纯函数层断言 buildBody 返回非空字符串, 字段层断言顶层七键齐全且 model 取目录句柄,
  同文件导出层覆盖 buildTools / buildSystemMessages / buildHeaders / extractMessageId,
  端到端层起一个本地 mock 上游, 让 bun 子进程用真实 buildBody 真出站, 断言请求体是
  合法 JSON 且拿到 HTTP 200.
- 该套件登记进 `test/run.ts` 的 SUITES, 随 `npm test` 一起跑.
- 端到端探针用异步 spawn, 不用 spawnSync. 理由见下.

## Alternatives considered

- **只补一个 return, 不加测试**. 最强理由: 改动最小, 一行修完, 风险最低. 否决原因:
  这正是 812d946 的形状 ---- 拆分把五段逻辑搬走时漏掉一条 return, 而当时全部既有
  验证都是绿的. 没有真执行过 buildBody 的判据, 同类漏搬下一次照样不会被发现, 而且
  症状伪装成"账号侧 400", 排障成本极高 (本次从报障到定位要翻远程日志 + 本地逐字复现).

- **把 `cli-bridge/**/*` 加进 tsconfig 的 include**. 最强理由: 一次改动让类型检查永久
  覆盖这条链路, 比手写断言更根本. 否决原因: 实测加上后 `npx tsc --noEmit` 从 0 条
  直接涨到 170 条错误 (全是 TS7006/TS7034/TS7053 这类隐式 any, 因为副仓库是照官方
  抓包写的 JS 风格代码). 要让 typecheck 变绿就必须给整个 cli-bridge 补类型标注,
  那是另一件事的规模, 会把一次缺陷修复变成一场重构.

- **端到端探针用 spawnSync**. 最强理由: 代码更短, 不用 Promise 包装. 否决原因:
  mock 上游跑在探针自己的进程里, 而 bun 子进程要回头连它. spawnSync 阻塞本进程
  事件循环, server 永远无法 accept, 双方互等, 实测 SIGTERM + ETIMEDOUT 且 stdout
  为空 ---- 探针会以"输出不是 JSON"的形式假红.

- **什么都不做, 靠既有 verify 套件兜底**. 最强理由: 仓库已有 6 个套件, 覆盖面看起来
  够. 否决原因: 实测这 6 个套件里没有任何一个执行过 chat 请求体的构造, 本次故障在
  它们全绿的情况下发生并上线.

## 影响

- 本次故障的症状与"账号/额度/出口问题"高度相似, 但根因是纯构造层缺陷. 排查时先看
  `official channel: rpc result` 那行的 body ---- 上游原文出现 "Invalid JSON in
  request body" 且模型句柄已正确解析时, 直接查请求体构造, 不要查账号.
- 本地验证: `chat-payload-contract` 17 条断言绿; 临时删掉 return 后该套件 exit 1
  (断言信息 `buildBody 必须返回值(got undefined)`), 还原后 exit 0.
- 现有部署需重新构建镜像才能生效 (缺陷在代码里, 不在配置里).
