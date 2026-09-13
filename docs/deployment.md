# 部署与运维

> 本文是 [freebuff-proxy](../README.md) 的详细文档之一。数据持久化（/data 里都有什么）与 GitHub Actions 自动构建镜像的细节。
> 快速上手 / 一键部署请看 [主页 README](../README.md)。
## 数据与持久化（/data 挂载）

所有状态都落在宿主机 `./data`（容器内 `/data`），**删除容器 / 升级镜像都不丢数据**：

```text
data/
├── config.yaml            # 首次启动自动生成，可直接编辑（重启生效）
├── credentials/           # Freebuff 账号凭据（每账号一个 <账号ID>.json，见下）
├── users.json             # Web 控制台用户（密码 scrypt 哈希）
├── web-sessions.json      # Web 登录会话
├── login-flows.json       # 浏览器登录回调流程（重启不丢）
├── catalog-cache.json     # 上游模型目录缓存（首启写入，每 6h 自动刷新）
├── custom-models.json     # 前端「模型管理」的自定义模型
├── proxies.json           # 前端「代理设置」的全局代理池
└── settings.json          # 前端可调的运行参数（并发/额度保护等）
```

- 首次启动自动把 `config.example.yaml` 复制为 `/data/config.yaml`，无需手动创建。
- `docker-entrypoint.sh` 以 root 初始化 `/data` 属主后自动降权到 `node`(1000) 运行。
- 凭据、用户、会话均以 `0600` 权限写入，**建议对 `./data` 做好备份与访问控制**。

## GitHub Actions 自动构建镜像

`.github/workflows/docker-image.yml`：

- **push 到 `main` / `master`**：跑测试（`npm test` + `npm run typecheck`）→ Docker Buildx 构建 → 推送 `ghcr.io/<repo>:latest`、`:sha-<hash>`、`:<branch>` 等 tag。
- **打 `v*` tag**：额外推送 `:<version>`、`:<major>.<minor>` 语义化 tag。
- **pull_request**：只跑测试，不推送（防止 PR 污染镜像）。
- **手动触发**：Actions 页面 → Run workflow。
- **可选 Docker Hub**：在仓库 Secrets 配置 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 后会自动同时推送 Docker Hub。

构建使用 `docker/build-push-action` 的 GHA 缓存（`cache-from/to: type=gha`），后续构建秒级缓存。
## 升级 / 换镜像后排障（真实踩过的坑）

### 症状与处置

**症状 A：换新镜像后容器起不来（反复重启 / 立刻退出）**

先看日志里的数据文件自检（每个版本启动都会打印）：

```bash
docker logs --tail 60 freebuff-proxy
```

- 看到 `[freebuff-proxy] ⚠ 数据文件损坏: /data/xxx.json` → `data/` 里某个 JSON 坏了。
  停服后把该文件移走再启动即可（程序按默认值重建）：
  ```bash
  docker compose down
  mv data/xxx.json data/xxx.json.broken      # 保留现场，便于人工恢复
  docker compose up -d
  ```
- 看到 `[freebuff-proxy] 拒绝启动：数据文件损坏，不能安全引导管理员账号` →
  **`users.json` 损坏**。这是唯一一个「损坏就拒绝启动」的文件：它是控制台登录凭据
  （密码哈希 + API Key）的唯一真源，自动重建会让你以为账号全丢了，而原文件其实
  还在盘上。按日志里给的两条路二选一（恢复原文件 / 移走重新引导）。
- 日志里没有上面任何一行、但进程就是起不来 → 大概率不是数据问题，看容器退出码
  `docker inspect <容器> --format {{.State.ExitCode}}`，再贴完整日志排查。

**症状 B：升级后某个功能被重置了**（代理池空了 / 额度保护回到默认 / 模型管理被清空）

说明对应的 JSON 内容不符合本版本预期，或文件被写坏了。控制台
**总览 → 数据文件自检** 会把每个文件的装载状态（正常 / 尚未生成 / 损坏 + 原因）
和**可直接复制的处置命令**列出来。修复前对应功能只会降级（回落默认值），
不会拖垮服务。

### 哪些文件删了没事、哪些不能删

| 文件 | 损坏/删除的后果 | 能否自动重建 |
| --- | --- | --- |
| `catalog-cache.json` | 无（启动会用内置目录重新生成） | ✅ 自动重建，损坏原件备份为 `*.corrupt-<时间>` |
| `custom-models.json` | 自定义模型 / 隐藏列表丢失 | ✅ 空着启动，重新配置即可 |
| `proxies.json` | 全局代理池变空 → 直连 | ✅ 空着启动，前端重新填 |
| `settings.json` | 额度保护等参数回落 `config.yaml` 默认值 | ✅ 空着启动 |
| `web-sessions.json` | 所有人需要重新登录控制台 | ✅ 空着启动 |
| `login-flows.json` | 等待中的登录流程作废（重新发起即可） | ✅ 空着启动 |
| `account-state.json` | 账号履历（加入/封禁时间、冷却、Freebucks 余额）丢失 | ✅ 空着启动（但「余额买不起就别 admit」的闸门暂时失效） |
| `sessions.json` | **丢失未结清的上游会话句柄 → 删不掉也退不了款**（白扣整小时） | ⚠️ 会重建，但这笔钱要不回来 |
| `users.json` | **丢失控制台账号与 API Key** | ❌ 拒绝启动，必须人工处置 |

> 结论：出问题时**优先只删派生/配置类文件**（表格前 7 行），
> `sessions.json` 与 `users.json` 请先备份再动。

## 镜像流水线（scripts/pipeline-image-test.mjs）

CI 里的 `npm test` 用 mock 上游、**不启动容器**，所以覆盖不到「新镜像 + 真实 /data」
这条路 —— 真实事故正是发生在这里（换镜像后容器起不来，删几个 json 才恢复）。

```bash
npm run pipeline:image                       # 构建镜像 + 跑全部场景
npm run pipeline:image -- --no-build         # 只测已有镜像
npm run pipeline:image -- --image ghcr.io/hengxin666/freebuff-proxy:latest
npm run pipeline:image -- --keep             # 保留 fixture 与容器便于排查
```

它会真实构建、真实起容器、真实打健康检查，逐场景断言：

| 场景 | 期望 |
| --- | --- |
| 空 `/data`（首次启动） | 正常启动，`/healthz` 200，Docker HEALTHCHECK 通过 |
| 当前 `data/` 副本（旧数据 + 新镜像） | 同上 |
| 逐个把某个 JSON 写坏 | 能启动的必须**降级启动并在日志里点名**该文件 |
| `users.json` 写坏 | **拒绝启动**（exit ≠ 0）且日志说明原因与处置办法 |

全程离线：测试目录**不含凭据**，不会连上游、不消耗任何额度
（需要真连上游时加 `--with-credentials`）。
