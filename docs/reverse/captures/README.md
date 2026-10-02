# 抓包归档目录（持续复盘用）

> 本目录保存**官方客户端的真实流量**，是协议逆向的一手证据。
> 数据只增不改：每次新抓包以日期命名新文件，旧样本保留用于纵向对比。

## 文件清单

| 文件 | 内容 |
|---|---|
| `2026-10-03-official-client.jsonl` | 原始抓包（88 条，788K）。每行一个请求/响应记录 |
| `CAPTURE-SUMMARY.md` | 自动生成的摘要（`summarize.py` 产出，勿手改） |
| `official-tools.json` | **官方 37 个工具的完整定义**（名字 + 参数 schema） |
| `official-system-prompts.json` | **两层 system prompt 全文**：manager(13443 字符) / worker(7918 字符) |
| `summarize.py` | 摘要生成脚本 |
| `dump1..dump4/` | 我们自己请求的逐字节 dump（`FREEBUFF_DUMP_DIR` 产出，用于 diff） |

## 抓包方法（可复现）

```bash
# 1) mitm 必须用 request 钩子（流式响应不缓存，response 钩子拿不到请求体）
mitmdump -s tools/mitm-capture.py -p 8899 \
  --set confdir=~/.mitmfreebuff --set body_size_limit=1m

# 2) 客户端必须用**环境变量**代理：
#    --proxy-server 只对渲染进程有效，bun 子进程（所有 API 请求）不认它
env HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899 \
    ./Freebuff-*.AppImage --remote-debugging-port=9333 --ignore-certificate-errors

# 3) 用 CDP 操作 UI 触发请求（不发任何协议请求）
node tools/cdp-ui.mjs send '.composer-input' '你的消息'
```

重新生成摘要：

```bash
python3 docs/reverse/captures/summarize.py
```

## 本次抓到的关键事实

一次用户消息会触发**两类** chat 请求：

1. **manager 层**（`tools: [decide]`）——
   tab 的"下一步决策"，system 是
   `You are Buffy, the auto-run agent behind Freebuff Desktop...`（13443 字符）。
2. **worker 层**（37 个工具，含 `write_file`）——
   真正执行用户任务，system 是
   `You are Buffy, the coding agent behind Codebuff. You help users with
   software engineering tasks...`（7918 字符）。

两者 `provider` 不同：manager = `{"allow_fallbacks":true}`、
worker = `{"data_collection":"deny"}`。

详见 `../14-captured-diff.md`。
