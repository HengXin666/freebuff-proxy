<div align="center">
<h1>freebuff-proxy</h1>
<p><strong>把 Freebuff 的免费额度，变成一个 OpenAI 兼容的 API 端点。</strong></p>
<p>
<a href="https://github.com/HengXin666/freebuff-proxy/releases"><img src="https://img.shields.io/github/v/release/HengXin666/freebuff-proxy?label=release&color=2496ED" alt="Release"></a>
<a href="https://github.com/HengXin666/freebuff-proxy/actions/workflows/docker-image.yml"><img src="https://github.com/HengXin666/freebuff-proxy/actions/workflows/docker-image.yml/badge.svg" alt="CI"></a>
<a href="./LICENSE"><img src="https://img.shields.io/github/license/HengXin666/freebuff-proxy?color=green" alt="License"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white" alt="Node"></a>
<a href="https://github.com/HengXin666/freebuff-proxy/pkgs/container/freebuff-proxy"><img src="https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white" alt="Docker"></a>
<a href="https://github.com/HengXin666/freebuff-proxy/commits/main"><img src="https://img.shields.io/github/last-commit/HengXin666/freebuff-proxy" alt="Last commit"></a>
<a href="https://github.com/HengXin666/freebuff-proxy"><img src="https://img.shields.io/github/repo-size/HengXin666/freebuff-proxy" alt="Repo size"></a>
</p>
<p><strong>超轻量</strong> · <strong>一键 Docker 部署</strong> · <strong>一切管理都在前端页面</strong></p>
</div>

下游 Agent 只需要标准的 `base_url + api_key + model`，本服务负责 Freebuff 身份凭证（多账号池）、免费 session 准入、注入 `cost_mode=free` 与 `freebuff_instance_id`，并把**流式 / 非流式响应原样透传**。

> 本项目使用 Freebuff 官方接口，与 Freebuff 官方无隶属关系。计费与额度**最终以上游实时返回为准**。

---

## 截图

<p align="center"><img src="docs/images/01-overview.webp" alt="总览：账号池、额度（Freebucks）、并发与冷却"></p>

<table align="center">
<tr>
<td width="50%">

**测试对话** — 经 `/v1/chat/completions` 真实转发（流式）

![测试对话](docs/images/02-playground.webp)

</td>
<td width="50%">

**我的** — 你的 API Key 与接入示例

![我的](docs/images/04-me.webp)

</td>
</tr>
</table>

**用户管理** — 建用户、改角色、重置 Key（管理员）

<p align="center"><img src="docs/images/03-users.webp" alt="用户管理"></p>

> 截图为控制台实际界面（用本地演示实例 + 模拟上游生成，账号与 API Key 均为占位值并已打码）。

---

## 计费与定价（Freebucks）

上游按 **Freebucks（FB）** 计费：每个模型有**单价**（N FB/小时），admit 时**按整小时单价预扣**，
提前 `DELETE` 会把**未用部分按实际占用时长退回来**（回执 `freebucksRefund`；
`freebucksRefundPending` = 结算未完成，需要用同一个 `instanceId` 重放 DELETE 取回执，
**不是"不退"**）。所以挂着的空闲会话是在花钱，空闲释放既腾槽位也省钱。
每日池在**太平洋午夜**重置。本页旧版曾写"提前 DELETE 不退"——那是**证据不足的误判，已反转**
（见 [account-scheduling-and-refund.md](./docs/account-scheduling-and-refund.md) §3）。

**官方没有一份可引用的静态价格表**：定价由上游放在每次 session 响应的 `freebucks.prices`
里（模型 → FB/小时），这份「按模型」的价目在公开网页上并不提供。所以本服务**不写死价格**，
而是直接读上游实时值——命令行等价于控制台的额度列：

```bash
npm run pricing           # 人类可读的实时价目表
npm run pricing -- --json # 机器可读（脚本 / CI 直接消费）
```

输出会按单价排序，并把**今日池 / 当前余额折算成各模型还能跑多久**：

```text
Freebuff 实时定价表（Freebucks）

  计费货币   Freebucks（FB）
  今日池     25 FB（已用 0，剩余 25）
  重置时间   2026-09-12 15:00（本地时区） 14 小时后重置

  模型                                  FB/小时         今日池可跑        当前余额可跑
  -------------------------------  --------  ------------  ------------
  google/gemini-3.8-flash                50         30 分钟       30 分钟
  deepseek/deepseek-v4-flash             25          1 小时         1 小时
  openai/gpt-5.6-luna                    20     1 小时 15 分    1 小时 15 分
  mimo/mimo-v2.5                         10      2 小时 30 分      2 小时 30 分
  z-ai/glm-5.3-flash                      5          5 小时          5 小时
  upstage/solar-pro4                     免费             —             —
```

> 上表是**某次真实输出**的样式示意，数字随上游实时变化，请以你自己跑出来的为准。
> 该命令走 GET 探测，**不创建 session、不消耗额度**。

Web 控制台「总览」的**额度（今日 · FB/h）**列展示的就是这份单价（免费模型标「免费」，
今日池见底标「池空」），悬停可看单价、今日池折算可用时长、重置时刻。
细节见 **[多账号池与调度](docs/scheduling.md)**。

---

## 快速开始

镜像非常轻量：`node:22-alpine` + 仅 2 个 JS 运行时依赖（`undici` / `yaml`），整体约几十 MB。

```bash
git clone https://github.com/HengXin666/freebuff-proxy.git
cd freebuff-proxy

# （可选）按需配置管理员密码、代理、端口
cp .env.example .env
# 编辑 .env：建议设置 ADMIN_PASSWORD

# 一键启动（自动拉取 GHCR 预构建镜像，无需本地构建）
docker compose up -d
```

启动后：

```bash
# 查看首次启动的管理员密码（仅当 .env 里 ADMIN_PASSWORD 为空/未设置时才随机生成）
docker compose logs freebuff-proxy | grep -B2 -A6 "首次启动"
# 注意：`docker compose logs -f` 不会回放启动瞬间的历史日志，
# 拿不到密码时用上面的命令（不带 -f）整段翻。
```

浏览器打开 `http://<宿主机IP>:<PORT，默认8787>/`，用管理员账号登录，在「总览 → + 添加账号」里完成 Freebuff 登录回调（[详见 Web 控制台](docs/web-console.md)），即可开始使用。

> 网络为 host 模式（Docker 官方方案）：容器与宿主机共享网络栈，应用直接监听宿主 `0.0.0.0:<PORT>`，
> 无需 docker 端口映射（host 模式下 `ports` 会被忽略）；`PORT` 可在 `.env` 调整。

常用命令：

```bash
docker compose ps            # 状态
docker compose logs -f       # 日志
docker compose restart       # 重启
docker compose pull          # 拉取最新镜像
docker compose down          # 停止（数据保留在 ./data）
```

> 升级方式：`git pull && docker compose pull && docker compose up -d`（数据都在 `./data`，不动）。

### 想本地构建？（可选，开发调试用）

默认使用 GHCR 预构建镜像（发版 `v*` tag 时自动推送，`latest` + 版本号 tag，如 `1.13.3`，semver 去 `v` 前缀）。
想自己构建的话，把 compose 里的 `image: ghcr.io/hengxin666/freebuff-proxy:latest` 换成 `build: .`：

```yaml
build: .
```

```bash
docker compose up -d --build
```

首次启动会自动把 `config.example.yaml` 复制为 `/data/config.yaml`，无需手动创建。数据目录结构与构建细节见 **[部署与运维](docs/deployment.md)**。

---

## 文档

主页只保留上手所需的内容，深入细节都在 `docs/`：

| 文档 | 内容 |
|------|------|
| **[部署与运维](docs/deployment.md)** | `/data` 里各文件的作用、持久化与备份、GitHub Actions 自动构建镜像 |
| **[Web 控制台](docs/web-console.md)** | 登录与忘记密码找回、添加 Freebuff 账号的浏览器回调、用户与 API Key 管理 |
| **[多账号池与调度](docs/scheduling.md)** | 账号池自动切号、粘性优先（drain, not rotate）、Freebucks 额度口径与额度保护、工具签名兼容与工具被拒兜底 |
| **[连接治理与重启兜底](docs/connection-health.md)** | 上游卡死自动掐断（幽灵连接）、客户端断开即释放账号锁、全部断开重连、重启服务 |
| **[代理支持](docs/proxy.md)** | 全局代理池、出口分配规则、代理优先级与连通性测试 |
| **[多模态（图片输入）](docs/multimodal-image-input.md)** | 上游图片支持现状、哪些模型能看图、代理与 DSH 链路上的实际断点 |
| **[下游 Agent 接入](docs/api.md)** | `chat/completions` 行为、全部路由表、开放 API 批量导入/删除账号 |
| **[命令与本地开发](docs/development.md)** | npm 脚本、本地启动、CLI 登录、冒烟测试 |
| **[截图生成](docs/screenshots.md)** | README 截图怎么用 mock 上游 + 无头 Chromium 复现（含打码） |
| **[配置参考](docs/configuration.md)** | 每一项配置的唯一来源总表 |

---

## 下游 Agent 接入

调用示例（模型由 Agent 决定，`base_url` 指向本服务，API Key 用 Web 用户自己的 Key 或 `server.api_keys`）：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-fb-xxxxxxxx（控制台里你自己的 Key）" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "stream": true,
    "messages": [{"role":"user","content":"你好"}]
  }'
```

主要路由（完整列表见 **[下游 Agent 接入](docs/api.md)**）：

| 路径 | 作用 |
|------|------|
| `POST /v1/chat/completions` | 主路径（session + 透传） |
| `GET /v1/models` | 可用模型目录 |
| `GET /v1/freebuff/status` | 当前账号与 session 快照 |
| `GET /v1/freebuff/accounts` | 账号列表与冷却状态 |
| `GET /healthz` | 存活探针 |

---

## 限制（官方免费层现实）

- 2026-09 起免费层改为 **Freebucks** 计量：每个模型有单价（N Freebucks/小时），
  **admit 一次就按整小时单价买断**——之后用 3 秒还是 59 分钟扣的一样多，**提前 DELETE 不退**。
  每日池太平洋午夜重置（每账号每天约 25 Freebucks ≈ Flash 的 1 小时，具体以上游 `freebucks` 返回为准）。
  代理的空闲释放 / 新会话预算 / 失败即释放，目的是**少开会话**（空闲释放本身只是释放上游会话槽位，不省钱）。
- Luna 等 premium：大约每天 6×1 小时 session（共享 premium 池）。
- Flash：CLI full 访问下次数较松，仍有 spend / IP / 容量限制。
- 同账号由另一个客户端重新 admit 可能触发 `superseded`；同一 `instanceId` 内的并发 chat 流可正常共用。
- 地区 / VPN / 封禁由上游决定。
- 本项目**不**绕过风控，也**不**保证无限额度。

---

## 说明

- **发布与更新日志**：[Releases](https://github.com/HengXin666/freebuff-proxy/releases)
- 本项目使用 [MIT License](./LICENSE)。
- 本项目使用 Freebuff 官方接口，仅用于个人便利；请自行遵守其服务条款，并自行承担账号风险。
