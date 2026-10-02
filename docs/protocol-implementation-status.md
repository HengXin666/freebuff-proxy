# Freebuff Desktop 协议实现状态

**更新时间**: 2026-10-02  
**逆向来源**: Freebuff Desktop 0.0.156

## 实现状态总览

| 组件 | 状态 | 文件 | 说明 |
|-----|------|------|------|
| **设备签名** | ✅ 完整实现 | `src/upstream/device-signing.js` | Ed25519 签名，已验证与官方逐字节匹配 |
| **目录协议** | ✅ 完整实现 | `src/upstream/catalog-protocol.js` | 模型句柄 (fbm1.*) + fetchId |
| **客户端身份头** | ⚠️ 已创建未集成 | `src/upstream/client-headers.js` | x-freebuff-client / install-id |
| **官方指纹** | ✅ 完整实现 | `src/upstream/official-fingerprint.js` | UA、环境描述符等 |

## 已实现功能

### 1. 设备签名 (Device Signing) ✅

**实现**: `src/upstream/device-signing.js`

- ✅ Ed25519 密钥生成与持久化
- ✅ 设备密钥注册到 `/api/v1/freebuff/device-keys`
- ✅ 签名载荷计算 (6 行换行拼接)
- ✅ 请求签名头生成
  - `x-freebuff-device-key`
  - `x-freebuff-device-ts`
  - `x-freebuff-device-sig`
- ✅ 已通过真机抓包验证（签名逐字节匹配）

**集成状态**: 已集成到 `createUpstreamClient`，通过 `DeviceSigner` 类。

### 2. 目录协议 (Catalog Protocol) ✅

**实现**: `src/upstream/catalog-protocol.js`

- ✅ 目录获取 `GET /api/v1/freebuff/models`
- ✅ FetchId 缓存与刷新
- ✅ 模型句柄映射 (fbm1.* 前缀)
- ✅ Legacy 模型 ID 映射 (FNV-1a 摘要)
- ✅ 请求头生成
  - `x-freebuff-catalog-protocol: 1`
  - `x-freebuff-catalog-fetch: <fetchId>`

**集成状态**: 已集成到 `createUpstreamClient`，通过 `CatalogHolder` 类。

### 3. 官方 CLI 指纹 ✅

**实现**: `src/upstream/official-fingerprint.js`

- ✅ User-Agent 对齐（两段式）
  - `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser`
- ✅ 客户端环境描述符 (`x-freebuff-env`)
- ✅ Multi-session 协议头
  - `x-freebuff-multi-session: 1`
  - `x-freebuff-purchase-continuity: 1`
  - `x-freebuff-heartbeat: 1`
- ✅ Instance ID (CLI claim: `cli:` 前缀)

**集成状态**: 完全集成。

## 待补齐功能

### 客户端身份头 ⚠️

**文件**: `src/upstream/client-headers.js` (已创建)

**缺失集成**:
- `x-freebuff-client: desktop`
- `x-freebuff-install-id: <UUID>`

**优先级**: 中等

这两个头官方 Desktop 发送，但**不确定是否必需**。建议：
1. 先在当前实现上测试（不带这两个头）
2. 如果仍被拒，再补齐

## 验证清单

### 测试步骤

1. **基础功能**:
   ```bash
   npm test  # ✅ 已通过
   ```

2. **真实请求验证**:
   - [ ] Session 创建 (GET /api/v1/freebuff/session)
   - [ ] Session admission (POST /api/v1/freebuff/session/admission)
   - [ ] Chat completions (POST /api/v1/chat/completions)
   - [ ] 工具调用 (tools 参数)

3. **签名验证**:
   - [x] 设备密钥生成
   - [x] 密钥注册
   - [x] 签名计算正确性（已验证）
   - [ ] 上游接受签名

4. **目录验证**:
   - [ ] 目录获取成功
   - [ ] 模型句柄映射
   - [ ] Session 使用句柄

### 预期结果

**阶段 1**（当前实现）:
- 如果**通过**: 说明签名 + 目录协议足够，无需客户端身份头
- 如果**被拒**: 检查错误码
  - `device_key_unknown`: 签名注册失败，检查注册逻辑
  - `freebuff_catalog_stale`: 目录过期，刷新目录
  - `unauthorized` / `forbidden`: 可能需要客户端身份头

**阶段 2**（如需补齐）:
添加 `x-freebuff-client` 和 `x-freebuff-install-id`。

## 代码质量

- ✅ 测试通过 (`npm test`)
- ✅ 类型检查通过 (`npm run typecheck`)
- ✅ Agent Notes 覆盖所有非平凡改动
- ✅ 代码对齐官方实现（逐字节验证）

## 参考文档

- `docs/freebuff-desktop-protocol-reverse.md`: 完整逆向分析
- `.agents/notes/implemented/bug-fix/2026-10-01-device-signing.md`: 设备签名实现
- `.agents/notes/implemented/bug-fix/2026-10-01-catalog-protocol.md`: 目录协议实现
- `.agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md`: 官方指纹

## 下一步行动

1. **实际测试**: 使用真实账号测试完整链路
2. **监控日志**: 观察上游响应和错误码
3. **按需补齐**: 如果被拒，添加客户端身份头
4. **性能优化**: 目录缓存策略、签名并发性能

---

**结论**: 核心协议已完整实现（设备签名 + 目录协议），ready for 真实环境测试。
