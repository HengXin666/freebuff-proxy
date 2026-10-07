# Agent Note: 上游出网统一到一个出口(所有请求必须经同一接口)

Status: implemented

受影响代码: `src/upstream/client/egress/{resolve,index}.ts`(新增),
`src/upstream/client/{transport,factory,bun-channel,endpoints/misc}.ts`,
`cli-bridge/lib/wire/egress.ts`(新增), `cli-bridge/lib/{upstream/bridge,endpoints/*}.ts`,
`src/catalog/runtime-sync.ts`, `src/upstream/fingerprint/cli-version.ts`,
`src/upstream/telemetry/cli-telemetry.ts`, `src/upstream/catalog/holder-base.ts`,
`scripts/gates/checks/guard/egress.ts`(新增门禁)

## Problem

用户要求: 封装 1 个统一的请求接口, 默认使用[代理池里的内容]以及[账号里的代理],
否则才走直连; [所有上游请求接口必须经由它].

动手前实测(本地假上游 + 本地假代理, 单变量对照)发现的真实缺口:

1. [bun 通道完全绕过代理.] 主服务默认启用 bun 通道(cli-bridge)承载 catalog /
 session / admit / chat / device-keys 等跳. 那些跳在 bun 子进程里直接调全局
 `fetch`, 而 bun 只认 `HTTP(S)_PROXY` 环境变量 ---- [读不到控制台里的代理池]
 (它在 `/data/proxies.json`, 只有 Node 侧解析得到).
 实测: 控制台配好代理池,env 清空时, 上游直连命中 `models / device-keys / session`
 三次, 代理命中 [0 次]; 同一配置加 `FREEBUFF_DISABLE_BUN=1` 后, 直连 0 次,
 代理 3 次. 也就是说"配了代理"与"真的走代理"之间隔着一个运行时开关.
 这正是 issue #5 的 `session_model_mismatch` 根因: 上游拿到宿主真实出口 IP.

2. [三条旁路出网全是直连.] catalog 自动同步(拉 GitHub 常量),CLI 版本对齐
 (npm registry),CLI 遥测上报(codebuff /api/logs)都各自调 `globalThis.fetch`,
 完全不看代理配置. 仓库里早有一个 `createProxyFetch` 专为这类旁路准备
 (注释里写明"避免旁路直连"), 但它[全仓零调用者] ---- 一个从未接上的接口.

3. [出口判据散落.] 代理解析(`resolveProxy`)与出网 agent 构造在 `transport.ts`,
 而 `/api/proxy/test` 又自己 `new ProxyAgent` 一份. 谁都能再写一个"我的出口".

## Decision

[一个出口真源 + 一个请求入口, 两条传输通道共用同一份判据.]

### 1) 判据真源下沉到 `egress/resolve.ts`

代理解析(优先级 / 协议校验 / 池内稳定哈希分发 / ALPN)从 `transport.ts` 整体搬进
`src/upstream/client/egress/resolve.ts`, 并显式带上 `source`(account / pool /
single / env / none). `transport.ts` 缩成"怎么发, 坏了换谁", 不再回答"从哪个出口出".

优先级不变: 账号显式 `proxy` > 全局池 `upstream.proxies` > `upstream.proxy` >
`HTTP(S)_PROXY` > 直连. [只有全空才直连] ---- 这是用户要的默认语义.

### 2) 唯一请求入口 `createEgress(...)`

返回 `{ fetch, proxyUrl, bunEligible, bunProxy, resolution }`. 全进程只有这一个
入口; `createUpstreamClient` 经它拿 `fetch`, 三条旁路经它拿 `fetch`.

### 3) bun 通道: 出口下传, 而不是让它自己猜

Node 侧把本次生效的出口经 RPC `cfg.proxy` 传给 cli-bridge, bun 侧新增
`wire/egress.ts` 的 `egressFetch(cfg, url, init)` 作为[唯一发出口], 各端点
(`reads` / `session` / `chat`)一律改为 `bridge.egressFetch(...)`.

两条语义分界(实测确定, 不是猜的):
- [配置里写的出口](account / pool / single)一律显式传给 bun 的 `proxy` 参数 ---
 它优先于 `NO_PROXY`, 与 Node 侧 `ProxyAgent` 行为一致;
- [env 出口]返回 `null` --- 让 bun 自己读环境变量, 从而保留 `NO_PROXY` 语义
 (`EnvHttpProxyAgent` 同样遵守 `NO_PROXY`, 两侧判据因此一致).

### 4) bun 承载不了的出口留在 Node, 绝不直连

实测: bun 对 `socks5://` / `socks://` 一律抛 `UnsupportedProxyProtocol`(env 与
`proxy` 两个入口都是), 而 undici 的 SOCKS5 支持已实测可用(握手走到 CONNECT 阶段).
因此 `bunEligible = bunCanUseProxy(url)` 为假时, 四条 bun 通道全部提前返回 null /
fallback, 把那一跳交回 Node 执行.

这条是刻意的: ["bun 用不了"绝不能退化成"直连"] ---- 那等于悄悄把出口 IP 交出去.
同理, `CatalogHolder` 里 `opts.fetchImpl || globalThis.fetch` 的直连兜底也删掉了,
改成显式抛错(`missingEgressFetch`): 少传传输实现是装配错误, 必须看得见.

### 5) 新门禁 `guard/egress` 让绕过无法回归

扫 `src/` 与 `cli-bridge/`, 拦三类: 裸 `fetch` / `globalThis.fetch` / `undiciFetch`,
直接 `new ProxyAgent` / `EnvHttpProxyAgent`, 以及真源被删或被掏空(反向断言).
豁免表逐条登记理由(出口实现自身 / transport 的最后一跳 / bun 侧出口 /
`/api/proxy/test` ---- 它测的就是用户当场填的代理地址, 构造 agent 是被测对象).

判据只作用于[真正的调用]: 先剥注释, 再排除方法定义(`async fetch(opts) {}`)
与对象方法(`holder.fetch(...)`). 已用四种真实绕过形态验证它变红
(箭头里的裸 fetch / await 裸 fetch / `globalThis.fetch` / 直造 agent),
以及"对象方法不误报"这条反向判据.

### 6) 官方 chat 那一跳也必须带出口(盲审补丁)

第一版实现漏了这条: `buildRpcCfg` 从不设 `proxy`, 而官方 chat(默认通道)走的正是
它生成的 cfg.当时只有 bun-channel 的四条通道设了出口, 于是出现
[同进程两个出口]: session/catalog 走代理, chat 走宿主 IP ---- 上游看到的正是后者,
与 issue #5 完全同形.已在 `buildRpcCfg` 里从 `upstream.egress.bunProxy` 取出口,
并加回归断言(配池/单代理/未配三种情形), 实测破坏该行断言即变红.

另外 `egress` 原先没暴露到客户端对象上, chat 支路根本无从取得出口 ---- 一并补上.

## Alternatives considered

- [什么都不做, 只在文档里写明"bun 通道不走代理".] 最强理由: 零代码风险,
 且 bun 通道是官方形态对齐的关键, 动它有回归风险. 否决原因: 空口文档挡不住
 一次"配了代理却暴露真实 IP"的封号, 而本仓已经因为这个丢过账号(issue #5);
 用户的诉求就是"配了代理就必须走代理", 没有"除了某条通道"的例外.

- [让 bun 侧自己读主服务的代理配置(共享 /data/proxies.json).] 最强原因:
 不用改 RPC 契约, 两条通道各自解析. 否决原因: 代理池的分配是[账号级]的
 (稳定哈希: 同账号固定出口, 保持 session IP 稳定), bun 侧拿不到"这次是哪个账号",
 要么重算一遍哈希(等于第二处真源, 必然漂移), 要么退化成"随便挑一个"(破坏 IP 稳定性).
 下传本次[已解析好的]出口, 是唯一能同时满足这两条的形态.

- [统一走 Node, 关掉 bun 通道.] 最强理由: 出口立刻 100% 受控, 改动最小.
 否决原因: bun 通道存在的理由是[请求形态与官方客户端逐字节一致](Node 的
 fetch 会强制带 `accept-language` / `sec-fetch-mode`, 后者是 forbidden header
 设不掉). 关掉它等于放弃形态一致性, 会把"代理对了但被封"换成另一个问题.
 正确做法是两条通道共用同一份出口判据, 而不是砍掉一条.

- [在 bun 侧给 socks 加一个 socks 客户端(自己实现握手).] 最强理由: 让
 socks5 在两条通道上都可用, 行为最统一. 否决原因: 那是新写一个代理协议栈
 (无新依赖的前提下几十上百行, 且要处理认证/超时/回落), 而收益只是"让 bun 也能
 走 socks". 把 socks 出口留给 Node 执行等价且零风险 ---- 出口正确性不受影响.

- [保留 `createProxyFetch` 作为旁路专用接口, 只把它接上.] 最强理由: 那个函数
 本来就是为旁路写的, 接上即可, 改动面更小. 否决原因: 那就是第二个入口,
 而"出口判据有两处"正是这次要消灭的东西; 现在它与 `createEgress` 是同一个
 实现, 旁路与上游共用一份, 不存在漂移面.

## Consequences

- 出口优先级语义不变(账号 > 池 > 单代理 > env > 直连), 但[生效范围]从
 "只有 Node 侧"扩大到"Node 侧 + bun 侧 + 三条旁路出网".
- socks5/socks 出口: 由"Node 侧走代理,bun 侧静默直连"改为"全进程统一在
 Node 侧走代理".
- 门禁从 17 条增到 18 条; `egress` 归入 pre-commit.
- 删除 `createProxyFetch` 导出(职责并入 `createEgress`); 其唯一调用者(测试)
 已同步改到新入口.
