# 截图生成器（README 用）

> 本文是 [freebuff-proxy](../README.md) 的详细文档之一。
> 说明 `docs/images/*.webp` 这四张 README 截图是怎么生成、怎么复现的。

## TL;DR

README 的截图**不连真实上游、不动真实账号**：用 `scripts/screenshot-mock-upstream.mjs`
起一个 mock 上游，用独立数据目录起一个临时控制台实例，再用 CDP 驱动无头 Chromium 抓图。
产物是 1400×880 的 WebP，直接覆盖 `docs/images/`。

## 为什么要 mock

真实控制台截图会暴露真东西：账号邮箱、`authToken`、下游 API Key，以及当时账号池的真实
处境（哪几个号被封了）。旧版截图用的是手捏的占位数据，但**上游会话 / Freebucks 额度 /
调度时间轴这些列全是空的**——因为这些值只有上游回答过 `/api/v1/freebuff/session` 之后才有。

所以脚本走 mock 上游：既能喂出有内容的额度/会话/封禁数据，又完全不碰真实凭据。

## 数据打码

截图脚本在抓图前会执行一次 DOM 文本替换：

| 目标 | 处理 |
|------|------|
| `sk-fb-*` API Key | 保留前 11 位 + `…` + 后 4 位 |
| 邮箱 | 本地部分只留前 2 字符（`al***@example.com`） |

演示数据本身用的就是 `alice/bob/carol@example.com` 这类占位值（见 mock 里的 `ACCOUNTS`），
打码只是第二层保险。

## 复现步骤

```bash
# 0. 依赖：node、chromium、python3 + Pillow（转 WebP）
mkdir -p /tmp/fb-shots/shots /tmp/fb-shots/data/credentials

# 1. 起 mock 上游（端口任意，别和真实服务冲突）
node scripts/screenshot-mock-upstream.mjs 18999 &

# 2. 写演示配置 + 占位凭据（authToken 用 tok-alice/tok-bob/tok-carol，与 mock 对应）
cat > /tmp/fb-shots/config.yaml <<'YAML'
server:
  host: 127.0.0.1
  port: 28787
  data_dir: /tmp/fb-shots/data
upstream:
  api_base: http://127.0.0.1:18999
  login_base: http://127.0.0.1:18999
web:
  cookie_secure: false
YAML
# credentials/*.json 见下方「占位凭据」

# 3. 起临时控制台实例
ADMIN_PASSWORD=demo1234 node bin/serve.js --config /tmp/fb-shots/config.yaml &

# 4. 登录 + 只读探测（把额度/session 灌进内存与账本）
curl -c /tmp/fb-shots/cj -X POST http://127.0.0.1:28787/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"demo1234"}'
curl -b /tmp/fb-shots/cj -X POST http://127.0.0.1:28787/api/accounts/probe \
  -H 'content-type: application/json' -d '{}'

# 5. 起无头 Chromium 并抓图
chromium --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --remote-debugging-port=9333 --window-size=1400,880 \
  --user-data-dir=/tmp/fb-shots/chrome about:blank &
node scripts/readme-screenshots.mjs 9333 http://127.0.0.1:28787 demo1234 /tmp/fb-shots/shots

# 6. 2x 抓图降采样到 1400×880 并转 WebP，覆盖 docs/images/
python3 - <<'PY'
from PIL import Image
import glob, os
for f in sorted(glob.glob('/tmp/fb-shots/shots/*.png')):
    im = Image.open(f).convert('RGB').resize((1400, 880), Image.LANCZOS)
    im.save('docs/images/' + os.path.basename(f).replace('.png', '.webp'),
            'WEBP', quality=82, method=6)
PY

# 7. 收拾干净（别留着监听）
kill %1 %2 %3
```

> 抓图脚本用 `deviceScaleFactor: 2`（即 2800×1760）渲染，再降到 1400×880——
> 文字比直接 1x 抓清晰得多。

## 占位凭据

三个文件放 `/tmp/fb-shots/data/credentials/`，文件名随意（如 `a1.json`）：

```json
{ "id": "00000000-0000-4000-8000-000000000001",
  "email": "alice@example.com", "name": "alice",
  "authToken": "tok-alice", "proxy": null }
```

`authToken` 换成 `tok-bob` / `tok-carol` 就是另外两个账号（`id` 末位相应改 2 / 3）。
mock 上游按 `x-codebuff-api-key` 头部识别账号，返回对应处境：

| 账号 | 演示处境 |
|------|----------|
| `tok-alice` | 有活跃 session、余额 25 FB（买得起 flash）→ **正在调度** |
| `tok-bob` | 上游 403 `banned` → **已被封禁** |
| `tok-carol` | 余额 12 FB（低于低额度阈值）→ **低额度** |

## 坑（都踩过）

1. **hash 路由不会重新加载页面**：只改 `location.hash` 的话 SPA 不会重新渲染，
   四张图会长得一模一样（都停在登录页）。必须 `Page.navigate` + `Page.reload`，
   再轮询 `#app` 的 `innerText` 长度确认视图真的画出来了。
2. **版本徽章不是本地文件**：`dashboard/version.json` 是发版流水线注入的构建产物
   （`.gitignore` 已忽略）。本地抓图前要先跑 `node scripts/inject-version.mjs`，
   否则徽章显示的是上一次注入的旧版本号。
3. **探测才有额度数据**：不调 `/api/accounts/probe` 的话，Freebucks / session 列全是空的。
4. **别用 `pkill -f <关键字>`**：关键字若同时出现在你自己那条 `bash -c` 命令行里，
   会把执行清理的 shell 一起杀掉。按 PID 杀。

## 相关

- 控制台整体说明见 **[Web 控制台](web-console.md)**
- 账号池调度与额度口径见 **[多账号池与调度](scheduling.md)**
