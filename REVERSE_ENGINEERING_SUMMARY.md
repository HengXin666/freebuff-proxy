# Freebuff/Codebuff 协议逆向工程总结

**逆向目标**: Freebuff-0.0.156-linux-x86_64.AppImage  
**完成时间**: 2026-10-02  
**状态**: ✅ 成功 - 协议化请求已通过上游验证

## 核心发现

### 1. 设备签名 (Device Signing)

**问题**: 带 `tools` 的请求被上游拒绝，上游识别为"第三方客户端"。

**根因**: 上游通过 **设备签名** 验证官方客户端身份。

#### 协议细节

逆向自 `resources/orchestrator/orchestrator.js` (第 134777-134899 行)：

```javascript
// 密钥生成 (Ed25519)
const pair = await subtle.generateKey(
  { name: "Ed25519" },
  false,
  ["sign", "verify"]
);

// 公钥导出 (raw format, 32 bytes)
const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));

// 注册设备密钥
POST https://www.codebuff.com/api/v1/freebuff/device-keys
Content-Type: application/json
Authorization: Bearer <access_token>

{
  "publicKey": "<base64url(publicKey)>",
  "scope": "https://www.codebuff.com user:<userId>"
}

// 响应
{
  "id": "shrRnl-xZ9E7R0zGNFITXc",  // keyId
  ...
}
```

#### 签名生成

每个上游请求都需要携带设备签名：

```javascript
// 签名载荷 (换行分隔的 5 个字段)
const payload = [
  "freebuff-device-v1",           // 版本标识
  method,                          // HTTP 方法 (GET/POST)
  path,                            // 请求路径 (/api/chat/stream)
  timestampMs,                     // 当前时间戳 (毫秒)
  sha256(requestBody).hex().slice(0, 43)  // 请求体 SHA-256 前 43 字符
].join("\n");

// 使用私钥签名
const signature = await subtle.sign("Ed25519", privateKey, payload);

// 请求头
X-Freebuff-Device-Signature: <base64url(signature)>
X-Freebuff-Device-Key-Id: <keyId>
X-Freebuff-Device-Timestamp: <timestampMs>
```

#### 关键陷阱

**公钥格式必须是 raw Ed25519 (32 字节)**，而不是 SPKI 格式 (44 字节头部 + 32 字节公钥)。

初始实现错误：
```javascript
const { publicKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'der' }  // ❌ 错误
});
```

正确实现：
```javascript
const { publicKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'der' }
});
const rawPublicKey = publicKey.slice(-32);  // ✅ 提取最后 32 字节
```

### 2. CLI 指纹 (CLI Fingerprint)

逆向自 `orchestrator.js` (第 134662 行)：

```javascript
const CLI_FINGERPRINT_VERSION = "0.2.12";

// 请求头
X-Freebuff-Cli-Fingerprint: 0.2.12
```

**作用**: 标识客户端版本，上游可能用于兼容性检查或功能开关。

### 3. 模型目录 (Model Catalog)

官方客户端从上游动态获取模型列表，而不是硬编码：

```javascript
GET https://www.codebuff.com/api/v1/freebuff/models
Authorization: Bearer <access_token>
X-Freebuff-Device-Signature: ...
X-Freebuff-Device-Key-Id: ...
X-Freebuff-Device-Timestamp: ...
X-Freebuff-Cli-Fingerprint: 0.2.12
```

响应包含：
- 模型 ID (`anthropic/claude-3.5-sonnet`)
- 显示名称 (`Claude 3.5 Sonnet`)
- 计费信息 (`pricing.input`, `pricing.output`)
- 访问层级 (`access_tiers`, `current_access_tier`)
- 可用性 (`available`)

### 4. 访问层级 (Access Tiers)

上游根据出口 IP 信誉分配访问层级：

- **`full`**: 正常住宅 IP，无限制
- **`limited`**: VPN/代理/匿名网络，功能受限但不拒绝

检测信号：
```json
{
  "countryCode": "JP",
  "reason": "anonymous_network",
  "ipPrivacySignals": ["vpn", "hosting", "anonymous"],
  "accessTier": "limited"
}
```

**重要**: 即使在 `limited` 层级，带工具的请求也能正常工作（只要有设备签名）。

## 实现成果

### ✅ 已完成

1. **设备签名完整实现**
   - Ed25519 密钥对生成 (Node.js `crypto.generateKeyPairSync`)
   - 设备密钥注册到上游
   - 每个请求自动添加签名头
   - 密钥持久化到 `data/device-keys/{accountId}.json`

2. **动态模型目录**
   - 从上游实时获取模型列表
   - 缓存到 `data/catalog-cache.json`
   - `/v1/models` API 返回实时计费和可用性

3. **CLI 指纹对齐**
   - 请求头与官方客户端完全一致

4. **协议化请求验证**
   - ✅ 带 `tools` 的请求成功通过上游
   - ✅ 无 "foreign client" 错误
   - ✅ 请求被接受（即使在 `limited` 访问层级）

### 验证测试

```bash
# 1. 设备密钥注册
curl http://127.0.0.1:28287/v1/models \
  -H "Authorization: Bearer sk-fb-xxx"

# 日志输出:
# {"level":"info","msg":"device key registered successfully","keyId":"shrRnl-xZ9E7R0zGNFITXc"}
# {"level":"info","msg":"device signature generated","method":"GET","path":"/api/v1/freebuff/models"}

# 2. 带工具的请求
curl http://127.0.0.1:28287/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-fb-xxx" \
  -d '{
    "model": "anthropic/claude-3.5-sonnet",
    "messages": [{"role": "user", "content": "What is the weather?"}],
    "tools": [{"type": "function", "function": {"name": "get_weather", ...}}],
    "max_tokens": 100
  }'

# 响应: HTTP 200 (成功)
# 日志: "session admitted on limited tier (not blocked)"
```

## 技术栈对比

| 组件 | 官方客户端 | 本代理实现 |
|------|-----------|----------|
| 密钥生成 | Web Crypto API (`subtle.generateKey`) | Node.js `crypto.generateKeyPairSync` |
| 公钥导出 | `subtle.exportKey("raw", ...)` | SPKI DER → 提取最后 32 字节 |
| 签名算法 | `subtle.sign("Ed25519", ...)` | `crypto.sign(null, ..., privateKey)` |
| 载荷哈希 | Web Crypto `subtle.digest("SHA-256", ...)` | Node.js `crypto.createHash("sha256")` |
| Base64URL | `btoa` + 手动替换 | `Buffer.toString("base64url")` |

## 安全注意事项

1. **设备密钥是账号级凭据**
   - 每个账号一个独立的密钥对
   - 私钥存储在 `data/device-keys/{accountId}.json` (600 权限)
   - 密钥泄露可能导致账号被上游识别为"多设备登录"

2. **时间戳同步**
   - 签名包含毫秒级时间戳
   - 服务器时间偏差过大可能导致签名验证失败

3. **访问层级降级**
   - 使用代理出口会被降级到 `limited` 层级
   - 功能可能受限（具体限制未知）
   - 建议使用住宅 IP 以获得 `full` 访问

## 未来改进

- [ ] 监控 CLI 指纹版本更新 (当前 0.2.12)
- [ ] 自动处理设备密钥过期/轮换
- [ ] 研究 `limited` vs `full` 访问层级的具体差异
- [ ] 探索多设备密钥管理策略

## 参考资源

- 官方客户端: `Freebuff-0.0.156-linux-x86_64.AppImage`
- 关键源码: `resources/orchestrator/orchestrator.js`
- 上游 API: `https://www.codebuff.com/api/v1/*`
- Ed25519 规范: [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)

---

**免责声明**: 本文档仅用于技术学习和研究目的。逆向工程应遵守相关法律法规和服务条款。
