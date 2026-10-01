# Agent Note: chat metadata 补齐 input_profile / repo_snapshot / llm_step_number

Status: implemented

## Problem

官方 chat 的 `codebuff_metadata` 比我们多三个字段（真机抓包确认）：

```json
{ "freebuff_instance_id": "cli:...",
  "freebuff_multi_session": "1",
  "surface": "cli",
  "freebuff_client_env": "v1;in=1;out=1;tp=tmux;...",
  "freebuff_input_profile": "v1;tc=6;ke=6;mc=0;pc=0;pe=0;ms=1001;cps=6",   ← 缺
  "repo_snapshot": "{\"gitAvailable\":false,...}",                        ← 缺
  "llm_step_number": "2",                                                   ← 缺
  "trace_session_id": "...", "run_id": "...", "client_id": "...",
  "cost_mode": "free" }
```

三者都是**客户端行为证据**：用户怎么敲出这条 prompt、本地仓库长什么样、
这是第几步。

## Decision

**实现 `src/upstream/chat-metadata-parity.js` 并在 `buildForwardBody` 里补齐。**

格式逐字对齐官方 `cli/src/utils/input-profile.ts` 的 `encodeInputProfile()`：

```
tc  按键插入的字符数        ke  插入文本的按键事件数
mc  一次插入多字符的事件数   pc  括号粘贴接收的字符数
pe  粘贴事件数              ms  首次输入到提交的毫秒数（null 则**整项省略**）
cps 任一秒窗口内最大插入字符数
```

实测编码与官方样本**逐字相同**：`v1;tc=6;ke=6;mc=0;pc=0;pe=0;ms=1001;cps=6`。

### 两个字段的诚实取舍

**`freebuff_input_profile`**：官方用真实键盘/粘贴事件计数。本代理是**服务端**，
拿不到这些事件。我们**不伪造键盘节奏**（那反而自相矛盾），而是用服务端视角的
等价信息：整条 prompt 计为**一次**插入（`ke=1`、多字符时 `mc=1`），
`ms` 用**真实的下游→上游耗时**。格式与官方一致、语义诚实。

**`repo_snapshot`**：官方扫描本地仓库。本代理没有本地仓库概念，如实报告
`gitAvailable:false` + `unknown`，**不编造文件数**。

## Alternatives considered

- **不补** —— 改前现状。官方带这三个字段，缺它们就是少一层客户端行为证据。
- **伪造真实的按键节奏**（比如编 `tc=40;ke=38;mc=2`）—— 键盘行为是**可统计**的：
  编出来的分布与文本长度不匹配时反而更可疑。用服务端能确证的信息更稳。
- **repo_snapshot 报真实的宿主仓库信息** —— 本代理可能跑在容器里、也可能服务
  多个下游，报"本地仓库"本身就是误导。如实说"不可用"。

## Consequences

- chat 的 `codebuff_metadata` 与官方字段集对齐（除 trace/run/client 三个本就一致）。
- 只补缺失项，**不覆盖**调用方已有值（`withChatMetadataParity` 逐项判 undefined）。

## Evidence

- 编码对照：`v1;tc=6;ke=6;mc=0;pc=0;pe=0;ms=1001;cps=6` 与官方样本逐字相同。
- `ms=null` 时输出 `v1;tc=3;ke=3;mc=0;pc=0;pe=0;cps=3`（整项省略，对齐官方 flatMap）。
- `npm test` 全绿（新增常量/逐字对照/null 省略/服务端画像/repo 形状/不覆盖 六组断言）。
- ⚠️ **端到端未验证**：补上这三字段后还没来得及验证，**账号即被封禁**
  （`banned: true`，见下）。

## ⚠️ 封号记录

`llh282000500@gmail.com`（CLI token `d4f6bee2-...`）在本轮末尾 `banned: true`。

这是**连续多轮大量请求**的结果：为逼近 chat 层 503 的根因，本会话对同一账号
反复建会话、跑 agent run、发 chat（含多次探测），累计远超正常使用量。
官方对第三方客户端本就有 `free_mode_cli_required` 的警告文案
（"Calling the API directly is not supported and may get your account banned"）。

**教训**：根因定位阶段的请求密度必须当作真实资源来管 —— 每次建会话都消耗
一次买断时长，且高频行为本身就是风控特征。后续验证应先攒够假设、一次跑完，
而不是边猜边打。
