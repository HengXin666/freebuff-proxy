# 文档索引与真源声明

> 最后核对: 2026-10-05 . 对应代码: 94902a4
> 这个文件是**文档的入口**:回答"某个主题该看哪个文件",并声明**每份文档的唯一真源地位**.
> 它由门禁 `scripts/gates/checks/doc/check-docs.ts` 对账(端点 / 路径引用 / 真源唯一性 / 索引链接与反向覆盖).

## 一,目录结构(2026-10-05 分类)

```
docs/
├── README.md        本文件：索引 + 真源声明（唯一入口）
├── guide/           面向使用者：装、配、用、排障
├── design/          内部口径：调度 / 计费 / 对外 API
├── quality/         工程质量：全景 + 审计记录（门禁刻意不扫）
├── research/        调研：结论性、建议未采纳
├── reverse/         协议逆向 + 抓包一手证据（门禁刻意不扫）
├── evidence/        退款复测原始日志（不得删除）
└── images/          README 截图产物（webp）
```

## 二,文档规范(三条硬约定)

1. **每份文档头部带一行核对标记**,紧跟标题的引用块里:
   `> 最后核对: YYYY-MM-DD · 对应代码: <提交短哈希或版本>`
   它是"这份文档被对过账"的凭据.改文档内容时**一并更新**它;只改标点不必动.
2. **每个主题只有一个真源**,并在该文件里用一行 `> 真源: <主题key>` 声明.
   门禁会拒绝"两份文档声明同一个主题 key".其他文件提到该主题时**只链接,不复述结论**.
3. **路径引用纪律**:文档里出现 `src/...` `docs/...` `scripts/...` 这类
   反引号包裹的本仓路径时,门禁会校验它**真实存在**.引用上游文件(`common/src/...`,
   `orchestrator`)**不要**写成仓库相对路径形态,否则会被判为悬空引用.

## 三,想了解 X,看哪个文件

### 使用者(`docs/guide/`)

| 想知道 | 看这个 | 主题 key |
|---|---|---|
| 一键部署,`/data` 里有什么,怎么升级 | [guide/deployment.md](guide/deployment.md) | `deployment` |
| 控制台怎么登录 / 加账号 / 管用户与 Key | [guide/web-console.md](guide/web-console.md) | `web-console` |
| 每一行配置项的唯一来源 | [guide/configuration.md](guide/configuration.md) | `configuration` |
| 全局代理池,出口分配,代理连通性测试 | [guide/proxy.md](guide/proxy.md) | `proxy` |
| 幽灵连接,断开释放,重启兜底 | [guide/connection-health.md](guide/connection-health.md) | `connection-health` |
| 本地命令,发版流程 | [guide/development.md](guide/development.md) | `development` |
| README 那四张截图怎么生成,怎么复现 | [guide/screenshots.md](guide/screenshots.md) | `screenshots` |

### 内部口径(`docs/design/`)

| 想知道 | 看这个 | 主题 key |
|---|---|---|
| 多账号池调度 / 额度口径 / 额度保护 | [design/scheduling.md](design/scheduling.md) | `scheduling` |
| 调度与归还点数的**调研过程与纠错史** | [design/account-scheduling-and-refund.md](design/account-scheduling-and-refund.md) | `scheduling-research` |
| 下游 Agent 接入与全部本仓路由 | [design/api.md](design/api.md) | `api` |
| Freebucks 计费策略**图解**(可视化版) | [design/freebucks-strategy.html](design/freebucks-strategy.html) | *(从属 `scheduling`:口径正文真源是 `design/scheduling.md`,本 HTML 只是它的图解)* |

### 工程质量(`docs/quality/`)

| 想知道 | 看这个 | 主题 key |
|---|---|---|
| 代码质量现状全景(现状口径) | [quality/code-quality-landscape.md](quality/code-quality-landscape.md) | `code-quality-landscape` |
| 一轮文档整理的取证与淘汰决策 | [quality/docs-audit.md](quality/docs-audit.md) | *(审计记录,会故意引用错误说法作反例)* |

### 调研(`docs/research/`)

| 想知道 | 看这个 | 主题 key |
|---|---|---|
| 图片输入可行性调研(**建议未采纳**) | [research/multimodal-image-input.md](research/multimodal-image-input.md) | `multimodal-research` |

### 协议逆向(`docs/reverse/`)

| 想知道 | 看这个 | 主题 key |
|---|---|---|
| 官方客户端一次带工具的对话做了什么(L0 总览) | [reverse/00-overview.md](reverse/00-overview.md) | `reverse-overview` |
| 运行时与产物:源码从哪来,登录态在哪 | [reverse/01-runtime-and-artifacts.md](reverse/01-runtime-and-artifacts.md) | |
| 设备签名逐字常量,6 行载荷,两处易错点 | [reverse/02-device-signing.md](reverse/02-device-signing.md) | **设备签名唯一真源** |
| 会话建立(admission)实测与坑位 | [reverse/03-session-admission.md](reverse/03-session-admission.md) | |
| 对话与工具调用 | [reverse/04-chat-and-tools.md](reverse/04-chat-and-tools.md) | |
| 思考强度枚举 | [reverse/05-thinking-effort.md](reverse/05-thinking-effort.md) | |
| 封禁实证 | [reverse/06-ban-forensics.md](reverse/06-ban-forensics.md) | |
| 503 真因 = 每模型每日会话额度 | [reverse/07-503-root-cause.md](reverse/07-503-root-cause.md) | |
| 第二次封禁(BYOK 否决依据) | [reverse/08-second-ban-and-byok.md](reverse/08-second-ban-and-byok.md) | |
| 第三方实现考究(拒采理由) | [reverse/09-third-party-review.md](reverse/09-third-party-review.md) | |
| 第三方实现考究(拒采理由) | [reverse/10-third-party-lza6.md](reverse/10-third-party-lza6.md) | |
| TLS 指纹实证(Node vs 官方 bun) | [reverse/11-tls-fingerprint.md](reverse/11-tls-fingerprint.md) | |
| 428 waiting_room 真因 | [reverse/12-waiting-room-slot-contention.md](reverse/12-waiting-room-slot-contention.md) | |
| 纯 UI 侦查(零协议请求) | [reverse/13-client-ui-recon.md](reverse/13-client-ui-recon.md) | |
| 抓包逐字段 diff | [reverse/14-captured-diff.md](reverse/14-captured-diff.md) | |
| 协议复核(**P0 清单已过时,见文首作废头**) | [reverse/15-protocol-review.md](reverse/15-protocol-review.md) | |
| 首次 200 + 工具调用达成 | [reverse/16-success-200-with-toolcall.md](reverse/16-success-200-with-toolcall.md) | |
| 现状盘点(**历史快照,文首有 4 条更正**) | [reverse/17-current-status-and-gaps.md](reverse/17-current-status-and-gaps.md) | |
| 两条链路选型与工具转换(**面向使用者**) | [reverse/18-channel-guide-and-tool-mapping.md](reverse/18-channel-guide-and-tool-mapping.md) | |
| 模型列表的唯一真源是[目录] | [reverse/19-catalog-is-the-model-list.md](reverse/19-catalog-is-the-model-list.md) | |
| 上游端点白名单:只有客户端发过的才准用 | [reverse/20-upstream-endpoint-whitelist.md](reverse/20-upstream-endpoint-whitelist.md) | |
| **对照唯一真源**:客户端请求全表 / 顺序 / 头集 | [reverse/21-client-request-reference.md](reverse/21-client-request-reference.md) | |
| 抓包归档(一手证据,只增不改) | [reverse/captures/README.md](reverse/captures/README.md) | |
| 自动生成的抓包摘要(**勿手改**,脚本产出) | [reverse/captures/CAPTURE-SUMMARY.md](reverse/captures/CAPTURE-SUMMARY.md) | |

> **`15` 与 `17` 是历史快照**:文首都已加显式作废/更正头.读它们是为了看"当时怎么判的,
> 错在哪",**不是**操作依据 ---- 现行口径一律以 `21` 为准.
>
> `docs/reverse/**` 描述的是 **Freebuff 上游**的行为与端点(`/api/v1/*`,`/api/chat/*`),
> **不是本仓注册的路由**.因此 `check-docs` 不扫这个目录(否则每个上游端点都会被判"没在代码里注册"),
> 里面的 `orchestrator` / `common/src/...` 也是**上游仓库**的路径,不参与"本仓路径必须存在"判据.
> 该目录里的**机器生成快照**(`docs/reverse/upstream-contract.json` 等)各有独立门禁对账
> (`contract` / `response-contract` 组),不要在别处手工编辑.

### 实证留档(`docs/evidence/`)---- 不得删除

| 文件 | 作用 |
|---|---|
| [evidence/README.md](evidence/README.md) | 退款复测原始日志的**实验设计与结论强度**说明 |
| `evidence/refund-*.jsonl` / `evidence/ledger-session-units-vs-freebucks.json` | 支撑/证伪[早退是否退还 Freebucks]的一手原始数据 |

这些是**结论可追溯的根**:退款口径已经反复三次,下一次想改这个结论的人必须能读到当时的原始数据.

### 快速上手

想直接跑起来,看仓库根的 [README.md](../README.md)(docker compose 一键 + 三步接入).

## 四,常见误配(都已误导过至少一份文档,写在这里防复发)

1. **`upstream.api_base` 写了不生效 ---- 它是硬编码的.**
   真源 = `src/config.ts` 的 `UPSTREAM_API_BASE`(`https://www.codebuff.com`),
   `loadConfig()` 在 `src/config.ts:381-383` **无条件覆盖**配置文件里的值.
   唯一可覆盖口 = 环境变量 `FREEBUFF_UPSTREAM_API_BASE`(仅供本地镜像对照 / 离线契约测试).
   误配原型:`docs/guide/configuration.md`,`docs/guide/screenshots.md`,`docs/reverse/21` 都曾教人改
   `api_base` 去指向 mock 上游 ---- 那条路**走不通**.
2. **`config.yaml` 里的上游代理只是兜底**,日常入口是控制台[代理设置]→ `/data/proxies.json`.
3. **不要把旧结论"简化"回来**:Freebucks 早退**拿不回**(付费时段内不释放).
   一手实测见 [design/account-scheduling-and-refund.md §3](design/account-scheduling-and-refund.md) 与
   `.agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md`.

## 五,引用纪律:note 与文档互相引用走**文档路径**

`.agents/notes/**`(决策记录)与本文档集互相引用时,**指向文档路径**,不要指向实现文件的
内部常量或行号 ---- 源码会随重构移动(`src/` 已按职责拆到子目录),文档路径不会.

同样地,**本文档集不重复决策内容**:决策与"否决过什么"记在 `.agents/notes/`,
本文档集只描述**现状**.两者分工见 [quality/code-quality-landscape.md](quality/code-quality-landscape.md).

## 六,淘汰记录

2026-10-05 一轮淘汰(证据见 [quality/docs-audit.md](quality/docs-audit.md)):

- **删除** `protocol-implementation-status.md` ---- 它声称一个上游 adapter 文件[已创建],
  而该文件从未存在(`git log --all -- src/upstream/client-headers.js` 为空);其"待补齐项"也全部已实现.
  替代:本文件 + [reverse/02-device-signing.md](reverse/02-device-signing.md).
  (被引用而实际不存在的路径,完整名字与取证见 [quality/docs-audit.md](quality/docs-audit.md) §2.6.)
- **删除** `freebuff-desktop-protocol-reverse.md` ---- "缺失(导致被识别为第三方客户端)"整节已不成立.
  替代:[reverse/02-device-signing.md](reverse/02-device-signing.md).
- **删除** 仓库根 `REVERSE_ENGINEERING_SUMMARY.md` ---- 三处硬事实错误(签名头名 / 载荷字段数 /
  CLI 版本号),且早已被 `.gitignore` 声明不该入库.替代:[reverse/02-device-signing.md](reverse/02-device-signing.md).

2026-10-05 一轮**归类**(不改内容,只搬家;引用同步见 [quality/docs-audit.md](quality/docs-audit.md)):

- `deployment` / `configuration` / `proxy` / `web-console` / `connection-health` / `development`
  / `screenshots` → `docs/guide/`.
- `scheduling` / `account-scheduling-and-refund` / `api` / `freebucks-strategy.html` → `docs/design/`.
- `code-quality-landscape` 与 `docs-audit` → `docs/quality/`(`docs/code-quality/` 目录撤销).
- `multimodal-image-input` → `docs/research/`.

>  **独立盲审推翻了"已完整取代"这个说法,两项独有内容已捡回**(2026-10-05):
> 1. **本地进程隔离头**(`x-freebuff-launch-id` + HttpOnly cookie `freebuff_launch_{port}`)----
>    原只记在 `freebuff-desktop-protocol-reverse.md` 里,全仓实测无其他出处.
>    已捡回 [reverse/00-overview.md](reverse/00-overview.md)("哪些头属于本地进程,哪些才是上游判据"的边界知识).
> 2. **访问层级 Access Tiers 语义**(`full` / `limited` + `ipPrivacySignals` 样例)----
>    原只记在根 `REVERSE_ENGINEERING_SUMMARY.md` 里,文档侧已无定义(只剩裸值 `"limited"`).
>    已捡回 [reverse/00-overview.md](reverse/00-overview.md).
>    (另:`DEFAULT_WAIT_MS=3000` / 404-405 走 1 小时退避 ---- 经复核**代码里不存在**,
>    属于被删文档的编造,**不捡回**;见 [quality/docs-audit.md](quality/docs-audit.md) §3.6.)
