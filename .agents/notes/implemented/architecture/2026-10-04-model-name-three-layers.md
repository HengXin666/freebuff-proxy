# Agent Note: 模型名只有三层(对外名称 / 内部映射 / 上游 key),中间不允许缓存层

Status: implemented

## Problem

模型名这条链路此前有**五处各自计算名称**,**两层缓存**,以及一处**死代码**,
导致用户连续撞到三个症状:

1. **冷启动必 400**:服务起来后第一个请求报
   `Model 'm-096e75164d' is not in this proxy's model list`(`model_not_allowed`).
   实测:冷启动立刻用目录 key 请求 = 400;等一次请求把目录抓完后再试 = 正常进入
   调度(返回额度类错误).同一个模型"一会儿能一会儿不能".
2. **清单里的名字请求时用不了**:`/v1/models` 给的是可读名,而客户端配的是
   目录 key,两者在"算不算合法模型"上口径不一致.
3. **测试对话的  永远标不出来**:前端按 `catalogId || displayName` 算 id,
   而后端 `id` 用的是 `displayName` —— 两边算出**不同的字符串**
   (实测后端 `id='MiMo 2.6 Flash'` 而 `catalogId='mimo/mimo-v2.5'`),比对必然落空.

根子是**没有单一真源**:
- 名称计算散在 6 处(`catalog-models.js` ×2,`web/api.js` ×1,`model.js` ×2,
  `dashboard/app.ts` ×1),规则字面相同(`displayName || key`)但各写各的实现;
- 白名单判定前挂了 60s 缓存(`catalogKeyCache`):冷启动时它缓存了**空数组**
  → 60 秒内所有模型都被判"不在白名单";
- 另有一个 60s 会话探测缓存 + 死函数 `probeUpstreamSessionCached()`,
  它会**主动打上游** GET /session —— 与零自动探测直接冲突,且无调用点.

## Decision

用户裁决(原文):

> 对外 (/v1/models || 前端), 永远只会展示模型名称 (DeepSeek V4.1)
> 内部 (永远只会把模型名称映射为模型id (mxxxx))
> 对上游 (永远只会把合法的内容进行传递,也就是映射后的)
> 不要搞那么复杂,只有这3个层没有傻逼缓存层.不要引入这些傻逼缓存.
> 所谓的缓存,只有在前端展示这个目录有哪些的时候才有! 而且我们这个也不叫缓存,这个叫持久化.

据此:

### 一,名称计算收成单一真源

新增 `src/model.ts` 的 `catalogDisplayName(row)`,规则 `displayName → key`
(displayName 缺失才回退 key,**绝不凭空编名字**;空行返回空串供调用方过滤).
所有出口改调它:`catalog-models.js`(清单),`web/api.js`(`/api/models/upstream`),
`dashboard/app.ts`( 标注).

`model.js` 里另两处 `displayName || id`(内置 catalog 条目 / 前端自定义条目)
**保持不变** —— 它们的 `id` 是 provider 口径或用户自填,语义不是目录行,
不是同一个函数.

### 二,删掉两层缓存

- **`catalogKeyCache`(60s)整个删除**:`catalogRows()` 是内存里的现成对象,
  遍历几十个元素没有 I/O,没有网络;为省这点遍历引入"过期/空值/时序"三类 bug
  不划算.现在每次直接读.
- **`sessionProbeCache`(60s)+ 死函数 `probeUpstreamSessionCached()` 删除**:
  它会主动打上游,且无调用点.白名单判定所需的模型 id 现在**全部来自本地**
  (目录行 / 内置 catalog / 前端自定义 / 隐藏表),拿不到就如实拒绝,
  不为判定而发上游请求.

### 三,冷启动改为[目录为空则先加载一次再判]

删缓存后暴露的真问题:目录是懒加载的,**启动后第一个请求**面对空目录 →
`catalogKeys` 为空 → 任何模型都 400.所以白名单判定前加一步:
**目录为空时先 `refreshCatalogs()` 再判一次**.

这与[零自动探测]不冲突:这条路径是**用户正在发真实请求**才走到,抓目录本就是
该请求必须的前置(admission 要用目录句柄).§20.3 禁止的是启动/导入/首访模型表
时空跑一次上游 —— 那是无请求驱动的流量.只在目录为空时做,正常路径零开销;
抓不到照旧拒绝,不猜模型.

## Alternatives considered

- **保留缓存,只修"空结果不缓存"** —— 第一版就是这么修的,**治不了根**:
  它把"缓存了空值"改成"不缓存空值",但冷启动那次仍然没有目录可查,
  模型照样被拒.真正的解法是**在正确的时机加载**,不是调整缓存策略.
- **把白名单放宽成"不认识的都放行"** —— 用户明确要求过:未知模型盲发上游会
  被标记异常行为,是免费反代被封的主要诱因.放宽等于把封号风险引回来.
- **cold start 时在启动流程里抓一次目录** —— 违反零自动探测(启动不许发上游
  请求).放在请求驱动的路径上才是合法的.
- **只改前端  的实现,不动后端口径** —— 两边口径不一致本身就是 bug 来源;
  必须由后端单一真源定义,前端引用同一规则.
- **把 `catalogId` 从清单里删掉** —— 它是 legacy 反查用的兼容字段(旧消费方
  读它),删了会断既有调用方;保留为**并列字段**,但不让它参与 id 计算.
- **引入前端目录缓存以"减少遍历"** —— 用户明确说前端那份叫**持久化**不叫缓存,
  且遍历成本可忽略.不做.

## Consequences

- **每次 chat 请求多一次 `catalogRows()` 遍历**(几十个元素的数组拼接).
  相对一次上游往返(数百毫秒)可忽略.
- **冷启动首个请求多一次目录抓取**(仅当目录为空时).这是它本来就该做的
  前置动作,不是额外探测.
- **`freebuff_key` 字段保留**:对外 `id` 是可读名,`freebuff_key` 并列透出
  服务端真值(调试与高级客户端用).**它不参与 id 计算**.
- **`modelIdsFromSession` 的 import 从 `proxy.js` 移除**(只被删掉的死函数用过),
  函数本身仍保留在 `model.js`(供测试与将来使用).
- **前端  标注口径变化**:从 `catalogId || displayName` 改为
  `displayName || key`,与后端一致 —— 这是修复,不是回归.

## Evidence

- 新增 `test/verify-model-name-chain.mjs`,已接入 `npm test`,27 条断言全绿.
  它按"两侧夹逼 + 反例"设计:出口侧断言 id 是可读名且不含 m-xxx;入口侧断言
  名称→key→名称**往返闭合**;反例侧断言不存在的名字/ key 不被放行,
  `blockPremium` 与 `hidden`(双口径)真生效 —— 防止"全放行"式假绿.
- 冷启动实测(`pkill` 后重启,第一个请求即发):
  ```
  model: m-096e75164d → code = no_available_account   （改前 = model_not_allowed 400）
  日志: model allowed after lazy catalog load  catalogRows: 13
  ```
- 三口径对照(同一账号,额度已耗尽,故放行后返回额度类码):
  | 输入 | code | 判据 |
  |---|---|---|
  | `m-096e75164d`(目录 key)| `no_available_account` | 放行  |
  | `Solar Pro 4`(可读名)| `no_available_account` | 放行  |
  | `NoSuchModel-xyz`(乱写)| `model_not_allowed` | 拒绝  |
- 前端口径不一致的实测证据:`/api/models/upstream` 返回
  `id='MiMo 2.6 Flash'` / `catalogId='mimo/mimo-v2.5'` / `key='m-00032eaeec'`
  三者互不相同,证实"两边算出不同 id".
- 门禁:typecheck 过;`npm test` 全绿(smoke + frontend smoke + 链路验证 +
  目录 13 条);`check:contract` 通过.
- 盲审:独立 agent(fresh 上下文)审计本次改动,见对话记录.

## Blind review findings(2026-10-04,独立盲审后返工)

盲审(fresh 上下文 agent,不知我的结论)找出 4 类问题,全部已修:

1. **漏删一层同类死缓存**:`src/web/api.ts` 的 `upstreamSessionCache`(60s) +
   `probeUpstreamSession()` + `probeUpstreamSessionFresh()`.独立复核确认
   `probeUpstreamSessionFresh` 全仓无调用者,`probeUpstreamSession` 只被前者调用
   → 该缓存**只被写,从不被读**(唯一读点在死函数里),
   `probeAllAccountsSession` 里那次写入是纯无用功.已整块删除.

2. **验证脚本里有 4 条重言式(假绿)**:首版"往返闭合"用同一个表达式构造正反
   两张 Map 再互查,恒等于 `f(f⁻¹(x)) === x` 的平凡形式.反向探针实证:
   把 `catalogDisplayName` 改成 `.toUpperCase()`(明显破坏 1:1)后,
   **这 4 条全绿**而其它断言红了.
   已重写为**调用生产映射**(`CatalogHolder.keyForName()` /
   `handleForModel()`),不再自建 Map.

3. **两处零覆盖**:首版脚本不 import `app-context.js`,所以把
   `resolveModelAlias` / `web/api.js` 的名称计算改坏**不会变红**.重写后
   "名称 → key → 句柄"整条链路都走生产代码,可证伪.

4. **note 数据与实测不符**:写"24 条断言"(实测 19 条),"名称散在 5 处"
   (实测含前端共 6 处).已按实测订正.

### 返工后的可证伪性实证

| 反向探针 | 结果 |
|---|---|
| A:`keyForName` 直接返回 null |  红 12 条 |
| B:`catalogDisplayName` 改成 key 优先 |  红 9 条 |
| 还原后 |  全绿(`diff` 与备份逐字节一致,无探针残留) |

### 仍待 YG 裁决的一项(盲审点出,我不擅自定)

`src/proxy.ts` 的[目录为空则先加载一次再判]引入了**请求驱动的目录抓取**.
盲审指出:`docs/reverse/20-upstream-endpoint-whitelist.md` 的允许清单里
(一键刷新 / 单账号检测 / 真正要发 chat)没有明文列这一项,须由 YG 裁决.

我的理由(供裁决参考):这条路径只在**用户正在发真实请求**时走到,而抓目录
本就是该请求的必要前置(admission 需要目录句柄);§20.3 禁止的是
启动/导入/首访模型表时空跑一次上游 —— 那是无请求驱动的流量.
