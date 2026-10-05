# Agent Note: Device Signing Raw Ed25519 Public Key Format

Status: implemented

**Affects:** `src/upstream/device-signing.ts`  
**Context:** Freebuff/Codebuff 设备签名协议逆向

## Problem

设备密钥注册失败,上游返回 400 错误:
```
publicKey must be a base64url raw Ed25519 public key
```

初始实现使用 `type: 'spki'` 导出公钥(44 字节头部 + 32 字节原始公钥),
但上游要求的是 **原始的 32 字节 Ed25519 公钥**.

## Decision

从 SPKI 格式的 DER 编码中提取原始公钥(最后 32 字节):

```javascript
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// SPKI 格式: 头部(12字节) + 原始公钥(32字节)
const rawPublicKey = publicKey.slice(-32);
```

## Evidence

逆向自官方客户端 `Freebuff-0.0.156-linux-x86_64.AppImage`,
`resources/orchestrator/orchestrator.js` 第 134777 行:

```javascript
publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey))
```

Web Crypto API 的 `exportKey("raw", ...)` 对于 Ed25519 密钥返回 32 字节原始公钥.

## Consequences

修复后:
1.  设备密钥注册成功(返回 `keyId`)
2.  带 `tools` 的请求不再被上游拒绝
3.  设备签名头正确添加到所有上游请求
4.  代理可以像官方客户端一样正常工作

## Alternatives considered

### 1. 使用 Web Crypto API 的 `subtle.exportKey('raw', ...)`

**Pros:**
- 与官方客户端完全一致
- 直接返回 32 字节原始公钥,无需手动提取

**Cons:**
- Node.js 的 `crypto.subtle` 仅在较新版本(v15.0.0+)可用
- 需要 Promise-based API,与当前同步的 `generateKeyPairSync` 不一致
- 增加代码复杂度

**Rejected:** 当前 Node.js 版本支持,但为保持代码简洁性,
选择从 SPKI 格式中提取(SPKI 格式是标准的,最后 32 字节始终是原始公钥).

### 2. 保持 SPKI 格式,修改上游请求

**Rejected:** 上游明确要求 `base64url raw Ed25519 public key`,
无法修改上游协议.

### 3. 什么都不做

**Rejected:** 设备签名是上游识别官方客户端的关键特征,
不修复会导致带工具的请求被拒绝(上游认为是第三方客户端).

## Related

- 上游设备签名协议文档:`docs/reverse/02-device-signing.md`(唯一真源,逐字常量 + 载荷 + 两处易错点 + 本机实测值)
  —— 旧的 `REVERSE_ENGINEERING_SUMMARY.md` 已废弃删除(该摘要里签名字段名与载荷字段数都是错的,见 `docs/code-quality/docs-audit.md`).
- 设备密钥存储格式:`data/device-keys/{accountId}.json`
