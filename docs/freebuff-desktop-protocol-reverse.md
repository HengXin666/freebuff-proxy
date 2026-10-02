# Freebuff Desktop 协议逆向分析

## 概述

对官方 Freebuff Desktop 0.0.156 的协议进行逆向，发现其使用了**设备签名机制**来防止第三方客户端。

## 架构

Freebuff Desktop 采用 Electron + Bun 双进程架构：

- **Electron main process (Node.js)**: Shell 进程，生成 launch token
- **Bun orchestrator**: 后端服务，监听 127.0.0.1:43439（动态端口）

## 关键发现

### 1. Launch Token 机制

所有 `/api/` 请求必须带 `x-freebuff-launch-id` header：

- Launch token 由 Electron 主进程生成
- 通过 IPC 传递给渲染器
- 同时设置为 HttpOnly cookie: `freebuff_launch_{port}`
- 缺失则返回 `{"error":"unauthorized"}` (401)

**这是本地进程隔离机制，不是上游 Freebuff 服务的验证点。**

### 2. 设备签名协议 (关键反第三方客户端机制)

从 `orchestrator.js` 提取的关键常量：

```javascript
// 设备密钥相关头
FREEBUFF_DEVICE_KEY_HEADER = "x-freebuff-device-key"
FREEBUFF_DEVICE_TIMESTAMP_HEADER = "x-freebuff-device-ts"
FREEBUFF_DEVICE_SIGNATURE_HEADER = "x-freebuff-device-sig"

// 设备密钥端点
FREEBUFF_DEVICE_KEYS_PATH = "/api/v1/freebuff/device-keys"

// 签名载荷格式
function freebuffDeviceSignaturePayload(params) {
  return [
    "freebuff-device-v1",
    // ... (payload 详情需进一步提取)
  ]
}
```

**签名算法**: Ed25519 (WebCrypto API)

```javascript
ED25519 = { name: "Ed25519" }
```

### 3. 目录协议 (Catalog Protocol)

官方客户端使用**模型句柄**而非明文 model id：

```javascript
FREEBUFF_CATALOG_PROTOCOL_HEADER = "x-freebuff-catalog-protocol"
FREEBUFF_CATALOG_PROTOCOL_VERSION = "1"
FREEBUFF_MODEL_CATALOG_PATH = "/api/v1/freebuff/models"
FREEBUFF_CATALOG_FETCH_HEADER = "x-freebuff-catalog-fetch"
```

流程：
1. `GET /api/v1/freebuff/models` 带 `x-freebuff-catalog-protocol: 1`
2. 响应返回 `fetchId` 和**模型句柄**（`fbm1.` 前缀，服务端签名）
3. 后续请求带：
   - `x-freebuff-catalog-protocol: 1`
   - `x-freebuff-catalog-fetch: <fetchId>`
   - `model` 字段使用**句柄**而非 `deepseek/deepseek-v4-flash`

### 4. 其他关键头

```javascript
FREEBUFF_INSTANCE_HEADER = "x-freebuff-instance-id"
FREEBUFF_MODEL_HEADER = "x-freebuff-model"
FREEBUFF_ACTING_USER_HEADER = "x-freebuff-acting-user-id"
FREEBUFF_MULTI_SESSION_HEADER = "x-freebuff-multi-session"
FREEBUFF_HEARTBEAT_HEADER = "x-freebuff-heartbeat"
FREEBUFF_CLIENT_HEADER = "x-freebuff-client"
FREEBUFF_CLIENT_DESKTOP = "desktop"
FREEBUFF_INSTALL_ID_HEADER = "x-freebuff-install-id"
```

## 当前仓库状态

### 已实现（部分对齐官方）

- ✅ Session 管理用 `GET /session` + claim headers
- ✅ `x-freebuff-instance-id` 贯穿 GET/DELETE
- ✅ `x-freebuff-multi-session: 1`
- ✅ `x-freebuff-acting-user-id` 用 user.id

### 缺失（导致被识别为第三方客户端）

- ❌ **设备签名三件套**: `x-freebuff-device-key` / `-device-ts` / `-device-sig`
- ❌ 目录协议：未用 `fbm1.` 句柄，仍传明文 model id
- ❌ `x-freebuff-catalog-fetch: <fetchId>`
- ❌ `x-freebuff-client: desktop` / `-install-id`

## 下一步

### 方案 A：完整实现设备签名（高难度）

需要：
1. 提取 `freebuffDeviceSignaturePayload` 完整逻辑
2. 实现 Ed25519 密钥生成与签名
3. 注册设备密钥到 `/api/v1/freebuff/device-keys`
4. 每次请求计算签名

**风险**: 签名载荷可能包含客户端指纹、时间戳、请求体哈希等，需完整逆向。

### 方案 B：规避检测（推荐，先尝试）

官方可能通过**缺少设备签名头**来标记第三方客户端。尝试：

1. ✅ 补齐基础头：
   - `x-freebuff-client: desktop`
   - `x-freebuff-install-id: <随机UUID>`
   - `x-freebuff-catalog-protocol: 1`

2. ✅ 实现目录协议：
   - 先 GET `/api/v1/freebuff/models` 抓 fetchId 和句柄
   - 缓存 fetchId，后续请求带 `x-freebuff-catalog-fetch`
   - Session 请求的 `model` 用句柄而非明文

3. ⚠️ 观察：补齐后是否仍被拒（若仍拒绝，说明**必须**有有效设备签名）

### 方案 C：放弃协议化，改用浏览器自动化

如果设备签名是强制性的且无法绕过，考虑：
- Puppeteer/Playwright 驱动官方 Web 版
- 拦截网络请求提取 token

## 附：SDK 代码定位

官方 SDK 位于 `@codebuff/sdk`:
- **模型提供者**: `src/impl/model-provider.ts`
- **BYOK 请求转换**: `src/impl/byok-request.ts`
- **运行时入口**: `src/run.ts`
- **客户端**: `src/client.ts`

User-Agent: `ai-sdk/openai-compatible/${VERSION}/codebuff`

## 参考文件

- `electron/orchestrator-request.cjs`: Launch token IPC
- `orchestrator/orchestrator.js`: 完整后端逻辑（已混淆）
- `@codebuff/sdk/src/`: TypeScript 源码（未混淆）

---

**结论**: 官方通过**设备签名 + 目录协议**双重验证客户端身份。当前仓库缺失这两项，被上游判定为第三方客户端而拒绝 tools 调用。

---

## 设备签名完整实现细节

### 签名载荷构造

```javascript
function freebuffDeviceSignaturePayload(params) {
  return [
    "freebuff-device-v1",           // 协议版本
    params.method.toUpperCase(),    // HTTP 方法 (GET/POST/DELETE)
    params.path,                     // URL 路径 (如 /api/v1/freebuff/session)
    String(params.timestampMs),     // 时间戳 (毫秒)
    params.bodySha256,              // 请求体 SHA256 (hex)
    params.fetchId ?? ""            // 目录 fetchId (可选)
  ].join('\n')  // 用换行符连接
}
```

### 签名算法

1. **密钥生成** (Ed25519):
```javascript
const pair = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,  // extractable
  ["sign", "verify"]
)

const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey)
const privateKey = await crypto.subtle.exportKey("pkcs8", pair.privateKey)

// 存储为 base64url
const record = {
  version: 1,
  publicKey: base64UrlEncode(new Uint8Array(publicKey)),
  privateKey: base64UrlEncode(new Uint8Array(privateKey)),
  registrations: {}
}
```

2. **Body SHA256**:
```javascript
async function freebuffBodySha256(body, subtle) {
  const bytes = typeof body === 'string' 
    ? new TextEncoder().encode(body)
    : (body instanceof Uint8Array ? body : new Uint8Array(0))
  
  const hash = await subtle.digest('SHA-256', bytes)
  return hex(new Uint8Array(hash))  // 转为小写 hex 字符串
}

function hex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
```

3. **签名生成**:
```javascript
async function signFreebuffDeviceRequest(params) {
  const payload = freebuffDeviceSignaturePayload({
    method: params.request.method,
    path: new URL(params.request.url).pathname,
    timestampMs: params.timestampMs,
    bodySha256: await freebuffBodySha256(params.request.body),
    fetchId: params.request.fetchId  // 从目录响应获取
  })
  
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    params.privateKey,
    new TextEncoder().encode(payload)
  )
  
  return {
    'x-freebuff-device-key': params.keyId,
    'x-freebuff-device-ts': String(params.timestampMs),
    'x-freebuff-device-sig': base64UrlEncode(new Uint8Array(signature))
  }
}
```

4. **Base64 URL 编码**:
```javascript
function base64UrlEncode(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
```

### 密钥注册流程

1. **注册端点**: `POST /api/v1/freebuff/device-keys`

2. **注册请求体**:
```json
{
  "publicKey": "<base64url_public_key>",
  "scope": "<host> user:<user_id>"
}
```

3. **Scope 计算**:
```javascript
// 如果有 accountId
scope = `${apiHost} user:${accountId}`

// 否则用 token 哈希前 32 字符
const digest = await freebuffBodySha256(token)
scope = `${apiHost} token:${digest.slice(0, 32)}`
```

4. **响应**:
```json
{
  "keyId": "<uuid>",
  "expiresAt": "<ISO8601>"
}
```

### 使用场景

**所有上游 Freebuff API 请求都需要设备签名头**：
- `GET /api/v1/freebuff/session`
- `POST /api/v1/freebuff/session/admission`
- `DELETE /api/v1/freebuff/session`
- `POST /api/v1/chat/completions`
- `GET /api/v1/freebuff/models` (目录请求)

### 关键常量

```javascript
FREEBUFF_DEVICE_KEYS_PATH = "/api/v1/freebuff/device-keys"
FREEBUFF_DEVICE_KEY_HEADER = "x-freebuff-device-key"
FREEBUFF_DEVICE_TIMESTAMP_HEADER = "x-freebuff-device-ts"
FREEBUFF_DEVICE_SIGNATURE_HEADER = "x-freebuff-device-sig"

// 重试时间
REGISTER_TIMEOUT_MS = 10000         // 注册超时
DEFAULT_WAIT_MS = 3000              // 默认等待
REGISTER_RETRY_MS = 300000          // 5 分钟重试
REGISTER_UNSUPPORTED_RETRY_MS = 3600000  // 1 小时重试
```

### 错误处理

```javascript
function isFreebuffDeviceKeyUnknownError(code) {
  return /device[_-]?key/i.test(code) && 
         /unknown|not[_-]?found|invalid|unregistered/i.test(code)
}
```

当收到 `device_key_unknown` 错误时，需要重新注册设备密钥。

---

## 实现优先级

### 阶段 1: 补齐基础头（快速验证）

**目标**: 验证是否仅缺失签名头就被拒绝，还是签名必须有效。

实现：
1. ✅ 添加 `x-freebuff-client: desktop`
2. ✅ 添加 `x-freebuff-install-id: <UUID>`
3. ✅ 实现目录协议 (catalog protocol)
4. ⚠️ **不实现签名**，观察上游响应

**验证点**:
- 如果仍返回 401/403 但错误码变化 → 签名是软性检查
- 如果明确返回 `device_key_required` → 必须实现签名
- 如果通过 → 签名是可选的

**耗时**: 2-3 小时

### 阶段 2: 实现设备签名（如果阶段 1 失败）

**目标**: 完整实现 Ed25519 设备签名。

实现：
1. ✅ 密钥生成与持久化 (`data/device-key.json`)
2. ✅ 密钥注册到 `/api/v1/freebuff/device-keys`
3. ✅ 每次请求计算签名头
4. ✅ 签名失败自动重新注册

**耗时**: 8-12 小时

### 阶段 3: 目录协议优化

**目标**: 使用模型句柄而非明文 ID。

实现：
1. ✅ 启动时 `GET /api/v1/freebuff/models` 获取目录
2. ✅ 缓存 `fetchId` 和模型句柄映射
3. ✅ Session/chat 请求使用句柄
4. ✅ 定期刷新目录 (10 分钟)

**耗时**: 4-6 小时

---

## 技术难点

1. **Node.js 18+ 才支持 WebCrypto Ed25519**
   - 当前 Node.js 版本需 >= 18.0.0
   - 或使用 `@noble/ed25519` 库

2. **密钥持久化安全性**
   - 私钥明文存储风险
   - 考虑用系统 keyring (可选)

3. **时间戳同步**
   - 客户端时钟偏移可能导致签名被拒
   - 需支持服务端时间同步

4. **并发请求的签名**
   - 每个请求独立签名
   - 时间戳必须单调递增（毫秒精度）

---

## 推荐实施路径

```
┌─────────────────────────────────────┐
│  阶段 1: 补齐基础头 (2-3h)          │
│  ✓ catalog protocol                 │
│  ✓ client/install-id headers       │
│  ✗ 设备签名 (留空)                  │
└──────────────┬──────────────────────┘
               │
               ▼
       ┌───────────────┐
       │ 测试上游响应   │
       └───┬───────┬───┘
           │       │
    通过 ✓ │       │ ✗ 被拒
           │       │
           ▼       ▼
      ┌─────┐  ┌──────────────────────┐
      │完成 │  │ 阶段 2: 实现签名(8-12h)│
      └─────┘  │ ✓ Ed25519 密钥生成    │
               │ ✓ 注册 device key     │
               │ ✓ 请求签名            │
               └──────────────────────┘
```

**建议**: 先走阶段 1，用最小成本验证假设。如果通过则无需签名；如果被拒再投入阶段 2。
