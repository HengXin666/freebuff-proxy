# 01 — 运行时与产物:源码从哪来,登录态在哪

## 1.1 进程结构(本机实测)

```
/home/hx/Downloads/Freebuff-0.0.156-linux-x86_64.AppImage   (PID 53437, 启动器)
└── /tmp/.mount_FreeburTELHM/@codebufffreebuff-desktop      (PID 53434, Electron 主进程)
    ├── --type=gpu-process / utility(network) / renderer    (Chromium 子进程)
    └── resources/bun/bun  resources/orchestrator/orchestrator.js   (PID 53568)
```

**关键结论**:Electron 只是壳.真正的协议逻辑全在
`/tmp/.mount_FreeburTELHM/resources/orchestrator/orchestrator.js`
(9.4 MB / 217125 行,bun 打包,未混淆,可读).

AppImage 是只读挂载,重启客户端会换挂载点(`/tmp/.mount_FreebufXXXX`).
取证要**先解包到本地**,别依赖挂载点:
```bash
npx --yes @electron/asar extract \
  /tmp/.mount_FreeburTELHM/resources/app.asar /tmp/fbrev/asar
```
解包产物里 `electron/*.cjs` 是壳逻辑,`src/` 只剩一个 svg(业务代码已全进 orchestrator.js).

## 1.2 orchestrator 本地 HTTP 服务

```
127.0.0.1:34227   （端口每次启动随机，ss -ltnp 查 "@codebufffreebu"）
```
直连返回 `401 {"error":{"kind":"bad_request","message":"missing or invalid token"}}`,
说明它要求 token —— 端口暴露但鉴权,不可当作无门槛入口.

## 1.3 登录态文件(本次唯一授权凭据来源)

路径由 `orchestrator.js:176509` `desktopStatePath()` 决定:
```
~/.config/freebuff-desktop/state.json
```
(可用 `FREEBUFF_DESKTOP_STATE_PATH` 覆盖)

结构:
```jsonc
{
  "installId":  "5a989c7b-...",   // → x-freebuff-install-id
  "machineId":  "268f38b9-...",
  "authSessions": {
    "https://www.codebuff.com": {
      "token": "553262d1-...",
      "user": { "id": "54393a42-...", "email": "...", "name": "..." }
    }
  },
  "uiPrefs": { ... },
  "workspace": { ... }
}
```

同目录伴生文件:
```
state.json.device-key.json        # Ed25519 设备密钥 + registrations
state.json.auth-secrets.json      # 加密态凭据（有 vault 时）
state.json.session-ends.json      # 会话结束流水
state.json.session-refunds.json   # 退款流水
state.json.orchestrator-lock.sqlite
```

## 1.4 主机常量(源码硬编码)

`orchestrator.js:176064-176081`
```js
var FREEBUFF_WEB_URL_PROD = "https://freebuff.com";
var PROD_API_HOST = "https://www.codebuff.com";
var configuredApiHost = "https://www.codebuff.com";
var API_HOST = canonicalizeHost(configuredApiHost);
var AUTH_HOST = canonicalizeHost(process.env.FREEBUFF_AUTH_HOST || (API_HOST === PROD_API_HOST ? FREEBUFF_WEB_HOST : API_HOST));
var CONVEX_URL = canonicalizeHost(process.env.FREEBUFF_CONVEX_URL || "https://harmless-tapir-303.convex.cloud");
```

 注意:API 主机是 **`www.codebuff.com`**,而 Web 是 **`freebuff.com`**.
仓库里若写成 `codebuff.com`(无 www)是**另一个主机**,可能被当异常.

## 1.5 复现命令备忘

```bash
# 查挂载点与进程
ps -eo pid,ppid,etime,cmd | grep -i freebuff | grep -v grep
ss -ltnp | grep codebuff

# 解包
npx --yes @electron/asar extract <挂载点>/resources/app.asar /tmp/fbrev/asar

# 读源码（行号引用本文各处）
sed -n '176060,176090p' <挂载点>/resources/orchestrator/orchestrator.js
```
