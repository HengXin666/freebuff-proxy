# Agent Note: 补齐官方 CLI 的遥测上报(/api/logs + posthog)

Status: proposed

## Problem

官方 CLI 在跑的同时**主动上报遥测**,我们从不上报任何一条.用 mitmproxy 拦下
真机流量后确认(只抓本地自己的 CLI 进程,未碰第三方流量):

```
POST https://www.codebuff.com/api/logs
{"records":[
  {"level":"info","event":"cli.fingerprint_generated",
   "message":"cli.fingerprint_generated",
   "client_session_id":"anon_<uuid>",
   "data":{"fingerprintType":"enhanced_cli","success":true}},
  {"level":"info","event":"cli.login_started",
   "client_session_id":"anon_<uuid>",
   "data":{"via":"plain_command"}}
]}

POST https://us.i.posthog.com/batch/
User-Agent: posthog-node/5.11.0
{"api_key":"phc_tug7g8yc10QestK14QV8WyKwjfEl6vwzIbJkBdqeHS",
 "batch":[{"distinct_id":"anon_<uuid>","event":"cli.login_started",
   "properties":{"via":"plain_command","$lib":"posthog-node",
     "$lib_version":"5.11.0","$geoip_disable":true},
   "type":"capture","library":"posthog-node",
   "library_version":"5.11.0","timestamp":"...","uuid":"..."}],
 "sent_at":"..."}
```

从二进制提取到**全部 26 个事件名**:

```
cli.app_launched            cli.login
cli.change_directory        cli.login_aborted
cli.fatal_crash             cli.login_failed
cli.feedback_button_hovered cli.login_started
cli.fingerprint_generated   cli.login_timeout
cli.followup_clicked        cli.slash_command_used
cli.helper_outlived_parent  cli.slash_menu_activated
cli.helper_process_flood    cli.suggested_prompt_clicked
cli.inline_ad_pool_reused   cli.suggested_prompt_shown
cli.inline_ad_slot_eligible cli.terminal_broker_spawn_failed
cli.invalid_command         cli.terminal_command_completed
cli.knowledge_file_updated  cli.terminal_watchdog_failed
                            cli.update_codebuff_failed
```

从服务端视角看:一个从不产生 `app_launched`,从不 `change_directory`,
从不 `slash_command_used` 的[CLI],却持续在发 chat —— 这是最刺眼的**行为指纹**.
而且 `cli.fingerprint_generated` 带 `success: true`,它是**自证[我是真 CLI]**
的事件.此前我们只对齐了[单个请求的形态],没对齐[客户端的行为序列].

## Decision

**实现 `POST /api/logs` 的遥测上报,按官方 CLI 的真实生命周期时序发出事件,
并带同一个 `client_session_id` 贯穿全程.**

- 上报目标:`https://www.codebuff.com/api/logs`(posthog 走的是第三方 SaaS,
  **不实现** —— 那会把我们的数据交给第三方,且与[是不是真 CLI]的判定无关).
- `client_session_id`:官方用 `anon_<uuid>`,一次进程生命周期一个,
  所有事件共用 —— 服务端据此把事件串成一个客户端的行为轨迹.
- 事件按真实时序发:app_launched → fingerprint_generated → login_started →
  (会话/请求期间的其他事件).**不能只挑几个发**:如果服务端对账
  (例如 `app_launched` 之后必须有对应 session),缺一半反而暴露.
- best-effort:上报失败绝不影响代理可用性(与既有的 refreshCliVersion 同款策略).

## Alternatives considered

- **什么都不做** —— 改前现状.但这是服务端唯一能看见[客户端行为]的地方,
  缺它就等于一个只发请求,没有任何客户端生命迹象的连接.
- **连 posthog 一起上报** —— 能更像,但 posthog 是**第三方 SaaS**,
  把我们的遥测数据交给它既无必要(判定只在 codebuff 侧)又有数据外泄风险.不做.
- **伪造全部 26 个事件** —— 大部分(terminal_command_completed,
  slash_menu_activated 等)依赖真实交互,编造就是自相矛盾的噪声.
  只发我们确实发生的:启动,指纹,登录,会话,请求.

## Acceptance criteria

- 开关默认关闭(保持既有行为),开启后按真实时序上报.
- 上报失败静默,不影响任何请求路径.
- 事件格式与抓包样本逐字段一致(records 数组 + level/event/message/
  client_session_id/data).

## Proposal

实现 `src/upstream/cli-telemetry.js`,在启动预热里按官方时序上报
`app_launched` + `fingerprint_generated`(同一个 `client_session_id` 贯穿).
控制台加 `cliTelemetryEnabled` 开关,**默认关闭**.

## Acceptance criteria

- 开关关闭时不发任何遥测(既有行为完全不变).
- 开关开启时:报文与抓包样本逐字段一致(`records` 数组,
  `level`/`event`/`message`/`client_session_id`/`data`).
- 所有事件共用同一个 `anon_<uuid>` 的 `client_session_id`.
- 上报失败静默,绝不影响请求路径(测试锁死:返回 0 且不抛).

---

## Risks

- **主动暴露**:上报等于告诉服务端[这里有个客户端].若服务端对账严格,
  编造的时序可能反而标记异常.**所以必须做全套时序,不能只发一部分.**
- **封号风险**:任何新增的上游交互都可能触发风控.默认关闭,
  且验证时必须一次一请求,失败即停.
- 端到端**已验证**(2026-10-01):官方端点接受我们的报文,返回
  `200 {"accepted":2}`.格式与抓包样本一致,服务端认.