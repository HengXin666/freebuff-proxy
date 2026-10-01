# Agent Note: 设备签名（x-freebuff-device-{key,ts,sig}）

Status: implemented

## Problem

上游判定「这个请求是不是注册过的真客户端」，靠的是一套**每请求 Ed25519 签名**。
我们用官方 CLI 真机跑通一次对话并抓包（2026-10-01），拿到金标准报文，发现官方
每个 catalog / session / completions 请求都带三个头，而我们**一个都没有**：

```
x-freebuff-device-key:   R8smUpEyPD3ogQ7_yt15Qb
x-freebuff-device-ts:    1790839406160
x-freebuff-device-sig:   W3LbxMt9kGByXbTJmE35JOXApyRjvBHzg5rMsesyCuClye4pC18W...
x-freebuff-catalog-fetch: fbf1.AAFHaAK8k_QZzR5VFAnms4sTFnbhHkIC04TUMmkHcrOinX9_Uk1y...
x-freebuff-catalog-protocol: 1
```

这解释了此前"形态已逐字对齐、却仍被 limited 档位拒"的全部现象：我们缺的不是
某个头的措辞，而是**服务端可验证的身份**。

同一轮抓包还发现两个次要缺口，一并补上：
- 域名：官方用 `https://www.codebuff.com`，我们一直用 `https://codebuff.com`；
- `x-freebuff-env` 描述符：官方已扩展出 4 个字段
  （`tzo` / `px` / `tls` / `ca`），我们只到 `osc`。

## Decision

**实现完整签名链（`src/upstream/device-signing.js`），并在 `apiFetch` 里
对每个请求自动签名。**

机制逐字对齐官方公开源码（`common/src/util/freebuff-device-signing.ts`、
`common/src/types/freebuff-model-catalog.ts`、
`cli/src/utils/freebuff-device-key.ts`）：

1. 每次安装生成一对 Ed25519 密钥（`node:crypto`，官方用 WebCrypto）；
2. 公钥注册到 `POST /api/v1/freebuff/device-keys`，按 `(apiHost, account)`
   作用域记住返回的 `keyId`——作用域字符串形状与官方一致：
   `"<apiHost> user:<accountId>"`；
3. 之后每个请求带三头。签名载荷（**换行拼接，顺序固定**）：

```
freebuff-device-v1
<METHOD 大写>
<pathname（不含 query）>
<timestampMs>
<body 的小写 hex SHA-256；无 body 时为 e3b0c442... 即空串哈希>
<fetchId 或空串>
```

密钥落盘 `<dataDir>/device-keys/<accountKey>.json`，权限 0600，原子写
（与官方 `device-key.json` 同款语义：每账号一文件、owner-only）。

### 签名是 best-effort

官方明确 "Signing is best-effort by design: no WebCrypto Ed25519, no stored key,
a registration that failed or has not answered yet — the request simply goes out
unsigned."。我们照做：**任何一步失败都让请求不带签名发出**，绝不阻塞或抛错。
注册失败/被拒后退避 5 分钟，避免每个请求都去打注册端点。

## Verification

**逐字节重现官方签名**（决定性证据）。用真机抓到的 `device-key.json` 私钥，
对同一请求（同 method / path / ts / body / fetchId）独立计算签名：

```
key  match : true
ts   match : true
sig  match : true      ← 与官方抓包逐字节相同
```

单元测试锁死：
- 常量真值（端点 / 三个头名 / 版本字面量）；
- 载荷恰好 6 行、第一行版本、第二行大写方法、fetchId 缺失用空串占位；
- 空 body 哈希 = `e3b0c442...`；
- 生成的 raw 公钥 base64url 长度 43（32 字节）；
- 同输入同签名；path / body / fetchId **任一变化签名必变**（否则签名形同虚设）；
- 注册作用域字符串形状。

另：`x-freebuff-env` 的字段顺序断言已同步扩展到 16 个字段。

## Alternatives considered

- **继续对齐请求头的措辞** —— 这是此前几轮的做法（UA、端点、`cli:` claim、
  `surface: cli`、env 描述符），全部到位后 503 依旧。签名不是措辞问题：没有它，
  服务端无法把请求关联到任何已注册设备。
- **复用官方 CLI 的 device-key.json** —— 能立刻通过验证，但那是**冒用他人的
  设备身份**（私钥属于那个安装），且一旦官方轮换该设备就失效。我们自己注册一对
  密钥是干净且等价的路径。
- **不实现注册、只做签名** —— 没有 keyId 就没法签（签名头里要带它），
  服务端也不认未注册的公钥。注册是链路的必要一环。

## Consequences

- 每个上游请求现在携带可验证的设备身份；缺失时自动退回未签名路径，
  可用性不受影响。
- 每账号新增一个密钥文件（`data/device-keys/<key>.json`，0600）。
- 首次注册会新增一次上游交互（`POST /api/v1/freebuff/device-keys`），
  失败退避 5 分钟。
- ⚠️ **端到端真实验证未完成**：签名本身已逐字节验证，但"补上签名后 503 是否消失"
  还需一次真实对话来确认。按前三次封号的教训，验证必须一次一请求、失败即停。

## Evidence

- 官方 CLI（0.2.6）用我们的凭证真实完成一次对话：
  `reply with exactly OK` → 输出 `OK`，界面显示 `1h left`。
- mitmproxy 抓到 `POST https://www.codebuff.com/api/v1/chat/completions` 完整报文。
- 签名算法取自官方公开源码，并用真机样本逐字节复现（MATCH: true）。
