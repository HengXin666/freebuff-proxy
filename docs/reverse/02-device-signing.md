# 02 — 设备签名协议（Ed25519）

源码：`orchestrator.js:134777`（常量）、`134840-135090`（实现）、`208164-208210`（装配）

## 2.1 常量（逐字）

```js
FREEBUFF_DEVICE_KEYS_PATH      = "/api/v1/freebuff/device-keys"
FREEBUFF_DEVICE_KEY_HEADER     = "x-freebuff-device-key"
FREEBUFF_DEVICE_TIMESTAMP_HEADER = "x-freebuff-device-ts"
FREEBUFF_DEVICE_SIGNATURE_HEADER = "x-freebuff-device-sig"
签名版本串                      = "freebuff-device-v1"
```

## 2.2 签名载荷（6 行，`\n` 分隔，缺一不可）

```js
function freebuffDeviceSignaturePayload(params) {
  return [
    "freebuff-device-v1",
    params.method.toUpperCase(),
    params.path,                      // 只取 pathname，不带 query
    String(params.timestampMs),
    params.bodySha256,                // 完整 hex（不是前 43 字符！）
    params.fetchId ?? ""              // 没有就空串占位，行仍存在
  ].join("\n");
}
```

⚠️ **两处易错**（仓库曾踩）：
- bodySha256 是**完整 64 位 hex**。空 body = `sha256("")` = `e3b0c442...`（不是省掉）。
- `path` 用 `new URL(url).pathname`，**不含查询串**（`?refundClaim=` 那种要剥掉）。

## 2.3 密钥生成与注册

```js
// Ed25519；extractable = true
pair = await subtle.generateKey({name:"Ed25519"}, true, ["sign","verify"])
publicKey  = base64url(await subtle.exportKey("raw",  pair.publicKey))   // raw 32 字节
privateKey = base64url(await subtle.exportKey("pkcs8", pair.privateKey)) // pkcs8 DER
```

⚠️ 公钥必须是 **raw 32 字节** base64url；传 SPKI 会被 400 拒。
本机落盘格式：`privateKey` 是 **base64url 的 pkcs8 DER**，不是 PEM ——
Node 导入要 `createPrivateKey({key: derBuf, format:'der', type:'pkcs8'})`。

注册：
```
POST https://www.codebuff.com/api/v1/freebuff/device-keys
Authorization: Bearer <token>
content-type: application/json

{ "publicKey": "<base64url raw>", "client": "desktop" }
```
→ `{ "keyId": "YP21Eug4HHmST2REeo2iBn", ... }`

`client` 字段官方是 **`"desktop"`**（`orchestrator.js:216629`）。
仓库里曾写 `client: 'freebuff-proxy'` —— **自杀式标识**，等于自己申报第三方客户端。

注册失败退避（官方 `register()`）：
- 404 / 405 → 1 小时后再试（`REGISTER_UNSUPPORTED_RETRY_MS`）
- 其他 → 5 分钟（`REGISTER_RETRY_MS`）

## 2.4 作用域 scope（一个 host+user 一个 keyId）

```js
scope = accountId ? `${host} user:${accountId}`
                  : `${host} token:${sha256(token).slice(0,32)}`
```
本机实测 `state.json.device-key.json` 里 5 个 user 全指向**同一个 keyId**
`YP21Eug4HHmST2REeo2iBn` —— 上游对同一设备复用。

## 2.5 装配点：RequestIntegrity

```js
class RequestIntegrity {
  completionHeaders(token, req) { return this.catalogModeHeaders(token, req) }
  sessionHeaders(auth, req)     { return this.catalogModeHeaders(bearerToken(auth), req) }

  async catalogModeHeaders(token, req) {
    const catalog = this.deps.catalog();
    if (!catalog || !token) return {};           // ← 没有 catalog 就不签名！
    const fetchId = catalog.fetchId;
    return {
      ...(fetchId ? { "x-freebuff-catalog-fetch": fetchId } : {}),
      ...await this.sign(token, {...req, fetchId}, true)
    };
  }
}
```

**关键推论**：设备签名与 catalog **强绑定**。
没拉 catalog（或 catalog 为空）→ 三头直接不发送 → 请求退化为裸 token 请求
→ 这正是"被判第三方客户端"的形态。

## 2.6 失效自愈

```js
function isFreebuffDeviceKeyUnknownError(code) {
  return /device[_-]?key/i.test(code) && /unknown|not[_-]?found|invalid|unregistered/i.test(code)
}
```
命中就 `forgetRegistration()`，下次请求重新注册。（`orchestrator.js:208177`）

## 2.7 本机实测值

```
state.json.device-key.json
  version    : 1
  publicKey  : bO56WAOwY04MkU9uTQDVJE2B... (base64url raw)
  privateKey : <base64url pkcs8 DER>
  registrations: 5 个 scope → YP21Eug4HHmST2REeo2iBn
```
