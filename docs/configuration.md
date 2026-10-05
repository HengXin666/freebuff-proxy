# 配置参考

> 本文是 [freebuff-proxy](../README.md) 的详细文档之一。每一项配置的唯一来源总表（Docker 下配置在 /data/config.yaml）。
> 快速上手 / 一键部署请看 [主页 README](../README.md)。
> 最后核对: 2026-10-05 · 对应代码: 3a8aebb
> 真源: configuration
## 配置参考

Docker 部署时配置位于 `/data/config.yaml`（首次启动自动生成，完整示例见 [config.example.yaml](../config.example.yaml)）。

| 项 | 唯一来源 |
|----|----------|
| Freebuff 登录态 | Web 控制台添加 / `npm run login` → `credentials/<账号ID>.json` |
| Web 用户 / API Key | `/data/users.json`（控制台管理） |
| Agent 门禁 | `server.api_keys`（可选；非 loopback 必填） |
| 上游 API 主机 |  **不可配**。硬编码真源 = `src/config.ts` 的 `UPSTREAM_API_BASE`（`https://www.codebuff.com`）；配置文件里写 `upstream.api_base` 一律被忽略，唯一例外是环境变量 `FREEBUFF_UPSTREAM_API_BASE`（仅供本地镜像对照/离线契约测试） |
| 上游登录 URL | `upstream.login_base` |
| 出网代理 | 控制台「代理设置」→ `/data/proxies.json`（账号级 `credentials/<账号ID>.json#proxy`、`upstream.proxy`、`HTTP(S)_PROXY` 仅兜底） |
| 运行策略 | 控制台「免费额度策略」→ `/data/settings.json`（保存后立即生效） |
| 监听地址 | `server.host` / `port`（`FREEBUFF_PROXY_HOST` / `FREEBUFF_PROXY_PORT` 覆盖） |
| 管理员 | `ADMIN_USERNAME` / `ADMIN_PASSWORD`（或 `users.default_admin_*`） |
| 并发上限 | `limits.max_concurrent_requests` |
| 并发闸门排队上限（排满即有界拒绝 429 `server_busy`） | `limits.slot_wait_ms`（默认 15000ms，<=0 立即拒绝） |
| 读请求体超时（防并发槽位泄漏） | `limits.body_read_timeout_ms`（默认 120000ms） |
| 每账号并发（SSE 流数，溢出阈值） | `limits.account_max_concurrency`（默认 2，控制台「账号调度」实时调整） |
| 上游请求抖动（打散机器式节奏） | `limits.request_jitter_ms`（默认 200ms，0 = 关闭） |
| 空闲自动释放（**付费时段结束后**腾槽位） | 控制台「额度保护」→ `/data/settings.json`（`session.idle_release_sec` 默认 60s，可调 5s..24h，0 = 关闭；付费时段内不释放） |
| 单请求新会话预算（Freebucks 计费单位） | 控制台「额度保护」（`limits.max_new_sessions_per_request` 默认 2，0 = 不限） |
| 会话句柄落盘（重启/换容器后可退款） | `/data/sessions.json`（自动维护，无需手工编辑） |
| 会话过期提前切换（付费模型） | `session.re_admit_lead_sec`（默认 60s） |
| 会话过期提前切换（免费模型，不足该时长不调度） | `session.free_model_re_admit_lead_sec`（默认 60s） |
| 上游流 idle 超时（幽灵连接治理） | `limits.stream_idle_timeout_sec`（默认 60s，最小 30s） |
| 流掐断后账号短暂冷却 | `limits.stall_cooldown_sec`（默认 30s，0=关闭） |
| 账号级串行化排队上限 | `limits.account_chat_wait_ms`（默认 120000ms） |
| 「首字节之前」的调度总预算（超时 429 `scheduling_timeout`） | `limits.scheduling_budget_ms`（默认 45000ms，须低于上游前置 Cloudflare 的 100s 524 悬崖） |
| 上游单请求总超时 | `limits.upstream_timeout_sec`（默认 600s；chat 的首字节等待另有 60s 收紧，见 [连接治理](connection-health.md)） |
| gate 错误自动 re-admit 次数 | `limits.max_auto_retry_on_session_error`（默认 1） |
| Web 会话有效期 | `web.session_ttl_hours`（默认 168h） |
| Web 会话 Cookie Secure 开关 | `web.cookie_secure`（默认 false；HTTPS 反代后设 true） |
| 首次启动管理员用户名/密码 | `users.default_admin_username`（默认 `admin`）/ `users.default_admin_password`（null → 随机并只在日志打印一次） |
| 账号凭据目录 | `upstream.credentials_dir`（默认 `<data_dir>/credentials`） |
| 进程内日志环形缓冲条数 | `logging.ring_cap`（默认 5000，0 = 关闭；控制台「日志」页的回溯深度） |
| 退出时释放全部会话 | `session.release_on_shutdown`（默认 true） |
| 会话过期自动 re-admit | `session.re_admit_on_expire`（默认 true） |
| 后台 session 轮询间隔 | `session.poll_interval_sec`（默认 30s） |
| admit 请求超时 | `session.admit_timeout_ms`（默认 30000ms） |
| 配置文件路径 | 默认 `./config.yaml` 或 `FREEBUFF_PROXY_CONFIG` |
| 数据目录 | 默认 `./data` 或 `FREEBUFF_PROXY_DATA_DIR`（Docker 固定 `/data`） |
