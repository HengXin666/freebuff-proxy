# 13 — 纯 UI 侦查：官方客户端的完整行为（零协议请求）

> 本章**全程只操作客户端界面**，不发任何上游请求。
> 起因：此前只要从代理侧发请求就必然封号，因此改为纯观察客户端自身行为。
> 工具：`tools/cdp-ui.mjs`（CDP 驱动，只做读 DOM / 点击 / 输入）。

## 13.1 方法

重启客户端时带 `--remote-debugging-port=9333`，用 CDP 连渲染进程：

```bash
/home/hx/Downloads/Freebuff-0.0.156-linux-x86_64.AppImage \
  --remote-debugging-port=9333
curl http://127.0.0.1:9333/json/list        # 拿 page target 的 ws 地址
node tools/cdp-ui.mjs eval  '<JS>'          # 只读
node tools/cdp-ui.mjs send  '.composer-input' '<文本>'   # 输入 + Enter
node tools/cdp-ui.mjs shot  /tmp/ui.png
```

## 13.2 UI 结构（实测）

| 元素 | 选择器 | 说明 |
|---|---|---|
| 输入框 | `.composer-input` | contenteditable；**页面上存在多个**，隐藏 tab 的那个 `width=0`，必须用可见的那个 |
| 模型选择器 | `.agent-trigger` | 显示 "DeepSeek V4.1 Flash\nMax" |
| 思考强度 | `.agent-effort` | 纯展示，与 trigger 同组 |
| 会话 tab | `.sidebar-thread-select` | 每个会话一个 |
| 模型菜单 | `.agent-menu-scroll` / `.agent-option` | 含价格与标签 |

⚠️ **坑**：`document.querySelector('.composer-input')` 会选到隐藏 tab 的
（坐标 0,0），输入无效。必须按可见性过滤。

## 13.3 模型菜单（实测，13 项）

```
Included Free Usage:
  Space Bunny Alpha (Images, Experimental)
  Laguna S 2.1 (New, Experimental)
  Ling 3.1 Flash (New, 2/hr)
  Solar Mini 4 (5/hr)
  MiMo 2.6 Flash (Recommended, Images)
  DeepSeek V4.1 Flash (15/hr) ← 15 Freebucks/hour
  ...
Premium / Paid plan:
  MiMo 2.6 Pro, Gemini 3.8 Flash, GPT-6.1 Sol, Muse Spark 1.3, GPT-6 Luna
```

**DeepSeek V4.1 Flash**：
- 价格 `15 Freebucks / hour`
- 标注 `May use data for AI training`
- 思考强度三档：**Low / High / Max**

这与 catalog 里该行的 `efforts: ["low","high","max"]` 完全一致 ——
**思考强度是从 catalog 读的，每个模型不同**（见 `05-thinking-effort.md`）。

## 13.4 端到端验证（纯 UI，零协议请求）

操作：在 DeepSeek V4.1 Flash 会话里输入
"Create a file /tmp/client-deepseek-proof.txt with the text hello-from-deepseek.
Use the write_file tool." 并按 Enter。

结果：
```
页面显示 "Freebuff finished responding"
文件被真实创建：
  /tmp/client-deepseek-proof.txt  20 字节  内容 "hello-from-deepseek"
  （此前 /tmp/client-proof.txt    17 字节  内容 "hello-from-client"）
```

**结论：官方客户端 + deepseek 模型，工具调用（write_file）真实生效、文件真实落盘。**

## 13.5 关键结论

1. **客户端链路完全正常**：能建会话、能聊、能调工具、能写文件。
2. **deepseek 在客户端里可用**，且带思考强度档位（Low/High/Max）。
3. 因此 428/503/封号**不是上游不可用**，而是我们代理侧的请求形态问题
   （已定位 `x-freebuff-instance-id` 缺失，见 `12`；503 与封号另有原因）。
4. 反向印证：**只要代理侧一发请求就封号** —— 说明差异确实在请求形态，
   而不是账号/出口/配额（客户端用同一出口、同类型账号却正常）。

## 13.6 下一步

要拿到"我们侧也能 200 + 工具调用"，唯一可靠路径是**逐字节对比**：
抓客户端发出的真实 chat 请求，与我们 dump 的请求做 diff。
（`cli-bridge` 已具备 `FREEBUFF_DUMP_DIR` 逐字节 dump 能力。）

客户端流量目前未走 mitm（bun 子进程不读 Electron 的 `--proxy-server`），
需要用 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量启动客户端才能抓到。
