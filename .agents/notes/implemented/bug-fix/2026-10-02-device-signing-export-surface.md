# Agent Note: Device Signing Export Surface Restored

Status: implemented

**Affects:** `src/upstream/device-signing.ts`

## Problem

重写 `device-signing.js` 修 raw 公钥格式时,只保留了 `DeviceSigner` 类和内部辅助函数,
**删掉了原有的导出常量与纯函数**:`FREEBUFF_DEVICE_KEYS_PATH`,`HEADER_DEVICE_*`,
`DEVICE_SIGNATURE_VERSION`,`deviceSignaturePayload`,`bodySha256`,`generateDeviceKey`,
`parseDeviceKeyRecord`,`importDevicePrivateKey`,`signDeviceRequest`,`registrationScope`.

后果:`npm test` 在设备签名契约用例上失败(`FREEBUFF_DEVICE_KEYS_PATH` 为 `undefined`),
而 `npm test` 是项目铁律里"提交前必须全过"的一环 —— 等于把发布闸门卡死了.

## Decision

保留 raw 公钥的新实现行为,**补回被删的导出面**,并让新实现复用这些纯函数
(`DeviceSigner` 内部不再另写一份签名逻辑,改为调用 `deviceSignaturePayload` 等),
避免"两处各写一份,日后漂移".

补齐的语义细节(逐字对齐官方):
- `bodySha256(null)` = 空串的 SHA-256(`e3b0c442...`)
- `deviceSignaturePayload` 恰好 6 行,`fetchId` 缺失用**空串占位**而非省略该行
- `generateDeviceKey()` 的 `publicKey` 是 raw 32 字节的 base64url(43 字符)
- `registrationScope(apiHost, accountId)` = `"<apiHost> user:<accountId>"`
- 三个头部名逐字:`x-freebuff-device-key` / `-ts` / `-sig`

## Consequences

- `npm test` / `npm run typecheck` / verify-notes 全绿,发布闸门恢复.
- 设备签名的契约有了单一真源,测试直接断言真源,不再与实现脱钩.
- `importDevicePrivateKey` 同时兼容 PEM(当前落盘格式)与 base64url DER(旧格式),
  老 `data/device-keys/*.json` 不会因升级而失效.

## Alternatives considered

### 1. 改测试去适配被删的导出

**Rejected:** 测试断言的是**官方协议常量**(端点路径,头部名,载荷形状),
它们是"与官方对齐"的护栏.为了迁就一次重写而删护栏,等于放弃这层保护.

### 2. 只补回常量,纯函数继续内联

**Rejected:** 常量与算法会各写一份,日后改一处漏一处 —— 正是本次事故的成因.
现状是 `DeviceSigner` 也走同一批纯函数.

### 3. 什么都不做(带着失败的测试发布)

**Rejected:** 违反项目铁律"提交前必须全过 npm test".

## Related

- `.agents/notes/implemented/bug-fix/2026-10-02-device-signing-raw-public-key.md`(raw 公钥那次修复)
- 协议逆向总结:`docs/reverse/02-device-signing.md` § 设备签名(`REVERSE_ENGINEERING_SUMMARY.md` 已废弃删除:它写的头名/载荷字段数是错的)
