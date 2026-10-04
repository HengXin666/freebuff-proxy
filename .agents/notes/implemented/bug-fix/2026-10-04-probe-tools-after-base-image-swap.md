# Agent Note: 换基镜像会带走探活工具 —— HEALTHCHECK 与测试脚本必须用 node

Status: implemented

## Problem

v1.22.0 把基镜像从 `node:22-alpine` 换成 `node:22-slim`（为了让 glibc 的 bun
能跑，见
[bun-in-image-and-never-release-paid-hour.md](./2026-10-04-bun-in-image-and-never-release-paid-hour.md)），
CI 的 `image-boot` job **13 个场景全部 FAIL**。

而**应用本身完全正常**：日志里 `healthz 200`、手动在容器内 curl 登录返回 200
且带 `set-cookie`。失败全是"工具缺失"造成的假象：

```
healthz 200（health=starting）
Docker HEALTHCHECK 未通过（新容器一直 health: starting）
容器内 admin 登录失败（拿不到会话 cookie）      ← 应用其实返回了 200
控制台接口异常: /api/me=>无响应, /api/accounts=>无响应, …
```

根因：**alpine 的 `wget` 是 busybox 内置，Debian 没有**。而三处都用它：

1. `Dockerfile` 的 `HEALTHCHECK … wget …`
2. `scripts/pipeline-image-test.mjs` 的 `loginInsideContainer()`（容器内登录取 cookie）
3. 同文件的 `probeAuthedEndpoint()`（容器内打受保护接口）

## Decision

**全部改用 node**（基镜像就是 node，零额外依赖、永不缺失）。

- `HEALTHCHECK` 用 `node -e` 发一次 HTTP 请求判 200。
- 测试脚本两个函数改走 `node -e`。

### 改 node 之后踩到的两个坑（都留了注释）

1. **`node -e "多行脚本"` 不可行**：`JSON.stringify` 会把换行转义成**字面
   `\n`**（反斜杠 + n），而外层 `sh -c` 不解释它 → node 收到含字面 `\n` 的
   单行 → `SyntaxError: Invalid or unexpected token`。
   → 用**分号分隔的单行脚本**。
2. **`http.request(options, callback)` 的两部分之间必须是逗号**：用
   `parts.join(';')` 拼接时把那个逗号拼成了分号
   （`http.request({…}; res=>{…})`）→ 语法错误 → 脚本静默失败 → 输出为空
   → 断言判成"接口无响应"。
   → 把 options + callback 合成**单个字符串**，内部用逗号。

### cookie 提取不再依赖打印格式

原先按"单行大括号"去匹配 `"set-cookie"` 那行 JSON。但 `console.log` 的输出
换行位置不固定，JSON 对象可能跨行 → 登录明明成功却判"拿不到会话 cookie"。
→ 直接从整段输出抓 `fb_session=`。

## Alternatives considered

- **换回 alpine** —— 不行：bun 是 glibc 二进制，alpine 的 musl 跑不起来
  （实测 `Error relocating: __pthread_key_create: symbol not found`，
  装 gcompat 也一样）。基座必须留 slim。
- **在 slim 里装 wget** —— 能少改代码，但白加一个包只为探活；node 本来就在，
  用它更省且更稳（`node -e` 不依赖任何外部命令）。
- **给 HEALTHCHECK 装 curl** —— slim 其实自带 curl，但同理：为一个探活动作
  引入外部二进制依赖，不如用 node。
- **改测试脚本让它在宿主侧登录** —— 原设计刻意在**容器内**做：宿主侧端口映射
  下 cookie 的 Secure/Domain 判定与浏览器不同，映射后取不到会误报"登录坏了"。
  这个理由仍然成立，所以是改工具、不是改位置。
- **把 13 个场景的失败容忍掉（允许 health=starting）** —— 那等于关掉这条门禁。
  它抓过真实故障（数据文件自检接口 500），不能弱化。

## Consequences

- **HEALTHCHECK 依赖 node 启动**（约几十毫秒），比 wget 稍慢；interval 30s
  下无影响。
- **测试脚本的探活脚本是单行 mega-string**，可读性略差 —— 已用注释说明为什么
  不能换行（上面的坑一）。
- **`docker exec` 时 `FREEBUFF_PROXY_PORT` 不存在**（它是起容器时 `-e` 设的），
  脚本里用 `|| 8787` 兜底 —— 这与 `CONTAINER_PORT = 8787` 一致。
- 将来**任何**替基镜像的改动都要重新检查：HEALTHCHECK 命令、脚本里的容器内
  命令，是否依赖了被换掉的那个发行版的内置工具。

## Evidence

- 容器实测：改前 `health=starting`（一直）→ 改后 `health=healthy`。
- `node scripts/pipeline-image-test.mjs` → **13/13 场景通过**，退出码 0
  （改前：1/13，12 个 FAIL）。
- 中途两次真实错误都记在 Decision 里：字面 `\n` 的 SyntaxError、
  `};res=>` 的语法错误（后者导致"8 个接口全部无响应"的误判）。
- 门禁：typecheck 过；`npm test` 全绿；`check-i18n` ok。
