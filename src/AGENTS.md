# src/AGENTS.md -- 后端约定

> 只讲[动 src/ 时才知道的事]. 通用约定见根 [AGENTS.md](../AGENTS.md).

## 目录职责
| 目录 | 职责 |
|---|---|
| `proxy/` | 下游请求入口: 解析 model -> 选号 -> 转发 -> 回程重写工具名 |
| `session/` | 上游会话生命周期: admit / 复用 / 释放 / 状态机 |
| `upstream/` | 上游形态: 端点白名单 / 信号判据 / catalog / 设备签名 / RPC 端口 |
| `web/` | 控制台 HTTP 面: `routes/`(按域分发) + `store/`(落盘状态) + `static.ts`(投前端) |
| `context/` | 账号池运行时(AccountRuntimes): 目录 / 额度 / 别名 |
| `model/`, `catalog/` | 模型名解析与目录真源 |
| `config/`, `util/`, `server/` | 配置装载 / 工具 / 服务装配 |

顶层 `*.ts` 是各域的对外接线(如 `session-manager.ts` 导出会话管理器实例), 逻辑在子目录.

## 唯一真源(禁止另写一份)
| 事实 | 真源 |
|---|---|
| 模型名三层映射 | `CatalogHolder.keyForName`, 上层入口 `AccountRuntimes.resolveModelAlias` / `displayNameFor` |
| 上游端点白名单 | `upstream/upstream-contract.ts` 的 `REQUIRED_ENDPOINTS`(由 `scripts/check-upstream-contract.ts` 对账) |
| 官方工具名单 | `docs/reverse/captures/official-tools.json` + `upstream/signals/tools/official-tool-select.ts` |
| 工具名映射(Node 侧) | `upstream/signals/tool-name-map.ts` ---- **与 bun 侧 `cli-bridge/lib/tool-map.ts` 成对, 改一处必须改另一处** |
| 业务头 / 协议头 | `upstream/catalog-protocol.ts` --- 字面量禁止散写, 有门禁扫裸字面量 |

## 行为铁律(改这些前先读对应文档)
### 零自动探测
**只有用户主动刷新时才准打上游.** 页面加载, 定时器, 后台任务一律读本地缓存.
实测教训(2026-10-06): 设置页加载时调 `/api/models/upstream`(force 抓目录 + 刷会话)会让
页面白等 1.65 秒 ---- 现该接口支持 `?cached=1` 只读缓存. 依据见 `docs/reverse/20`.

### 代理分配
- 全局池 `upstream.proxies` 由前端[代理设置]管理, 改动立即生效.
- 账号到代理的分配是**系统内部分配**(稳定哈希: 同账号同出口, 保持 session IP 稳定; 某代理失败
  自动回落池内下一个). **禁止**在前端要求用户按账号配置出口.
- 优先级: 账号显式 `proxy` > 全局池 > `upstream.proxy` > `HTTP(S)_PROXY` > 直连.
- `POST /api/proxy/test` 报错必须带底层原因码(ENOTFOUND/ECONNREFUSED/ETIMEDOUT).

### 额度 / 调度
- **两本账是并行两道闸门**(实测: 一笔会话 units `0.1->1.1` 且 Freebucks `5->0`):
  `session_units`(`rateLimitsByModel.recentCount`, 上限 6)与 **Freebucks** 各自独立扣费, 调度两道都要过.
  **Freebucks 才是上游真正的拒付判据**(units 充足仍可能 `freebucksShortfall`).

  **绝不能拆掉任意一道.**
- **一次 admit = 买断一小时**: 这一小时内继续发请求**边际成本为 0**; 早退 DELETE **不退 Freebucks**
  (只回 `freebucksRefundPending`). 所以**付费时段内绝不为空闲释放**.
  见 `notes/architecture/2026-09-14-paid-hour-hold.md`.
- **切号规则**: 账号级故障(`rate_limited`/`spend_limited`/`ip_capped`/`banned`/403/5xx/超时)整号冷却;
  `model_unavailable` 只冷却该模型; **4xx 客户端错误不换号**; 槽位类(`purchase_capacity` 等)与
  **503 只跳过不冷却**(503 是模型侧问题, 见 `docs/reverse/07-503-root-cause.md`).
- **粘性优先调度(drain, not rotate)**: 同模型热 session > 已用过的账号 > 从未用过的账号(最后).
  **绝不主动把并发平摊到多账号**(上游把轮换账号当农场特征, 且每次 admit 都买断一小时).
  并发上限是[溢出]阈值, 不是[换号]阈值 ---- 满了先有界排队.
- **换号有成本**: 单请求最多新建 `limits.max_new_sessions_per_request`(默认 2)条; 复用热 session
  与被拒的 admit 不占预算.
- `free_mode_capacity_deferred` 不冷却(瞬时排队, 同 session 重试即恢复); gate 错误先同账号 re-admit
  一次, 仍失败才换号.

### 会话
- 同模型活跃 session **始终优先复用**(创建才扣额度); `conversation_id` 不决定账号.
- 后台 session GET **在有请求在途时必须跳过**(否则干扰活跃会话).
- DELETE 必须带 `x-freebuff-instance-id`.

## 验证方法(硬性)
结论必须来自**实测**: 远程日志 / 直连上游回执 / **单变量对照**. 禁止只凭源码推断 ----
本仓已多次出现"源码看起来该如此, 实测相反".
