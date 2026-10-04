# 文档索引与真源声明

> 最后核对: 2026-10-05 · 对应代码: 3a8aebb
> 这个文件是**文档的入口**：回答"某个主题该看哪个文件"，并声明**每份文档的唯一真源地位**。
> 它由门禁 `scripts/gates/checks/doc/check-docs.mjs` 对账（端点 / 路径引用 / 真源唯一性 / 索引链接）。

## 一、文档规范（三条硬约定）

1. **每份文档头部带一行核对标记**，紧跟标题的引用块里：
   `> 最后核对: YYYY-MM-DD · 对应代码: <提交短哈希或版本>`
   它是"这份文档被对过账"的凭据。改文档内容时**一并更新**它；只改标点不必动。
2. **每个主题只有一个真源**，并在该文件里用一行 `> 真源: <主题key>` 声明。
   门禁会拒绝"两份文档声明同一个主题 key"。其他文件提到该主题时**只链接、不复述结论**。
3. **路径引用纪律**：文档里出现 `` `src/...` `` / `` `docs/...` `` / `` `scripts/...` `` 这类
   反引号包裹的本仓路径时，门禁会校验它**真实存在**。引用上游文件（`common/src/...`、
   `orchestrator.js`）**不要**写成仓库相对路径形态，否则会被判为悬空引用。

## 二、真源地图（按主题）

| 主题 | 真源文件 | 主题 key |
|---|---|---|
| 快速上手 / 部署三步 | [../README.md](../README.md) | *(无 key：它不在 `docs/` 下，见下方说明)* |
| `/data` 持久化与升级排障 | [deployment.md](deployment.md) | `deployment` |
| Web 控制台（登录 / 用户 / 加账号） | [web-console.md](web-console.md) | `web-console` |
| 全局代理池与出口分配 | [proxy.md](proxy.md) | `proxy` |
| 多账号池调度 / 额度口径 / 额度保护 | [scheduling.md](scheduling.md) | `scheduling` |
| 调度与归还点数的**调研过程与纠错史** | [account-scheduling-and-refund.md](account-scheduling-and-refund.md) | `scheduling-research` |
| 下游 Agent 接入与全部本仓路由 | [api.md](api.md) | `api` |
| 配置项唯一来源总表 | [configuration.md](configuration.md) | `configuration` |
| 幽灵连接治理 / 断开释放 / 重启兜底 | [connection-health.md](connection-health.md) | `connection-health` |
| 本地命令与发版流程 | [development.md](development.md) | `development` |
| README 截图生成与复现 | [screenshots.md](screenshots.md) | `screenshots` |
| Freebucks 计费策略**图解**（可视化版） | [freebucks-strategy.html](freebucks-strategy.html) | *(从属 `scheduling`：口径正文真源是 `scheduling.md`，本 HTML 只是它的图解)* |
| 代码质量现状全景 | [code-quality-landscape.md](code-quality-landscape.md) | `code-quality-landscape` |
| 图片输入的可行性调研（**建议未采纳**） | [multimodal-image-input.md](multimodal-image-input.md) | `multimodal-research` |
| 官方客户端协议逆向（L0 总览 + 逐层展开） | [reverse/00-overview.md](reverse/00-overview.md) | `reverse-overview` |

## 三、协议逆向子目录（`docs/reverse/`）—— 对照与证据，不是本仓契约

`docs/reverse/**` 描述的是 **Freebuff 上游**的行为与端点（`/api/v1/*`、`/api/chat/stream`），
**不是本仓注册的路由**。因此：

- 门禁 `check-docs` **不扫这个目录**（否则每个上游端点都会被判"没在代码里注册"）。
- 这个目录里提到的路径（`orchestrator.js`、`common/src/constants/...`）是**上游仓库**的，
  不参与"本仓路径必须存在"判据。
- 该目录里的**机器生成快照**（`upstream-contract.json` 等）各有独立门禁对账
  （`contract` / `response-contract` 组），不要在别处手工编辑。

关键文件（**全部 22 份**，`AGENTS.md`「按症状查文档」表指名的都在这）：

| 文件 | 作用 | 状态 |
|---|---|---|
| [reverse/00-overview.md](reverse/00-overview.md) | L0 总览：一次带工具的对话客户端做了什么 | 真源 `reverse-overview` |
| [reverse/01-runtime-and-artifacts.md](reverse/01-runtime-and-artifacts.md) | 运行时与产物：源码从哪来、登录态在哪 | |
| [reverse/02-device-signing.md](reverse/02-device-signing.md) | 设备签名逐字常量、6 行载荷、两处易错点 | **设备签名唯一真源** |
| [reverse/03-session-admission.md](reverse/03-session-admission.md) | 会话建立（admission）实测与坑位 | `AGENTS.md` 指名 |
| [reverse/04-chat-and-tools.md](reverse/04-chat-and-tools.md) | 对话与工具调用 | `AGENTS.md` 指名 |
| [reverse/05-thinking-effort.md](reverse/05-thinking-effort.md) | 思考强度枚举 | |
| [reverse/06-ban-forensics.md](reverse/06-ban-forensics.md) | 封禁实证 | `AGENTS.md` 指名 |
| [reverse/07-503-root-cause.md](reverse/07-503-root-cause.md) | 503 真因 = 每模型每日会话额度 | `AGENTS.md` 指名 |
| [reverse/08-second-ban-and-byok.md](reverse/08-second-ban-and-byok.md) | 第二次封禁（BYOK 否决依据） | `AGENTS.md` 指名 |
| [reverse/09-third-party-review.md](reverse/09-third-party-review.md) | 第三方实现考究（拒采理由） | |
| [reverse/10-third-party-lza6.md](reverse/10-third-party-lza6.md) | 第三方实现考究（拒采理由） | |
| [reverse/11-tls-fingerprint.md](reverse/11-tls-fingerprint.md) | TLS 指纹实证（Node vs 官方 bun） |  曾误标「CLI 指纹真源」；**CLI 指纹真源 = `src/upstream/official-fingerprint.js`**（`KNOWN_CLI_VERSION`），文档侧无真源 |
| [reverse/12-waiting-room-slot-contention.md](reverse/12-waiting-room-slot-contention.md) | 428 waiting_room 真因 | `AGENTS.md` 指名 |
| [reverse/13-client-ui-recon.md](reverse/13-client-ui-recon.md) | 纯 UI 侦查（零协议请求） | |
| [reverse/14-captured-diff.md](reverse/14-captured-diff.md) | 抓包逐字段 diff | |
| [reverse/15-protocol-review.md](reverse/15-protocol-review.md) | 协议复核（**P0 清单已过时，见文首作废头**） |  历史快照 |
| [reverse/16-success-200-with-toolcall.md](reverse/16-success-200-with-toolcall.md) | 首次 200 + 工具调用达成 | |
| [reverse/17-current-status-and-gaps.md](reverse/17-current-status-and-gaps.md) | 现状盘点（**历史快照，文首有 4 条更正**） |  历史快照 |
| [reverse/18-channel-guide-and-tool-mapping.md](reverse/18-channel-guide-and-tool-mapping.md) | 两条链路选型与工具转换（**面向使用者**） | `AGENTS.md` 指名 |
| [reverse/19-catalog-is-the-model-list.md](reverse/19-catalog-is-the-model-list.md) | 模型列表的唯一真源是「目录」 | `AGENTS.md` 指名 |
| [reverse/20-upstream-endpoint-whitelist.md](reverse/20-upstream-endpoint-whitelist.md) | 上游端点白名单：只有客户端发过的才准用 | `AGENTS.md` 指名 |
| [reverse/21-client-request-reference.md](reverse/21-client-request-reference.md) | **对照唯一真源**：客户端请求全表 / 顺序 / 头集 | `AGENTS.md` 指名 |
| [reverse/captures/README.md](reverse/captures/README.md) | 抓包归档（一手证据，只增不改） | |
| [reverse/captures/CAPTURE-SUMMARY.md](reverse/captures/CAPTURE-SUMMARY.md) | 自动生成的抓包摘要（**勿手改**，`summarize.py` 产出） | 产物 |

> **`15` 与 `17` 是历史快照**：文首都已加显式作废/更正头。读它们是为了看"当时怎么判的、
> 错在哪"，**不是**操作依据 —— 现行口径一律以 `21` 为准。

## 三·B、实证留档（`docs/evidence/`）—— 不得删除

| 文件 | 作用 |
|---|---|
| [evidence/README.md](evidence/README.md) | 退款复测原始日志的**实验设计与结论强度**说明 |
| `evidence/refund-*.jsonl` / `ledger-session-units-vs-freebucks.json` | 支撑/证伪「早退是否退还 Freebucks」的一手原始数据 |

这些是**结论可追溯的根**：退款口径已经反复三次，下一次想改这个结论的人必须能读到当时的原始数据。

## 四、常见误配（都已误导过至少一份文档，写在这里防复发）

1. **`upstream.api_base` 写了不生效 —— 它是硬编码的。**
   真源 = `src/config.js` 的 `UPSTREAM_API_BASE`（`https://www.codebuff.com`），
   `loadConfig()` 在 `src/config.js:381-383` **无条件覆盖**配置文件里的值。
   唯一可覆盖口 = 环境变量 `FREEBUFF_UPSTREAM_API_BASE`（仅供本地镜像对照 / 离线契约测试）。
   误配原型：`docs/configuration.md`、`docs/screenshots.md`、`docs/reverse/21` 都曾教人改
   `api_base` 去指向 mock 上游 —— 那条路**走不通**。
2. **`config.yaml` 里的上游代理只是兜底**，日常入口是控制台「代理设置」→ `/data/proxies.json`。
3. **不要把旧结论"简化"回来**：Freebucks 早退**拿不回**（付费时段内不释放）。
   一手实测见 [account-scheduling-and-refund.md §3](account-scheduling-and-refund.md) 与
   `.agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md`。

## 五、引用纪律：note 与文档互相引用走**文档路径**

`.agents/notes/**`（决策记录）与本文档集互相引用时，**指向文档路径**，不要指向实现文件的
内部常量或行号 —— 源码会随重构移动（如 `src/upstream/` 正在拆分子目录），文档路径不会。

同样地，**本文档集不重复决策内容**：决策与"否决过什么"记在 `.agents/notes/`，
本文档集只描述**现状**。两者的分工见 [code-quality-landscape.md](code-quality-landscape.md)。

## 六、淘汰记录

2026-10-05 一轮淘汰（证据见 [code-quality/docs-audit.md](code-quality/docs-audit.md)）：

- **删除** `protocol-implementation-status.md` —— 它声称一个上游 adapter 文件「已创建」，
  而该文件从未存在（`git log --all -- src/upstream/client-headers.js` 为空）；其"待补齐项"也全部已实现。
  替代：本文件 + [reverse/02-device-signing.md](reverse/02-device-signing.md)。
  （被引用而实际不存在的路径，完整名字与取证见 [code-quality/docs-audit.md](code-quality/docs-audit.md) §2.6。）
- **删除** `freebuff-desktop-protocol-reverse.md` —— "缺失（导致被识别为第三方客户端）"整节已不成立。
  替代：[reverse/02-device-signing.md](reverse/02-device-signing.md)。
- **删除** 仓库根 `REVERSE_ENGINEERING_SUMMARY.md` —— 三处硬事实错误（签名头名 / 载荷字段数 /
  CLI 版本号），且早已被 `.gitignore` 声明不该入库。替代：[reverse/02-device-signing.md](reverse/02-device-signing.md)。

>  **独立盲审推翻了"已完整取代"这个说法，两项独有内容已捡回**（2026-10-05）：
> 1. **本地进程隔离头**（`x-freebuff-launch-id` + HttpOnly cookie `freebuff_launch_{port}`）——
>    原只记在 `freebuff-desktop-protocol-reverse.md` 里，全仓实测无其他出处。
>    已捡回 [reverse/00-overview.md](reverse/00-overview.md)（"哪些头属于本地进程、哪些才是上游判据"的边界知识）。
> 2. **访问层级 Access Tiers 语义**（`full` / `limited` + `ipPrivacySignals` 样例）——
>    原只记在根 `REVERSE_ENGINEERING_SUMMARY.md` 里，文档侧已无定义（只剩裸值 `"limited"`）。
>    已捡回 [reverse/00-overview.md](reverse/00-overview.md)。
>    （另：`DEFAULT_WAIT_MS=3000` / 404-405 走 1 小时退避 —— 经复核**代码里不存在**，
>    属于被删文档的编造，**不捡回**；见 docs-audit §3.6。）
