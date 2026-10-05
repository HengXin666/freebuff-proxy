# 16 — 成功:HTTP 200 + 工具调用(deepseek,对齐后)

> 2026-10-03 实测,账号 `ce620a8c`,模型 **DeepSeek V4.1 Flash**(`m-096e75164d`).
> 全程通过 `cli-bridge`(bun 运行时,TLS 与官方同源),凭据取自官方客户端登录态.

## 结果

```
admission  → 200 {"status":"active"}
instanceId → f4532a24-a19b-4189-89e0-bd469c9a6602     ← 裸 UUID
agent-runs → 200 {"runId":"07f43045-..."}
chat       → 200  
tool_calls → write_file  
```

```jsonc
{
  "id": "call_419e9e547eab454d8b3ed98c",
  "name": "write_file",
  "args": "{\"path\":\"/tmp/aligned-proof.txt\",
            \"instructions\":\"Create aligned-proof.txt containing the text aligned-ok\",
            \"content\":\"aligned-ok\\n\"}"
}
```

流式响应正常(`chatcmpl-7ea6822d`),带 `reasoning_content`(思考链),
provider 回 `Luminal`.

## 为什么这次能通:对齐清单

按 `docs/reverse/15-protocol-review.md` 的 P0/P1 修完后才成功.关键几项:

| # | 修正 | 之前的错 |
|---|---|---|
| 1 | chat 头部**删掉 5 个**(instance-id / client / model / catalog-protocol / install-id) | 多发;官方 chat 只有 8 个业务头 |
| 2 | instance id 改**裸 UUID + 整场复用** | `cli:<uuid>` 每次新建 → 每次购买被全额退款作废 |
| 3 | agentId 改 **desktop 世代**(worker: `freebuff-desktop-thread-local-v3`) | 用 CLI 世代 `base3-free-catalog`,世代错配 |
| 4 | 工具集按层用**官方真实定义**(worker: 官方 37 个) | 自编签名工具;`lookup_agent_info` 在 desktop 根本不存在 |
| 5 | system 用**官方模板**(worker 7918 字符) | 用 CLI 的 base3 开场白 |
| 6 | `reasoning_effort` 走 `codebuff_metadata.freebuff_reasoning_effort` | 顶层字段(官方 0 次命中) |
| 7 | metadata 移除 `surface` / `freebuff_client_env` | 官方没有,是 CLI 侧的 |
| 8 | admission 补 `x-fb-timezone` / `x-freebuff-desktop-attempt-id` | 缺 |
| 9 | admission 重试覆盖 `purchase_in_use` | 只处理 `purchase_capacity` |

## 单变量验证的结论(P0-2)

review 报告推测 **`cli:` 前缀 + 每次新建** 是"购买被全额退款"的诱因
(官方回执里 `desktopRefunds` 从未出现,我们每次都退).

改成裸 UUID 复用后:**本次 admission 200 且未产生退款条目**.
这与 review 的推测一致,且成本远低于"换出口"方案.

 严格说这是**前后对比**而非纯净单变量(同时改了 agent 世代与工具集),
但退款条目的消失是最直接的信号.若要做纯净验证,可只回退 instance id 形态再看.

## 关于"文件没创建"

`/tmp/aligned-proof.txt` **没有**落盘 —— 这是**正确的**,不是失败:

我们拿到的是上游返回的 `write_file` **工具调用请求**.
代理的职责是把它原样返回给下游客户端;**执行工具是客户端的事**
(官方客户端收到后会在本地真的写文件).

判据是:200 + 文本/工具调用.我们拿到了 200 + 结构完整的 `write_file` 调用.

## 复现

```bash
node cli-bridge/serve.ts            # OpenAI 兼容服务
# 或直接用 action=full，layer=worker，modelKey=m-096e75164d
```

## 后续

- 若要把这条链路并回主项目 `src/proxy.ts`,需要同步上表 9 项
  (尤其是 chat 头部删 5 个,instance id 裸 UUID,agent 世代,工具集).
- FINISH 上报(P1-6)尚未实现,run 不会主动结束 —— 官方每次都发.
- `repo_snapshot` 仍是硬编码 0(P1-9),worker 层应为真实项目统计.
