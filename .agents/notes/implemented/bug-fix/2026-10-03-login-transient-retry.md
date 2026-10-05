# Agent Note: 无代理部署下登录请求没有回落,需要自己补一次瞬时重试

Status: implemented

## Problem

`POST /api/auth/cli/code` 偶发失败,前台显示[发起登录失败: This operation was
aborted]——`AbortError` 的原文,用户无法判断是超时,DNS 还是 TLS.实测同一台机器
连续三次调用耗时 7.4s / 4.2s / 4.9s,而 `loginCode` 的超时是 **15s**:慢机器上
一次网络抖动就足以把它顶穿.

关键不在超时本身,而在于**这次失败没有任何第二次机会**:

- `buildFetchWithProxy`(`src/upstream/client.ts`)里,代理池回落 + 单次尝试超时
  (`fetchWithAttemptTimeout`)**只存在于 `kind === 'pool'` 分支**.
- `resolveProxy` 在[无显式代理 + 无环境变量]时返回 `kind: 'none'`,于是
  `fetchWithProxy` 走 `proxyRes.kind !== 'pool'` 的提前 `return`,直接裸 fetch,
  **零回落**.
- 而[代理设置留空]恰恰是官方推荐的**家庭部署**形态(家庭宽带本身就是住宅出口,
  不需要代理).也就是说:最推荐的配置 = 唯一没有回落保护的配置.

`loginStatus` 同理,且它每 4s 被轮询一次,一次失败就丢一轮授权状态.

## Decision

**登录类请求自带一次瞬时故障重试,并把超时/网络失败翻译成带原因码的 `UpstreamError`.**

在 `createUpstreamClient` 内新增 `fetchLoginUpstream(url, init, label)`,
`loginCode` / `loginStatus` 改走它:

- 重试**仅**针对瞬时错误:`AbortError`(超时),`TypeError`(undici `fetch failed`),
  `ECONNRESET` / `ETIMEDOUT` / `EAI_AGAIN` / `ENOTFOUND` / `ECONNREFUSED` / `EPIPE`;
- 最多 2 次(即重试一次),**同代理**,不引入换出口语义;
- 非瞬时错误(4xx/5xx 走 `UpstreamError`)**不重试**;
- 最终失败时:超时 → `code:'upstream_timeout'` 并写明实际毫秒数;
  网络层 → `code:'upstream_network'`,都带上底层 message.

   `code` **必须是稳定的业务码**,不能透 Node 底层码(曾写成
  `code: lastErr.code ?? 'upstream_network'`,实测透出 `ECONNREFUSED`).
  本仓的 `code` 是业务判据:`SLOT_BUSY_CODES` / `UNAVAILABLE_COOLDOWN_CODES` /
  `EXHAUST_CODES` 等多处按集合匹配,裸 socket 码会带来误命中风险.
  底层码仍可见 —— 放在 message 里.

不改 `timeoutMs: 15_000`.超时本身是有意且有注释的(裸 fetch 遇到 freebuff.com
波动会永远挂起,泄漏 socket 直到服务被拖死),调大它治不了[零回落].

## 为什么这样做是安全的

`loginCode` 只是向 freebuff.com 换一个授权码,`loginStatus` 是只读轮询:两者都
**不 admit 会话,不消耗 Freebucks,不动账号账本**.重试与池内换代理在额度上的
代价完全相同——都是零.因此这里补的重试没有引入任何新的计费风险.

## Alternatives considered

**什么都不做 / 复用现有(被否决,最强理由在前)**:池内回落已经存在,理论上让用户
配一个代理池就够了.这个理由成立——配了池子就有回落.但它把一个[上游抖动]
转嫁成[用户必须先理解代理池,且必须去配一个他根本不需要的代理]才能登录.
loginCode 只花一次授权码,零额度,让正确路径自带韧性比要求用户绕路更合理.
而且这个 bug 恰好只打推荐配置,打的是最不该被打的那条路.

**把 `timeoutMs` 调大(比如 30s)**:最省事,也确实降低触发率.但它只是把概率往后推,
网络真正黑洞时用户等更久,且 15s 超时本就是为防 socket 泄漏而特意加的
(见 `loginStatus` 上方注释).治标不治本,还牺牲了原有的防护.

**让 `loginCode` 也走 `kind:'none'` 下的 `fetchWithAttemptTimeout`**:与 pool 分支
的语义更一致,但那是改 `buildFetchWithProxy` 的公共行为,会影响**所有**调用方
(含 chat 主链路).为一个登录端点去动计费主链路的取数语义,风险不对等.

**改用 `config.limits.upstreamTimeoutSec` 派生登录超时**:更自洽(当前硬编码 15s
直接覆盖了用户可配的 `upstream_timeout_sec`,默认 600).但登录是交互式前台操作,
600s 的超时会让[发起登录失败]变成[发起登录卡 10 分钟],体验更糟.故保持 15s
不动,仅记录该不一致.

## Consequences

**对用户**:登录/注册不再因为一次网络抖动就报[发起登录失败: This operation was
aborted].失败时如果重试也没成功,现在给出的是可判断的信息——`upstream_timeout`
(附实际毫秒数)或 `upstream_network`——而不是 AbortError 原文.

**对调度与额度**:无变化.没有新增 admit,没有新增换号,账号账本字段一个没动.
`fetchLoginUpstream` 只包住两个**零额度**的调用.

**新增的日志**:瞬时故障重试会打一条 `login upstream transient failure; retrying
same route`(带 label 与 attempt).排查登录抖动时可以直接看这行——之前这类失败
在日志里完全不可见,前台只给一句 AbortError.

**性能**:最坏情况登录耗时从 15s 变成 30s(两次 15s).对交互式登录可接受,且只在
第一次真的超时时才发生.

**错误契约(三层,各司其职)**:

- `code` —— **稳定的业务码**(`upstream_timeout` / `upstream_network`).
  不透 Node 底层码:本仓多处按集合匹配 `code`(`SLOT_BUSY_CODES` /
  `UNAVAILABLE_COOLDOWN_CODES` / `EXHAUST_CODES`),裸 socket 码有误命中风险.
- `cause` —— **底层原始错误码**(`ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT` /
  `timeout`).为它扩展了 `UpstreamError` 的 extra(原为闭集 status/code/body/
  retryAfterMs/fatal,不扩展会被静默丢弃).
- `message` —— 给人看,内含底层码(如 `…（ECONNREFUSED）`).

三层都**传到前端**:后端 `/api/accounts/login` 的 502 响应带 `code` 与 `cause`;
前端 `api()` 把两者挂到 error 上(此前只传 `error` 字符串,前端想区分故障类型
只能解析中文文案,文案一改就崩).前端登录失败弹窗据此显示
message + `cause:` 行 + 按 `code` 的可操作引导(新增两条 i18n 文案).

**回归防线**:`test/smoke.mjs` 新增登录链路用例,钉三件事——重试只发生一次,
`code` 是稳定业务码,`cause` 保留底层码.反向探针:把 `code` 改回裸码后该用例
红灯(报 `code 应为稳定业务码, got ECONNREFUSED`),还原即绿.此前 smoke **完全没有**
登录链路的测试,这正是该缺陷当初能溜过去的原因.

**留下的债(本次不修,已在 issue #22 里记录)**:

1. 硬编码的 `timeoutMs: 15_000` 仍然覆盖 `config.limits.upstreamTimeoutSec`.
   用户改 `upstream_timeout_sec`(默认 600)对登录链路仍然无效.倾向于改成独立
   可配项,而不是直接套 600s——登录是交互式前台操作,600s 会让[发起登录失败]
   变成[发起登录卡 10 分钟].
2. `kind:'none'`(无代理部署)下 chat / admit 链路看起来同样没有池内回落.但复核
   后确认**不是同一个问题**:`src/proxy.ts` 已有 `maxAutoRetryOnSessionError`
   (同账号重试)与 `maxAttempts = min(账号数+1, 5)`(换号),且整条路径受
   `maxNewSessionsPerRequest` 闸门约束,所以瞬时抖动已被调度层兜住.缺的只是
   [换出口],在无代理部署下本就没有出口可换.**结论:不作为独立缺陷跟进.**
3. `test/smoke.mjs:914` 的 `unauthorized` → 429 是**本机环境**导致(shell 导出了
   `HTTP_PROXY`/`HTTPS_PROXY`,smoke 测试的请求被带进本地中继),不是仓库问题.
   `env -u HTTP_PROXY -u HTTPS_PROXY npm test` 通过,upstream `main` CI 也是绿的.