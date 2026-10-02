# 11 — TLS 指纹实证：Node vs 官方 bun（有差异，但不是失败原因）

> 起因：第三方实现（lza6）声称 `free_mode_cli_required` 的检测在 TLS 指纹层，
> 其"破局点"是换 TLS 栈。本文用**本机实测**回答：我们与官方的 TLS 指纹差多少，
> 以及它是不是当前失败的原因。

## 11.1 实测方法

本地起 `openssl s_server`（自签证书，TLS 1.3），让两侧分别连它，
用 `tshark -i lo` 抓 Client Hello 后逐项对比。
**全程只连 127.0.0.1，不碰上游。**

```
openssl s_server -accept 14443 -cert c.pem -key k.pem
node  → fetch('https://127.0.0.1:14443/')          → /tmp/node.pcap
bun   → fetch('https://127.0.0.1:14443/')          → /tmp/bun.pcap
```
bun 用的是官方客户端自带的 `resources/bun/bun`（v1.4.2），
即 orchestrator 的实际运行时。

## 11.2 结果：指纹确实不同

| 项 | Node 26.10 / undici 8.11.2（我们） | bun 1.4.2（官方） |
|---|---|---|
| Client Hello 长度 | 1650 B | 1544 B |
| cipher suites | **52** | **17** |
| supported groups | 8（含 ffdhe2048/3072、secp521r1、x448） | 4（X25519MLKEM768, x25519, secp256r1, secp384r1） |
| signature algorithms | **26** | **9** |
| 扩展 | ALPN, ec_point_formats, **encrypt_then_mac**, extended_master_secret, key_share, psk_key_exchange_modes, renegotiation_info, session_ticket, sigalgs, supported_groups, supported_versions | 同上，但**无 encrypt_then_mac**，多 **status_request(OCSP)**、**signed_certificate_timestamp(SCT)** |

**可判别的差异点**：
- 官方有 `status_request` + `signed_certificate_timestamp` —— 真实浏览器/成熟客户端的标志性扩展。
- 我们有 `encrypt_then_mac` 而官方没有；我们 cipher 数是官方的 3 倍。

即：**JA3/JA4 层面两侧可区分，第三方"指纹是检测点"的观察在技术上成立。**

## 11.3 但它不是我们当前失败的原因（反证）

指纹有差异 ≠ 差异导致了失败。本机实测反证：

1. **Node 侧拿过 200，且设备签名生效**：
   `GET /api/v1/freebuff/models` → 200；
   带设备签名 **53 个模型** vs 不带 **13 个**。
   → 上游**接受**了 Node 的 TLS 栈，且设备签名确实改变了放行结果。
2. **Node 侧拿过完整链路的成功段**：
   `admission 200 active`（真的建成会话、返回 instanceId）、
   `agent-runs 200 runId`。
3. **真正的失败是这两个，都与 TLS 无关**：
   - `503 The model is temporarily unavailable` → 真因是
     `rateLimitsByModel` 每模型每日 6 次打满（见 `07`）。
   - `403 status: banned` / `401 Invalid API key` → 账号级封禁（见 `06` `08`）。

**判据**：如果 TLS 指纹是拒绝原因，请求会在**第一跳**就被拦，
不可能拿到 200 的 models / admission / agent-runs。
我们的失败发生在链路**末端**（chat）且伴随明确业务错误码。

## 11.4 那 lza6 的"换栈就通过了"怎么解释

最可能：**同时变量不止一个**。它从 Cloudflare Worker 迁到本地 Go 时，
一起变掉的还有出口 IP 归属、请求节奏、账号新鲜度。
它把结果归因给 TLS 指纹，但没做单变量对照。

我们这里有对照：同一台机器、同一出口 IP、同一账号，
Node 的 TLS 栈照样拿到 admission 200 —— **指纹不是闸门**。

## 11.5 结论与处置

- **不引入 uTLS / JA3 伪装。** 理由：(1) 与 AGENTS.md 定位红线冲突
  （只做免费链路，不搞绕过检测的伪装）；(2) 本仓库是 Node，
  要伪装需引入原生依赖，与"仅 2 个运行时依赖"的轻量铁律冲突；
  (3) 实测证明它不是当前失败原因，做了也不解决问题。
- **指纹差异作为已知事实记录在案**，若将来出现"第一跳就被拦"
  且业务码缺失的情况，再回来考虑。
- 值得记的一个信号：官方有 `status_request` / `SCT`、无 `encrypt_then_mac`。
  若将来确需对齐，这是要动的两个点。

## 11.6 复现命令

```bash
openssl req -x509 -newkey rsa:2048 -keyout /tmp/k.pem -out /tmp/c.pem -days 2 -nodes -subj "/CN=localhost"
openssl s_server -accept 14443 -cert /tmp/c.pem -key /tmp/k.pem -quiet &
tshark -i lo -f "tcp port 14443" -w /tmp/node.pcap -q &
NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "fetch('https://127.0.0.1:14443/').catch(()=>{})"
tshark -r /tmp/node.pcap -Y "tls.handshake.type==1" -V
```
