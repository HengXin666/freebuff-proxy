<div align="center">
<h1>freebuff-proxy</h1>
<p><strong>把 Freebuff 的免费额度,变成一个 OpenAI 兼容的 API 端点.</strong></p>
<p>
<a href="https://github.com/HengXin666/freebuff-proxy/releases"><img src="https://img.shields.io/github/v/release/HengXin666/freebuff-proxy?label=release&color=2496ED" alt="Release"></a>
<a href="https://github.com/HengXin666/freebuff-proxy/actions/workflows/docker-image.yml"><img src="https://github.com/HengXin666/freebuff-proxy/actions/workflows/docker-image.yml/badge.svg" alt="CI"></a>
<a href="./LICENSE"><img src="https://img.shields.io/github/license/HengXin666/freebuff-proxy?color=green" alt="License"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white" alt="Node"></a>
<a href="https://github.com/HengXin666/freebuff-proxy/pkgs/container/freebuff-proxy"><img src="https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white" alt="Docker"></a>
</p>
<p><strong>超轻量</strong> . <strong>一键 Docker 部署</strong> . <strong>一切管理都在前端页面</strong></p>
</div>

下游 Agent 只需要标准的 `base_url + api_key + model`,本服务负责 Freebuff 身份凭证(多账号池),免费 session 准入,协议形态与额度调度,并把**流式 / 非流式响应原样透传**.

> 本项目使用 Freebuff 官方接口,与 Freebuff 官方无隶属关系.计费与额度**最终以上游实时返回为准**.

---

## 截图

<p align="center"><img src="docs/images/01-overview.webp" alt="总览:账号池,额度(Freebucks),并发与冷却"></p>

<table align="center">
<tr>
<td width="50%">

**测试对话** -- 经 `/v1/chat/completions` 真实转发(流式)

![测试对话](docs/images/02-playground.webp)

</td>
<td width="50%">

**我的** -- 你的 API Key 与接入示例

![我的](docs/images/04-me.webp)

</td>
</tr>
</table>

**用户管理** -- 建用户,改角色,重置 Key(管理员)

<p align="center"><img src="docs/images/03-users.webp" alt="用户管理"></p>

> 截图用 mock 上游 + 无头 Chromium 生成,账号与 API Key 均为占位值并已打码([复现方式](docs/guide/screenshots.md)).

---

## 快速开始

镜像非常轻量:`node:22-alpine` + 仅 2 个运行时依赖(`undici` / `yaml`),整体约几十 MB.全仓 TypeScript,由 Node 22 原生直跑,没有打包/转译步骤.

```bash
git clone https://github.com/HengXin666/freebuff-proxy.git
cd freebuff-proxy
cp .env.example .env      # 建议设置 ADMIN_PASSWORD
docker compose up -d      # 自动拉取 GHCR 预构建镜像，无需本地构建
```

浏览器打开 `http://<宿主机IP>:8787/`,用管理员登录,在[总览 → + 添加账号]完成 Freebuff 登录回调即可开始使用.

```bash
docker compose logs freebuff-proxy | grep -A6 "首次启动"   # 未设 ADMIN_PASSWORD 时查看随机密码
docker compose logs -f      # 日志
docker compose pull && docker compose up -d   # 升级
docker compose down         # 停止（数据保留在 ./data）
```

> 网络为 **host 模式**:容器与宿主机共享网络栈,应用直接监听宿主 `0.0.0.0:<PORT>`,无需端口映射(host 模式下 `ports` 会被忽略).
> 想本地构建:把 compose 里的 `image:` 换成 `build: .` 后 `docker compose up -d --build`.

---

## 三步接入

接入永远是这三样,剩下的都在控制台里点:

| 是什么 | 填什么 |
|---|---|
| `base_url` | `http://<宿主机IP>:8787/v1` |
| `api_key` | 控制台[我的]页里你自己的 Key(`sk-fb-...`) |
| `model` | `GET /v1/models` 返回的任一模型名 |

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-fb-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","stream":true,
       "messages":[{"role":"user","content":"你好"}]}'
```

主要端点:

| 路径 | 作用 |
|------|------|
| `POST /v1/chat/completions` | 主路径(session + 透传) |
| `GET /v1/models` | 可用模型目录 |
| `GET /v1/freebuff/status` . `GET /v1/freebuff/accounts` | 账号与 session 快照,冷却状态 |
| `GET /healthz` | 存活探针 |

---

## 配置入口

**日常操作全在控制台页面,不用改任何配置文件.**

| 要改什么 | 在哪改 | 落地位置 |
|---|---|---|
| 代理(全局池) | 控制台[代理设置]:加/删/测试/保存,立即生效 | `/data/proxies.json` |
| 账号 | 控制台[总览 → + 添加账号]:导入 JSON 或浏览器登录回调 | `/data/credentials/` |
| 用户与 API Key | 控制台[用户管理]:建/删/改密/重置 Key | `/data/users.json` |
| 管理员密码 | `.env` 的 `ADMIN_PASSWORD`,或首次启动日志里的随机值 | `.env` |

`config.yaml` 只作兜底默认值,不是日常入口.每一项配置的唯一来源见 [配置参考](docs/guide/configuration.md).

---

## 计费与额度

上游按 **Freebucks(FB)** 计费:每个模型有单价(FB/小时),**admit 一次按整小时买断**;这一小时内继续发请求**边际成本为 0**,而提前 `DELETE` **拿不回 Freebucks** ---- 所以**付费时段内不为空闲释放**(详见 [调度与额度保护](docs/design/scheduling.md#额度保护freebucks-计费控制台可调)).每日池在太平洋午夜重置(官方档约 25 FB,走代理时实测 20).

上游没有可引用的静态价格表,定价在每次 session 响应的 `freebucks.prices` 里.本服务**不写死价格**,直接读上游实时值:

```bash
npm run pricing            # 人类可读的实时价目表（GET 探测，不创建 session、不消耗额度）
npm run pricing -- --json  # 机器可读
```

---

## 上游请求链路

上游请求**只有一条链路**:主服务(Node)把请求 **RPC 委托给 `cli-bridge/`(官方同款 bun 执行)**,由它按**官方客户端抓包真值**发出 ---- 官方 37 工具,官方 system 模板,desktop 世代 agent,分层 provider.

主服务**不再自己拼上游请求**:旧的自拼形态(CLI 开场白 + 自编签名工具 + CLI 世代 agent + 自管 session 调度)已**废弃并禁止调用**(`config.resolveUpstreamChannel()` 会强制回落并告警,控制台选项置灰).原因是旧形态与官方抓包**逐字段不符**,实测 admission 反复失败(`purchase_claim_released`),会制造"看起来在跑,实际全被拒"的假象.**协议实现只有一份**(在 `cli-bridge/`),主服务只传参数,拿响应透传.

**客户端带自定义工具**:合并而非替换 ---- 官方工具集在前(满足工具指纹)+ 客户端工具按名去重追加.注意代理**不执行**工具,只把上游的 `tool_call` 原样返回,由客户端执行.

细节见 [两条链路选型与工具转换](docs/reverse/18-channel-guide-and-tool-mapping.md).

---

## 限制(官方免费层现实)

- **每模型每日会话次数有限**:limited 档实测 **6 次/模型/天**.用满后该模型 503 且购买被退款作废 ---- 这也是**多账号池是刚需**的原因.验证前先看 `rateLimitsByModel`(控制台[额度]列可见).
- **并发槽位 `slotLimit: 1`**:与官方客户端**互斥** ---- 官方客户端正在用同一账号时,本服务会拿到 `purchase_in_use` / `purchase_capacity`.
- 地区 / VPN / 封禁由上游决定;本项目**不**绕过风控,也**不**保证无限额度.

---

## 常见问题

**登录不进 / 忘了管理员密码?** 看 `docker compose logs freebuff-proxy | grep -A6 "首次启动"`;已设 `ADMIN_PASSWORD` 就以它为准.详见 [Web 控制台](docs/guide/web-console.md).

**容器里连不上宿主机的代理?** host 模式下直接在控制台[代理设置]填 `http://127.0.0.1:<端口>` 即可,不需要网关 IP.详见 [代理支持](docs/guide/proxy.md).

**明明有额度却 429 / 一直 503?** 先看控制台[额度]列的 `rateLimitsByModel`.503 是**模型侧**问题,不要靠换账号解决.详见 [多账号池与调度](docs/design/scheduling.md).

**改了 `config.yaml` 里的上游地址没生效?** 上游 API 地址是硬编码的,只有 `FREEBUFF_UPSTREAM_API_BASE` 环境变量能覆盖(仅供本地对照/契约测试).

**连接一直挂着不断开?** 有 idle 超时兜底与断开释放.详见 [连接治理](docs/guide/connection-health.md).

---

## 文档

完整索引与真源声明见 [docs/README.md](docs/README.md).常用入口:

| 文档 | 内容 |
|------|------|
| **[部署与运维](docs/guide/deployment.md)** | `/data` 文件作用,持久化与备份,自动构建镜像 |
| **[Web 控制台](docs/guide/web-console.md)** | 登录与找回密码,添加账号,用户与 API Key 管理 |
| **[配置参考](docs/guide/configuration.md)** | 每一项配置的唯一来源总表 |
| **[代理支持](docs/guide/proxy.md)** | 全局代理池,出口分配,连通性测试 |
| **[连接治理](docs/guide/connection-health.md)** | 幽灵连接掐断,客户端断开释放,重启兜底 |
| **[多账号池与调度](docs/design/scheduling.md)** | 自动切号,粘性优先,额度口径与额度保护 |
| **[调度与归还点数的调研史](docs/design/account-scheduling-and-refund.md)** | 计费口径的纠错过程与一手证据 |
| **[下游 Agent 接入](docs/design/api.md)** | `chat/completions` 行为,全部路由,批量导入账号 |
| **[代码质量全景](docs/quality/code-quality-landscape.md)** | 红线,门禁与现状(面向维护者) |
| **[协议逆向](docs/reverse/00-overview.md)** | 官方客户端协议逆向:设备签名,会话准入,chat 与工具,抓包归档与逐字段 diff |

---

## 说明

- **发布与更新日志**:[Releases](https://github.com/HengXin666/freebuff-proxy/releases)
- [MIT License](./LICENSE).本项目使用 Freebuff 官方接口,仅用于个人便利;请自行遵守其服务条款并承担账号风险.
