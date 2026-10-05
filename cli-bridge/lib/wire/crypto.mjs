/**
 - base64url / sha256 / 设备签名载荷 -- 从 cli-bridge/upstream.mjs 逐字搬出.
 - 官方同款: sha256 为完整 hex, 空 body = sha256(""); 载荷 6 行, 缺一不可.
 */
// ---- base64url / sha256(官方同款:complete hex,空 body = sha256(""))----
/**
 - buffer 转 base64url(无 padding).
 - @param {ArrayBuffer|Uint8Array} buf 字节
 - @returns {string} base64url 字符串
 */
export function b64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 - 算 body 的 sha256 hex(空 body 等价 sha256("")).
 - @param {unknown} body 请求体
 - @returns {Promise<string>} 64 位小写 hex
 */
export async function sha256Hex(body) {
  const data = body == null ? new Uint8Array(0) : new TextEncoder().encode(String(body));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 - base64url 转 DER 字节.
 - @param {string} s base64url
 - @returns {Uint8Array} DER 字节
 */
export function derFromB64u(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 官方 freebuffDeviceSignaturePayload:6 行,\n 分隔,缺一不可. */
/**
 - 官方 freebuffDeviceSignaturePayload: 6 行, 换行分隔, 缺一不可.
 - @param {{method: string, path: string, timestampMs: number, bodySha256: string, fetchId?: string|null}} opts 签名要素
 - @returns {string} 待签名载荷
 */
export function devicePayload(opts) {
  const { method, path, timestampMs, bodySha256, fetchId } = opts
  return [
    'freebuff-device-v1',
    String(method).toUpperCase(),
    path,
    String(timestampMs),
    bodySha256,
    fetchId ?? '',
  ].join('\n');
}
