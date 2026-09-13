# 配置参考

> 本文是 [freebuff-proxy](../README.md) 的详细文档之一。每一项配置的唯一来源总表（Docker 下配置在 /data/config.yaml）。
> 快速上手 / 一键部署请看 [主页 README](../README.md)。
## 配置参考

Docker 部署时配置位于 `/data/config.yaml`（首次启动自动生成，完整示例见 [config.example.yaml](../config.example.yaml)）。

| 项 | 唯一来源 |
|----|----------|
| Freebuff 登录态 | Web 控制台添加 / `npm run login` → `credentials/<账号ID>.json` |
| Web 用户 / API Key | `/data/users.json`（控制台管理） |
| Agent 门禁 | `server.api_keys`（可选；非 loopback 必填） |
| 上游 API / 登录 URL | `upstream.api_base` / `login_base` |
| 出网代理 | 控制台「代理设置」→ `/data/proxies.json`（账号级 `credentials/<账号ID>.json#proxy`、`upstream.proxy`、`HTTP(S)_PROXY` 仅兜底） |
| 运行策略 | 控制台「免费额度策略」→ `/data/settings.json`（保存后立即生效） |
| 监听地址 | `server.host` / `port`（`FREEBUFF_PROXY_HOST` / `FREEBUFF_PROXY_PORT` 覆盖） |
| 管理员 | `ADMIN_USERNAME` / `ADMIN_PASSWORD`（或 `users.default_admin_*`） |
| 并发上限 | `limits.max_concurrent_requests` |
| 并发闸门排队上限（排满即有界拒绝 429 `server_busy`） | `limits.slot_wait_ms`（默认 15000ms，<=0 立即拒绝） |
| 读请求体超时（防并发槽位泄漏） | `limits.body_read_timeout_ms`（默认 120000ms） |
| 每账号并发（SSE 流数，溢出阈值） | `limits.account_max_concurrency`（默认 2，控制台「账号调度」实时调整） |
| 上游请求抖动（打散机器式节奏） | `limits.request_jitter_ms`（默认 200ms，0 = 关闭） |
| 空闲自动释放（早退退款，Freebucks） | 控制台「额度保护」→ `/data/settings.json`（`session.idle_release_sec` 默认 60s，可调 5s..24h，0 = 关闭） |
| 单请求新会话预算（Freebucks 计费单位） | 控制台「额度保护」（`limits.max_new_sessions_per_request` 默认 2，0 = 不限） |
| 会话句柄落盘（重启/换容器后可退款） | `/data/sessions.json`（自动维护，无需手工编辑） |
| 会话过期提前切换（付费模型） | `session.re_admit_lead_sec`（默认 60s） |
| 会话过期提前切换（免费模型，不足该时长不调度） | `session.free_model_re_admit_lead_sec`（默认 60s） |
| 上游流 idle 超时（幽灵连接治理） | `limits.stream_idle_timeout_sec`（默认 60s，最小 30s） |
| 流掐断后账号短暂冷却 | `limits.stall_cooldown_sec`（默认 30s，0=关闭） |
| 账号级串行化排队上限 | `limits.account_chat_wait_ms`（默认 120000ms） |
| 「首字节之前」的调度总预算（超时 429 `scheduling_timeout`） | `limits.scheduling_budget_ms`（默认 45000ms，须低于上游前置 Cloudflare 的 100s 524 悬崖） |
| Web 会话有效期 | `web.session_ttl_hours`（默认 168h） |
| 配置文件路径 | 默认 `./config.yaml` 或 `FREEBUFF_PROXY_CONFIG` |
| 数据目录 | 默认 `./data` 或 `FREEBUFF_PROXY_DATA_DIR`（Docker 固定 `/data`） |
