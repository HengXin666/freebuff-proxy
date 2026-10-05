freebuff-cli-bridge — 用官方 bun 运行时承载上游请求

为什么有这个目录

`docs/reverse/11-tls-fingerprint.md` 实测:Node 与官方客户端的 TLS Client Hello
可区分(52 vs 17 ciphers,官方有 `status_request`/SCT,无 `encrypt_then_mac`).

第三方实现(lza6)声称检测在 TLS 指纹层,其解法是换一门语言的 TLS 栈.
但那个结论有个漏洞:它换栈时出口 IP,请求节奏,账号新鲜度一起变了,
没有做单变量对照.

而我的反证也有对称的漏洞:我用"Node 打 models/admission 拿到 200"推出
"TLS 不是闸门" —— 但上游完全可能按端点分级检测(只读端点不查,昂贵的
chat 端点才查,这是常规的性能取舍).我在 chat 端点没有证据,不能外推.

于是这个目录做一件事:消除这个变量.

思路:对齐,不是伪装

不用 uTLS 去伪造 Chrome 指纹(那是伪装,与项目定位冲突;
也需要原生依赖,与"仅 2 个运行时依赖"的轻量铁律冲突).

改为直接用官方自己的运行时发请求:官方客户端的 orchestrator
本身就是 `resources/bun/bun`(v1.4.2)跑的.同一运行时 → 同一 TLS 栈 →
Client Hello 与官方同源.

这不是绕过检测:登录态,设备签名,catalog 协议全部照常带真货,
只是承载它们的 TLS 栈与官方一致.

结构

```
freebuff-cli-bridge/
├── bun            官方客户端自带的 bun 1.4.2（79MB，已从 AppImage 固化）
├── upstream.ts   跑在 bun 里的上游请求层（设备签名/目录协议/chat 全在此）
├── bridge.ts     Node 侧封装：spawn bun、构造 cfg
├── serve.ts      OpenAI 兼容服务：/v1/models、/v1/chat/completions、/healthz
└── README.md
```

用法

```bash
PORT=8791 node serve.ts
curl http://127.0.0.1:8791/v1/models
curl -X POST http://127.0.0.1:8791/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"mimo 2.6 flash","messages":[{"role":"user","content":"hi"}],
       "tools":[{"type":"function","function":{"name":"get_weather",
         "parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}'
```

单独调 bun 层(调试用):

```bash
./bun upstream.ts '{"cfg":{...},"action":"catalog"}'
echo '{"cfg":{...},"action":"full","modelKey":"m-00032eaeec",
      "messages":[{"role":"user","content":"hi"}]}' | ./bun upstream.ts
```

action:`catalog` / `session` / `admit` / `startRun` / `chat` / `full`

凭据来源优先级

1. 官方客户端登录态 `~/.config/freebuff-desktop/state.json`
   —— 天然带 `userId` 与 `installId`,并自动匹配设备密钥 `keyId`.
2. 回落到 `../freebuff-proxy/credentials/*.json` 第一个有 `authToken` 的文件
   (无设备签名,形态不完整,仅用于只读验证).

已实现的协议件(全部逐字对齐官方 orchestrator.js)

- 设备签名 Ed25519:载荷 6 行 `\n` 分隔,raw 公钥,三头齐发
- catalog 协议:`x-freebuff-catalog-protocol: 1` + `x-freebuff-catalog-fetch`
- admission:`x-freebuff-model` 传 handle(不传 key,否则 `freebuff_catalog_stale`)
- chat:`model` 传 handle;`run_id` 在 `codebuff_metadata` 里(顶层传必 400)
- agent:目录模式统一 `base3-free-catalog`
- system 开场白:base3 版本 `You are Buffy, the coding agent behind Codebuff.`
- 官方签名工具:`lookup_agent_info`(带真参数 schema)+ `decide`
- 客户端环境描述符:`freebuff_client_env`

详见 `../freebuff-proxy/docs/reverse/` 的 02/03/04 三篇.

当前状态

- Node → bun 桥接打通;bun 侧 catalog 200(上游接受该 TLS 栈)
- OpenAI 兼容服务可跑,`/v1/models` 正常
- ⏸ chat 端到端未验证:所有可用凭据的 session 端点均为
  `403 status: banned`,需要全新账号

验证时服务端会原样透传上游响应(含 admit/startRun 各阶段状态),
便于归因到底是卡在哪一跳.
