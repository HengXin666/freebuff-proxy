# 文档审计：盘点、真矛盾、淘汰与规范（2026-10-05）

> 最后核对: 2026-10-05 · 对应代码: 94902a4
> 本文件是 **WS-E 一轮文档整理的取证与决策留档**。它是审计报告（会故意引用错误说法作反例），
> 因此被 `scripts/gates/checks/doc/check-docs.ts` **排除在判据之外**。
>
> 用户原话：「然后这些文档也要规范，旧的文档直接淘汰，不要混淆视听。」

## 0. 方法与证据口径

每条结论都必须能**复现**。本文所有"不一致"都给出：原文引用 + 对照命令（或代码行号）。
判"过期"的三种硬证据：① 文档声称的文件不存在；② 文档声称的端点/常量与代码不符；
③ 文档自述"未执行/待补齐"而代码里其实已实现（或反之）。

统计口径：受控文档 = `git ls-files` 中 `docs/**` + 仓库根 `README.md` + `REVERSE_ENGINEERING_SUMMARY.md`
（最后一份已于本轮 `git rm --cached` + 删文件，见 §2.8）。

## 1. 文档清单表

| 路径 | 主题 | 与当前代码一致？ | 与别处重复？ | 已被取代？ | 处置 | 理由（证据） |
|---|---|---|---|---|---|---|
| `README.md` | 快速上手 + 能力总览 |  1 处 | 路由表与 `api.md` 部分重叠（可接受） | — | **就地修** | L107 退款口径错（见 §2.2） |
| `docs/README.md` | **索引与真源声明** |  本轮新建 | — | — | **保留（本轮新增）** | 之前没有"哪个主题看哪个文件"的真源 |
| `docs/design/api.md` | 下游接入 + 本仓路由 |  | 与 README 路由表重叠（README 是摘要） | — | 保留 + 加真源声明 | 端点与 `proxy.js` 逐条对得上（§3 验证） |
| `docs/guide/configuration.md` | 配置项总表 |  1 处 | — | — | **就地修** | `upstream.api_base` 声称可配（见 §2.3） |
| `docs/design/scheduling.md` | 调度 / 额度 / 额度保护 |  **自相矛盾** | 与 `account-scheduling-and-refund.md` 重叠 | — | **就地修** | 同文件 L14 vs L82 互斥（见 §2.1，**最危险**） |
| `docs/design/account-scheduling-and-refund.md` | 调度调研与纠错史 |  混合（§3 含已推翻版本） | — | — | **就地修 + 加"读法"头** | §3.5/§3.7 落旧结论（见 §2.6） |
| `docs/guide/connection-health.md` | 连接治理 |  | — | — | 保留 | 阈值与 `config.js` 一致 |
| `docs/guide/deployment.md` | 数据持久化 / 镜像 |  1 处 | — | — | **就地修** | `/data` 树漏 3 项，与自身表格打架（见 §2.9） |
| `docs/guide/development.md` | 命令 / 发版 |  | — | — | 保留 | |
| `docs/guide/proxy.md` | 代理池 |  | — | — | 保留 | 优先级与 `client.js:108,236` 一致 |
| `docs/guide/web-console.md` | 控制台 |  | — | — | 保留 | |
| `docs/guide/screenshots.md` | 截图复现 |  1 处 | — | — | **就地修** | 配方用 `api_base` 指 mock，实测不生效（见 §2.4） |
| `docs/research/multimodal-image-input.md` | 图片输入调研 | （**准确**） | — | — | **保留 + 加状态头** | 三条建议实测**确未执行**（见 §2.11） |
| `docs/design/freebucks-strategy.html` | 计费策略图解 |  | 结论与 `scheduling.md` 一致 | — | 保留 | 开篇即"不要早退"（正确方向） |
| `docs/quality/code-quality-landscape.md` | 代码质量全景 |  | — | — | 保留 | 已登记进新索引，未另起重复 |
| `docs/protocol-implementation-status.md` | 协议实现状态 |  **整份过期** | 被 `reverse/02` 取代 |  | **删除** | 声称的文件不存在 + 待办全已实现（见 §2.6 证据） |
| `docs/freebuff-desktop-protocol-reverse.md` | Desktop 协议逆向 |  **整份过期** | 被 `reverse/02` 取代 |  | **删除** | "缺失"整节已不成立（见 §2.7） |
| `REVERSE_ENGINEERING_SUMMARY.md`（根） | 逆向总结 |  3 处硬错 | 被 `reverse/*` 取代 |  | **删除** | 见 §2.8（已被 `.gitignore` 声明不该入库） |
| `docs/reverse/00-21*.md`（22 份） | 上游协议逆向 | （抽样核对） | `17` 是自标的历史快照 | 部分 | **保留** | 有 `21` 作对照真源；`17` 已自标历史 |
| `docs/reverse/captures/**` | 抓包一手证据 |  | — | — | 保留 | 只增不改的证据归档 |
| `docs/evidence/**` | 退款复测原始日志 |  | — | — | **保留（勿删）** | 目录 README 明写"不要删"，是结论可追溯的根 |
| `docs/images/*.webp` | README 截图 |  | — | — | 保留 | |

**统计**：整份淘汰 **3** 份；就地修 **8** 处（README + 7 份 docs/，见下表"处置"列的**就地修**）；
保留 **18** 份（含新增的 `docs/README.md` 索引）。

## 2. 真矛盾清单（每条：原文 + 证据）

### 2.1  `docs/design/scheduling.md` 同文件自相矛盾（**最危险**）

```
L14-15: 「提前 DELETE 会按**实际占用时长退还**未用部分（2026-09-13 结论反转…）」
L82   : 「**提前 DELETE 不退**（响应里的 `freebucksRefund` 实测恒为 0…）」
L104  : 「…所以空闲早退**只**换回 units 与槽位，**不能**指望拿回 Freebucks」
```

三者互斥。**真值 = L82/L104**，证据：

- `bin/serve.ts` / `src/config.ts:100-118` —— 注释记了一手实测：`admit rem 5 → 0`，25s 后
  DELETE 只回 `{freebucksRefundPending:true}`；`+20/+40/+60/+120s` 重放 ×2 仍无金额。
- `src/session-manager.ts:414-422`（`_armIdleRelease()`）——「仍在已付费时段内：闲置不花钱，
  释放才是浪费」，实现上**付费时段内不释放**。
- `.agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md` —— 决策记录，
  Problem 段列出"重开同模型 `rate_limited` + `freebucksShortfall`"。

**为什么它最危险**：① README 的「文档」表把它列为调度**唯一入口**；② 矛盾在**同一文件内**，
读一半就信；③ 错误方向是"早退能省钱"——照做会在付费时段内主动释放，**直接丢钱**。

### 2.2 `README.md:107` 退款口径错，**且逃过了既有守卫**

```
原文：「…**admit 一次按整小时买断**；提前 `DELETE` 会把未用部分**按实际占用时长退回**。」
```

`test/suites/entries/smoke/smoke.ts` 的 `STALE_COPY` 守卫（`test/suites/entries/smoke/smoke.ts:6875`）正则是：

```js
/按实际占用退还\s*Freebucks|退还未用时长|退还未用部分|停止为空转时长付费|.../
```

README 写的是「按实际占用**时长退回**」—— `时长` 夹在中间，词序与正则不符。实测验证：

```bash
node -e "...STALE_COPY.test(readFileSync('README.md','utf8'))"   # => false（漏检）
```

→ 这是**门禁漏洞**，属 `test/`（WS-D 范围），已转交。文档侧已改对。

### 2.3 `docs/guide/configuration.md:14` 声称 `upstream.api_base` 可配

```
原文：「| 上游 API / 登录 URL | `upstream.api_base` / `login_base` |」
```

对照命令（实测，非推断）：

```bash
node -e "写入 upstream.api_base=http://127.0.0.1:18999 后 loadConfig()"
# 实际生效 apiBase = https://www.codebuff.com   ← 配置文件被忽略
```

代码真值：`src/config.ts:44`（`UPSTREAM_API_BASE` 常量）、`src/config.ts:381-383`
（`merged.upstream.apiBase = stripTrailingSlash(process.env.FREEBUFF_UPSTREAM_API_BASE || UPSTREAM_API_BASE)`
—— **无条件覆盖**）。裁决（Lead，2026-10-05）：**保持硬编码**，文档侧写清真相。

### 2.4 `docs/guide/screenshots.md:48` 的演示配置**跑不通**

```
原文（修改前）：upstream:\n  api_base: http://127.0.0.1:18999
```

按 §2.3 的实测，该配方下 mock 上游**根本不会被连上**（apiBase 仍是 `www.codebuff.com`）。
已改为用环境变量 `FREEBUFF_UPSTREAM_API_BASE` 启动。

### 2.5 `docs/reverse/21-client-request-reference.md:290,295` 同样的 `api_base` 误教

原文教「把 `config.yaml` 的 `api_base` 指向它」（指向本地镜像以打印原始头）。已改为
`FREEBUFF_UPSTREAM_API_BASE=http://127.0.0.1:9544 node bin/serve.ts`。

### 2.6 `docs/protocol-implementation-status.md` 整份过期（**已删除**）

```
L12: 「| **客户端身份头** |  已创建未集成 | `src/upstream/client-headers.js` | …」
L65: 「**文件**: `src/upstream/client-headers.js` (已创建)」
L87-101: 验证清单全部是未勾选的 [ ]（"Session 创建 / admission / chat 全部待验证"）
```

证据：

```bash
$ ls src/upstream/client-headers.js
ls: 无法访问 'src/upstream/client-headers.js': 没有那个文件或目录
$ grep -rn "x-freebuff-client" src/upstream/upstream-contract.ts src/upstream/catalog-protocol.ts
src/upstream/upstream-contract.ts:44:export const H_CLIENT = 'x-freebuff-client'
src/upstream/catalog-protocol.ts:40:export const HEADER_CLIENT = 'x-freebuff-client'
```

→ 声称的文件不存在；它列为"缺失"的 `x-freebuff-client` 已定义并发出。替代：
`docs/reverse/02-device-signing.md`。**无任何文件引用它**（`grep -rln` 为空），删除零影响。

### 2.7 `docs/freebuff-desktop-protocol-reverse.md` 整份过期（**已删除**）

```
L96-101「缺失（导致被识别为第三方客户端）」
   设备签名三件套: x-freebuff-device-key / -device-ts / -device-sig
   目录协议：未用 fbm1. 句柄，仍传明文 model id
   x-freebuff-catalog-fetch: <fetchId>
   x-freebuff-client: desktop / -install-id
```

证据：上述四项**全部已实现** —— `src/upstream/device-signing.ts`（471 行，三头常量在
`:28-30`）、`src/upstream/catalog-protocol.ts`（573 行，句柄 + fetchId 头）。
被 `docs/reverse/02-device-signing.md` 完整取代，且后者更准（有逐字常量、6 行载荷、
"不是前 43 字符"的易错提示、本机实测 keyId）。

### 2.8 `REVERSE_ENGINEERING_SUMMARY.md`（根）三处硬错（**已删除**）

| # | 原文（行） | 真值 | 证据 |
|---|---|---|---|
| 1 | `X-Freebuff-Device-Signature` / `-Key-Id` / `-Timestamp`（L65-67） | `x-freebuff-device-key` / `-ts` / `-sig` | `src/upstream/device-signing.ts:28-30` |
| 2 | 「签名载荷（换行分隔的 **5 个字段**）」（L52）、`sha256(...).slice(0, 43)`（L58） | **6 行**、**完整 64 位 hex** | `device-signing.js:9-11,83-93`；`docs/reverse/02 §2.2` 明写「不是前 43 字符！」 |
| 3 | CLI 指纹 `0.2.12`（L94,97,112,218） | `KNOWN_CLI_VERSION = '0.0.178'` | `src/upstream/official-fingerprint.ts:30` |

额外发现：`git check-ignore --no-index` 命中 `.gitignore:57`（声明它不该入库），
但 `git ls-files -s REVERSE_ENGINEERING_SUMMARY.md` 显示它**已被跟踪**（`100644 e6a8f81`）
—— 忽略规则与跟踪状态打架的病态。

**删除顺序（不可反）**：Lead 先改 3 处 note 引用（`…-device-signing-raw-public-key.md:79`、
`…-device-signing-export-surface.md:56`、`…-cli-fingerprint-periodic-align.md:55`，全部改指
`docs/reverse/02-device-signing.md` 等文档路径）→ 复核 `grep -rn REVERSE_ENGINEERING_SUMMARY .agents/`
只剩"已废弃删除"的说明句 → 再 `git rm --cached REVERSE_ENGINEERING_SUMMARY.md && rm -f`。
若先删文件，note 门禁（`verify-backlinks`）会因悬空引用变红。

### 2.9 `docs/guide/deployment.md` 的 `/data` 树漏 3 项，与自身表格打架

```
L9-20 的目录树列了：config / credentials / users / web-sessions / login-flows / catalog-cache
                    / custom-models / proxies / settings
L115-127 的表格里却列了：… account-state.json / sessions.json …
```

证据：

```bash
$ ls data/
account-state.json  catalog-cache.json  config.yaml  credentials  custom-models.json
device-keys  proxies.json  sessions.json  settings.json  users.json  web-sessions.json
```

→ 树里缺 `account-state.json`、`device-keys/`、`sessions.json`，而表格有。已补齐。

### 2.10 `docs/reverse/17-current-status-and-gaps.md` 与现状相悖

L33-60 讲"主服务（`src/proxy.ts`）未同步的 3 项结构性差异（agentId = `base3-free-catalog`、
自编签名工具、CLI 开场白）"。现状：主服务已改为经 `official-rpc` **RPC 委托 cli-bridge**，
legacy 通道在 `src/config.ts` 的 `resolveUpstreamChannel()` 里**强制回落并告警**
（`docs/reverse/18` 与 `README` 的「上游请求链路」节均已如此描述）。

处置：**保留**（它开头已自标"2026-10-03 的历史盘点快照，判断当前请以 21 为准"，
且它记录了当时的实测过程），但已在 `docs/README.md` 里把 `21` 标为对照唯一真源。

### 2.11 `docs/research/multimodal-image-input.md` §4「未执行」**是准确的**（判保留）

三条建议经复核**确未实施**：

```bash
$ sed -n '116p' src/catalog/parser.ts
      multimodal: false,                      # 仍写死
$ grep -n RAW_BASE src/catalog/runtime-sync.ts
27:const RAW_BASE = '.../CodebuffAI/freebuff/main/common/src/constants/'   # 仍指 re-export 残页
$ node -e "内置 catalog 里 deepseek/deepseek-v4-flash 的 multimodal"
deepseek/deepseek-v4-flash multimodal= false  # 仍是 false
```

→ 它不是"过期文档"，而是"准确的未执行建议书"。已加状态头
（「建议未采纳（截至 2026-10-05）」+ 逐条未执行清单），防止被误读为已实现说明。

## 3. 机器判据（`scripts/gates/checks/doc/check-docs.ts`）

四条判据（详见脚本头 JSDoc）：

1. **端点双向对账** —— 文档里的 `` `METHOD /path` `` 必须在代码注册；反向，代码注册的对外端点
   必须在 `docs/design/api.md` 登记。
2. **本仓路径存在性** —— 文档里反引号包裹的 `src/` `docs/` `scripts/` 等路径必须真实存在。
   （这条自动拦住了 §2.6 那类"整份过期"文档 —— 它正是靠 `client-headers.js` 不存在被发现的。）
3. **真源唯一性** —— 扫描 `> 真源: <key>` 标记行，同一 key 不得由两份文档声明。
4. **索引完整性** —— `docs/README.md` 必须存在，且其登记的 `.md` 链接不得悬空。

**命名空间铁律**（写进脚本 JSDoc，防误报）：`docs/reverse/**` 描述的是 **Freebuff 上游**端点
（`/api/v1/*`）与上游文件，**不参与**判据 1/2。首版脚本未做这个区分时，一次跑出 37 条误报
（把上游 `GET /session`、skill 内部相对路径 `scripts/notes-lib.ts` 全判成违规）——
改为**白名单扫描**（`docs/**` 去两个排除目录 + 根 `README.md`）后降到 0。

### 3.1 可证伪验证（四轮真实输出，最终版脚本）

> 以下四段都是**本轮最终脚本**（225 行 + `lib/routes.mjs`）的实跑输出，可直接复现。
> （本报告早期版本引用的输出是在脚本演进中途录的，与最终版不一致 —— 已按最终版重录。）

**基线（应绿）**

```bash
$ node scripts/gates/checks/doc/check-docs.ts ; echo "exit=$?"
  · 端点：对外 8 条 · 控制台 24 条 · docs/design/api.md 声明 7 条（扫 src/ 全域）
  · 文件引用：核对 58 处本仓路径（豁免 2 条构建产物）
  · 真源声明：12 个主题（scheduling-research / api / code-quality-landscape / configuration /
    connection-health / deployment / development / multimodal-research / proxy / scheduling /
    screenshots / web-console）
  · 索引：登记 39 个链接 / 覆盖 14 份文档
  · 扫描 15 份文档（白名单 docs/ / README.md，排除 docs/reverse/ / docs/code-quality/）
ok  docs
exit=0
```

**① 改坏一个端点 → 必须红（且双向都报）**

```bash
$ sed -i 's|`GET /v1/freebuff/status`|`GET /v1/freebuff/status-v2`|' docs/design/api.md
$ node scripts/gates/checks/doc/check-docs.ts ; echo "exit=$?"
  FAIL docs/design/api.md:41
       文档写到的端点 `GET /v1/freebuff/status-v2` 在代码里没有注册
  FAIL docs/design/api.md
       代码注册了对外端点 /v1/freebuff/status，但 docs/design/api.md 未登记
OVER docs: 2 条违规
exit=1
```

正向（文档写了不存在的端点）与反向（代码有但文档没登记）**同一条改动里都报** —— 两个方向都不是摆设。

**② 还原 → 必须绿**

```bash
$ cp /tmp/api.final.bak docs/design/api.md
$ node scripts/gates/checks/doc/check-docs.ts ; echo "exit=$?"
  · 索引：登记 39 个链接 / 覆盖 14 份文档
  · 扫描 15 份文档
ok  docs
exit=0
```

**③ 把索引的 markdown 链接整批吃掉 → 必须红（这条是事故后补的判据）**

```bash
$ sed -i 's/\[\([^]]*\)\](\([^)]*\)/\1/g' docs/README.md      # 链接全部变裸文本
$ node scripts/gates/checks/doc/check-docs.ts ; echo "exit=$?"
  FAIL docs/README.md
       索引只解析出 0 个文档链接（下限 24）—— 链接语法可能被整批破坏
  FAIL docs/README.md
       README.md 存在但索引未登记（读者找不到它）
  FAIL docs/README.md
       docs/design/account-scheduling-and-refund.md 存在但索引未登记（读者找不到它）
  …（另 11 条同型）
OVER docs: 15 条违规
exit=1
$ cp /tmp/idx.final.bak docs/README.md && node scripts/gates/checks/doc/check-docs.ts
ok  docs ; exit=0
```

> **这条判据是事故后才存在的。** 事故当时（链路数归零）本门禁报的是 `ok docs` —— 见 §3.3。

### 3.2 全绿态

本文件落盘、索引补齐后：

```bash
$ node scripts/gates/checks/doc/check-docs.ts ; echo "exit=$?"
ok  docs
exit=0
```

（即在上面"基线"那一段；它同时是 §3.1 的起点与终点。）

### 3.3  本轮真实事故：门禁在最该报警时静默通过（**已修**）

审阅期间发生了两次独立事故，都指向同一条设计教训。

**事故 A：一次"标点/去链接"批处理改坏 223 个已跟踪文件，本门禁仍报 `ok docs`。**

现象（实测）：

```bash
$ grep -n '复现方式' README.md
47:截图用 mock 上游 + 无头 Chromium 生成,账号与 API Key 均为占位值并已打码(复现方式).
#                          ↑ 原文是 `[复现方式](docs/screenshots.md)`（当时的路径），链接语法被整段吃掉
$ for f in README.md docs/README.md docs/design/scheduling.md; do grep -c '](' $f; done
1        # README.md        （原 15）
0        # docs/README.md   （原 29）
0        # docs/design/scheduling.md（原 6）
$ node scripts/gates/checks/doc/check-docs.ts ; echo "exit=$?"
ok  docs        ←  报警器在最该响的时候变绿灯
exit=0
```

**根因在本门禁的设计**：判据是"违规数 == 0 就 PASS"，而文档里一条 markdown 链接都没有时，
索引判据解析出 **0 条链接 / 0 条违规**，与"链接全部正确"的输出**完全一样**。

**修复**：加**下界断言** `MIN_INDEX_LINKS = 12`（索引解析出的链接数低于下限即 FAIL）：

```bash
# 链接被整批吃掉（模拟）
$ node scripts/gates/checks/doc/check-docs.ts
  FAIL docs/README.md
       索引只解析出 0 个文档链接（下限 12）—— 链接语法可能被整批破坏
OVER docs: 1 条违规
# 还原
$ node scripts/gates/checks/doc/check-docs.ts
ok  docs ; exit=0
```

> **可推广的教训**：凡"解析出的条目数"可以**合法地变成 0** 的判据，都必须有下界断言。
> 只判"违规数 == 0"的判据，在**输入被整批破坏**时会静默通过 —— 这不是理论风险，
> 本轮实测发生了。

**事故 B：门禁写死源码位置，重构一拆就假红（**已修**）。**

同一次审阅期间 `src/web/api.ts` 从 1847 行单体拆成 13 行 re-export 门面，实现移入
`src/web/routes/**`。本门禁原先写死读 `src/proxy.ts` + `src/web/api.ts`，于是 24 条
`/api/*` 路由全部被判"代码里没有注册"（报 5 条违规，**真凶是门禁自己过时**）。

修复分两步，各有独立理由：

1. **扫 `src/` 全域**而不是固定文件 —— 路由真源位置会随重构移动，扫全域后拆分不再需要动门禁。
2. **取文件方式改为 `文件系统遍历 ∪ git ls-files` 并集** —— `src/web/routes/**` 是**还没
   `git add` 的未跟踪新文件**，只用 `git ls-files`（其余门禁的"受控文件"惯例）看不到它们，
   这正是假红的直接成因。并集让 CI（全部已跟踪）与本地开发（部分未跟踪）都正确。

**路由零丢失的机器证据**（集合差对比）：

```bash
旧 api.js 路由声明: 24
新 src/ 扫描:       24
旧有今无: []
```

### 3.4 判据的已知局限（不假装它更强）

- 判据 3 只防"**两份**文档声明同一个真源 key"，**防不了**"一份声明了但内容已旧"。
  后者需要人读或另设"关键数字对账"，本门禁不做。
- 判据 1 依赖文档写成 `` `METHOD /path` `` 的反引号形态。**散文里随口提到的路径不会被查**——
  这是刻意的：宁可漏，也不要把"举例说明"误判成"契约声明"。
- `docs/reverse/**` 完全在判据之外（它描述上游），所以那份目录里的错误**本门禁抓不到**，
  只能靠 `docs/reverse/21` 作对照人工核对。

### 3.5 本轮事故全记录：`fix-style.mjs` 批处理（2026-10-05）

**事故概述**：Lead 的自动修复器 `scripts/gates/meta/fix-style.ts` 一次跑动改写了
**223 个已跟踪文件**，其中两类是**真损坏**（不是目标状态）：

| # | 损坏类别 | 机理 | 观察到的形态 |
|---|---|---|---|
| 1 | **markdown 标记被剥** | 把行首 `#` 当标题标记、把 `[x](y)` / `**粗体**` 当"中文标点"处理 | `[复现方式](docs/screenshots.md)` → `(复现方式)`；`## Problem` → `Problem` |
| 2 | **JSDoc 定界符被吃** | `/**` 里的 `**` 被当成加粗标记 | 块注释首行 `/**` 变成 `/*`…语义上变成未闭合 |

>  **口径更正**：标点**半角化本身不是污染** —— 用户新下发的硬标准要求
> "标点符号只能使用英文标点，范围是所有会被 git 提交的内容"。真正的污染只有上表两类。
> 因此处置是"**保留半角化，还原被剥的语言标记**"，不是"整体回滚"。

**归因与量化（机器证据）**：

```bash
# ① note 格式门禁被打回红色
$ node .agents/skills/hx-agent-notes/scripts/verify-format.ts
… 405 条 format 违规，涉及 81 个文件

# ② 归因：HEAD 上只有 4 个元文件"不合规"，工作区 83 个
HEAD 上首节不是 `## Problem` 的 note 数: 4 / 84
  （全部是 AGENTS.md / NOTE-EXEMPT.md / archived/AGENTS.md / implemented/AGENTS.md 元文件）
工作区: 83 / 84  →  79 篇真实 note 是本次批处理造成的回归

# ③ 逐篇回归清单（79 篇，含 `**` / 反引号 / 链接 三维计数）
/tmp/docaudit-evidence/notes-markdown-regression.txt
```

`verify-format.ts` 的判据是**逐字**的（`problem: ['## Problem', '## 问题']`），首节不是
`## Problem` 直接 fail —— 所以这不是审美问题，是**门禁硬红**。

**额外发现（本轮最隐蔽的一类）**：`「」` 被转成 `[]`，**凭空制造出假链接**：

```
- # Agent Note: 数据文件自检搬进独立的「系统」页
+ Agent Note: 数据文件自检搬进独立的[系统]页      ← `[系统]` 不是合法链接（无 (url)）
```

**本节要记的三条结论纪律**：

1. **机器判据必须有下界断言**。只判"违规数 == 0"的判据，在输入被整批破坏时会静默通过
   —— 本轮实证：223 个文件被改坏后，`check-docs` 仍报 `ok docs`。
2. **自动修复器必须先保护语言定界符，再去处理标记**。`/** */`、`` ` ``、`[..](..)`、行首 `#`
   是**结构**，不是标点；逐行做标点替换一定会吃它们。
3. **结论必须来自实测**（本节正是这条的正面案例）：盲审报了"99 个文件里 5 个语法损坏，
   建议 `git checkout --` 回滚 224 个文件"。本 workstream 用
   `for f in $(git ls-files '*.js' '*.mjs' '*.cjs'); do node --check "$f"; done` 复核 →
   **`broken=0 / total=99`，语法零损坏**，`test/suites/entries/smoke/smoke.ts` 与 `src/web/settings-store.ts` 均 `exit 0`。
   那份"5 个语法坏"是在批处理的**瞬时中间态**上测的。**若照它回滚，会连带吞掉各 workstream
   的正当未提交改动。**

### 3.6 独立盲审：它推翻了什么（两份盲审，只给路径不给结论）

盲审的价值恰恰在于**它推翻了我自己的两个判断**：

| # | 我的结论 | 盲审的实测反证 | 处置 |
|---|---|---|---|
| 1 | 三份被删文档"已被 `reverse/02` 等完整取代" | **不成立**。`freebuff-desktop-protocol-reverse.md` 的**本地进程隔离头**（`x-freebuff-launch-id` / cookie `freebuff_launch_{port}`）全仓 `grep` **零命中**；根 `REVERSE_ENGINEERING_SUMMARY.md` 的**访问层级语义**（`full`/`limited` + `ipPrivacySignals`）文档侧**已无定义** | **捡回两项** → `reverse/00-overview.md`；并在本文件与 `docs/README.md` 记明"已完整取代"不成立 |
| 2 | 索赔 `docs/reverse/11-tls-fingerprint.md` 是"CLI 指纹真源" | 该文件 `grep CLI` **零命中**；CLI 指纹真值是 `src/upstream/official-fingerprint.ts` 的 `KNOWN_CLI_VERSION` | 索引已更正，并把它标成"文档侧无真源" |
| 3 | `account-scheduling-and-refund.md` 的退款矛盾已随 §3.1/§3.5/§3.7 修完 | **§2.2 / §2.3 还有两处旧口径**（"早退会按实际占用退还"、空闲释放是"收益"），且**不在任何作废块内**；`test/suites/entries/smoke/smoke.ts` 的 `STALE_COPY` 对该文件**整体豁免**，门禁结构性地不拦它 | 已就地改对，并把 §2.2/§2.3 纳入"读法头"覆盖范围 |
| 4 | 索引判据已够（防悬空 + 真源唯一 + 下界） | **缺"反向覆盖"**：`docs/` 下文档未被索引登记时它完全不响；实测 `docs/reverse/` 有 17 份漏登记 | 已加反向覆盖判据（见 §3）；漏登记已补齐，`reverse/` 全部 22 份入表 |

**盲审同时给出的、我采纳但未改代码的项**（属别的 workstream 或需用户裁决）：

- `src/` 里 **5 处注释仍写旧退款口径**（`config/defaults.ts` 的 `freeModelReAdmitLeadSec` 注释、
  `proxy.js`、`session-manager.js`、`web/settings-store.js`、`app-context.js`）——
  **实现是对的**（`session-manager._armIdleRelease()` 在 `inPaid` 时清计时器），
  只有注释旧。属 `src/`（WS-B），已转报 Lead，本文档侧不越界修改。
- `docs/design/freebucks-strategy.html` 第 111 行图例写"方案 A —— **现在的默认**：空闲 60 秒就 DELETE"，
  与现行"付费时段内不释放"相反。**已就地改为"已作废的旧默认"**（见 §2 表格第 4 行口径）。
- `docs/reverse/15`（P0 清单已被 `16`/`21` 推翻）与 `docs/reverse/17`：
  因 `docs/reverse/**` 在门禁判据之外，**没有机器拦得住它们被当现状引用**。
  处置是**加显式作废头**（已做）+ 索引标"历史快照"（已做）。
  **未做**的是"给 `docs/reverse/` 也加机器判据" —— 那需要"上游端点/头名清单"作对照，
  属于新增门禁（`contract` 组已有部分能力），本轮不擅自扩大。

**盲审纠正的两处"我说的数字"**（我复核后确认盲审对）：

- 盲审二报 `docs/design/account-scheduling-and-refund.md:90` 写"每日池 **100**" —— 实测确认，
  真值 **25**（`captures/2026-10-03-e2/session-official.json` 的 `"daily":{"limit":25}`）。**已改**。
- 盲审一报 `docs/reverse/21` 的"总次数合计 82" —— 我实测**盲审自己也算错了**：
  该表 15 行数字之和 = **165**（不是 82）。已按实测改写为"165 = 文件行数 / 83 = 去重 / 15 = 路径类型"三种口径并列。
  **这条说明盲审也会错，交叉核对不可省。**

## 4. 文档规范（落地在 `docs/README.md`）

1. 每份文档头部带 `> 最后核对: YYYY-MM-DD · 对应代码: <commit>`。
2. 每份真源文档带 `> 真源: <主题key>`；同 key 只能出现一次（判据 3 机器执行）。
3. 本仓路径引用必须真实存在（判据 2）；上游路径不要写成仓库相对路径形态。
4. **note 与文档互相引用走文档路径**（Lead 裁决）：`src/upstream/` 正在拆分子目录，
   源码常量会移动，文档路径不会。
5. `docs/reverse/` 的上游端点与上游文件不参与判据 1/2；其中的机器生成快照
   （`upstream-contract.json` 等）由 `contract` / `response-contract` 组独立对账，别处不得手工编辑。

## 5. 明确**不**触碰的边界

- **`.agents/notes/**` 是决策记录，不是待淘汰的旧文档。** 由 hx-agent-notes 管理，
  有独立门禁（`verify-all` / `pre-commit` 的 backlinks / coverage）。本轮只**校验指向它的引用**
  是否存在（判据 2 对它不生效，因为它不在白名单里），**未修改任何 note**。
- **`AGENTS.md` 是受保护文件**（`AGENTS.md` 开篇自述：未经用户明确指示不得修改）。本轮
  **零改动**（`git status` 无它）。`CLAUDE.md` 是指向它的软链，同样未动。
- **`data/` 与 `config.yaml`** 是运行时数据，不属文档；只作为"文档说法是否与真实文件一致"的对照物。
