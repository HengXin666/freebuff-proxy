# Agent Note: 模型映射用 legacyDigests（FNV-1a），不是 recommendedKey

Status: implemented

## Problem

chat 层 503 的**根因**是模型映射错：我们把 `deepseek/deepseek-v4-flash` 映射成了
`m-00032eaeec`（**MiMo 2.6 Flash**），于是会话绑 MiMo、agent 却是 deepseek，
chat 必然被拒。

映射用错了机制。官方目录**不直接列模型 id**，而是给每行一个 `legacyDigests`
数组（旧 id 的摘要）—— 官方注释说明了原因：

> Opaque digests of the legacy model ids this row replaces, so a client can move
> a pick saved before the catalog existed onto its row **without the catalog
> naming the id**: `freebuffLegacyModelDigest(savedId)`.

算法在 `common/src/types/freebuff-model-catalog.ts`：**双 FNV-1a**，命名空间
`freebuff-legacy-model:`，32 位无符号，输出 16 位小写 hex。

```ts
export function freebuffLegacyModelDigest(modelId: string): string {
  const input = `freebuff-legacy-model:${modelId}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
}
```

⚠️ **这不是 sha256**（我此前猜错过一次，算出 6d0dcdfbe2d7fa18 对不上）。

## Decision

**实现 `freebuffLegacyModelDigest()`，用摘要建 legacy 索引，删掉 recommendedKey 兜底。**

- `catalog-protocol.js`：新增摘要函数；抓目录时按每行 `legacyDigests` 建
  `legacyIndex`（摘要 → 句柄）；`handleFor()` 依次尝试
  句柄原样 → 目录 key → **legacy 摘要**。
- `client.js`：**删除** `recommendedKey` 兜底（已证伪）；请求的模型不在本次目录时
  如实保持原值并记 warn，而不是替上游猜一个。

## Alternatives considered

- **recommendedKey 兜底**（上一轮的做法）—— 已证伪：它把 deepseek 静默映射到
  MiMo，制造了"会话绑 MiMo + agent 用 deepseek"的矛盾，是 chat 503 的直接原因。
- **按 displayName 模糊匹配** —— 名字会变（"DeepSeek V4.1 Flash" vs 内置目录里的
  "DeepSeek V4 Flash 07/31"），且目录动态，规则注定脆。
- **sha256 摘要** —— 猜错过；官方用的是 FNV-1a。

## Consequences

- 客户端请求的模型 id 现在能**精确**映射到服务端行（句柄）。
- 四个模型实测全部命中：deepseek → m-096e75164d、mimo → m-00032eaeec、
  glm → m-7e20df6765、solar-mini4 → m-69307952f8。
- chat 的 model 与会话绑定、agent 三者一致（日志 `chat forward model resolved`
  可证：requested / sessionModel / assigned / outgoing 四字段）。

## Evidence

摘要复现（与服务端返回逐字一致）：

```
mimo/mimo-v2.5             → 5acfab992d88345c  （行 m-00032eaeec）
deepseek/deepseek-v4-flash → 1e303ac563a6f9cc  （行 m-096e75164d）
```

映射实测（12 行目录，10 条 legacy 摘要）：

```
deepseek/deepseek-v4-flash -> fbm1.AAEAAUPeT0-wSlmXb...
mimo/mimo-v2.5             -> fbm1.AAEAAUPe2UsIwjIE...
z-ai/glm-5.3-flash         -> fbm1.AAEAAUPePto5EFM2...
upstage/solar-mini4        -> fbm1.AAEAAUPeuCPqbSPq...
```

端到端现状：**会话建立 ×3、agent run ×3 全部成功**，chat 仍 503，
响应体是通用文案 `"The model is temporarily unavailable. Please try again later."`。
已排除时间窗（当前 09:05 UTC 在 deepseek off-peak 00:00-10:00 内）与访问级别
（该行 `access=open`）。账号 `banned: false`、额度 15/25。
