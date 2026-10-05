/**
 - Freebuff/Codebuff 设备签名协议的纯函数层  --  常量与无状态原语.
 *
 * 逆向自官方客户端 (Freebuff-0.0.156-linux-x86_64.AppImage)
 * orchestrator.js 第 134777-135150 行
 *
 * 协议细节:
 * 1. 使用 Ed25519 密钥对
 * 2. 签名载荷格式 (换行符分隔):
 * freebuff-device-v1\n{METHOD}\n{PATH}\n{TIMESTAMP_MS}\n{BODY_SHA256}\n{FETCH_ID}
 * 3. 三个请求头:
 * - x-freebuff-device-key: {keyId}
 * - x-freebuff-device-ts: {timestampMs}
 * - x-freebuff-device-sig: {base64url(signature)}
 *
 * 为什么单独成文件: 原 device-signing.ts 480 行超 300 红线. 它里有两类东西:
 * 本文件(头部名常量 + 纯函数, 可脱离网络与磁盘单独测)与有状态的 DeviceSigner
 * (读密钥文件, 注册, 退避). 状态机与纯原语的审查方式完全不同, 分开放之后
 * "签名算得对不对"可以只盯着本文件看.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';

export const FREEBUFF_DEVICE_KEYS_PATH = '/api/v1/freebuff/device-keys';
export const DEVICE_KEY_HEADER_NAME = 'x-freebuff-device-key';
export const DEVICE_TIMESTAMP_HEADER_NAME = 'x-freebuff-device-ts';
export const DEVICE_SIGNATURE_HEADER_NAME = 'x-freebuff-device-sig';
export const DEVICE_SIGNATURE_VERSION = 'freebuff-device-v1';

export const DEVICE_KEYS_PATH = FREEBUFF_DEVICE_KEYS_PATH;
export const DEVICE_KEY_HEADER = DEVICE_KEY_HEADER_NAME;
export const DEVICE_TIMESTAMP_HEADER = DEVICE_TIMESTAMP_HEADER_NAME;
export const DEVICE_SIGNATURE_HEADER = DEVICE_SIGNATURE_HEADER_NAME;

// 测试与旧 import 点使用的别名(官方头部名逐字,不要另立取值)
export const HEADER_DEVICE_KEY = DEVICE_KEY_HEADER_NAME;
export const HEADER_DEVICE_TIMESTAMP = DEVICE_TIMESTAMP_HEADER_NAME;
export const HEADER_DEVICE_SIGNATURE = DEVICE_SIGNATURE_HEADER_NAME;

export const REGISTER_TIMEOUT_MS = 10000;
export const REGISTER_RETRY_MS = 300000; // 5分钟

/**
 - Base64url 编码
 - @param {any} buffer 待编码的 Buffer
 - @returns {string} base64url 字符串(无 padding)
 */
export function base64UrlEncode(buffer: any) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 - 计算请求体的 SHA256 (hex)
 - 空 body = 空串的哈希(e3b0c442...),官方同款.
 - @param {any} body 请求体(字符串或可 JSON 序列化的对象)
 - @returns {string} 64 位小写 hex
 */
export function bodySha256(body: any) {
  if (!body) return createHash('sha256').update('').digest('hex');
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  return createHash('sha256').update(content).digest('hex');
}

/**
 - Base64url 解码
 - @param {any} str base64url 字符串
 - @returns {Buffer} 解码后的 Buffer
 */
export function base64UrlDecode(str: any) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  return Buffer.from(base64 + padding, 'base64');
}

/**
 - 生成签名载荷(换行拼接,METHOD 大写,fetchId 缺失用空串占位).
 - 逐字对齐官方 freebuffDeviceSignaturePayload():6 行,缺一不可.
 - @param {any} args 载荷字段 { method, path, timestampMs, bodySha256, fetchId }
 - @returns {string} 换行分隔的签名载荷
 */
export function deviceSignaturePayload(args: any) {
  const { method, path, timestampMs, bodySha256, fetchId } = args;
  return [
    DEVICE_SIGNATURE_VERSION,
    String(method).toUpperCase(),
    path,
    String(timestampMs),
    bodySha256,
    fetchId ?? '',
  ].join('\n');
}

/**
 - buildSignaturePayload 的同义名(内部调用点沿用).
 - @param {any} opts 同 deviceSignaturePayload 的载荷字段
 - @returns {string} 签名载荷
 */
export function buildSignaturePayload(opts: any) {
  return deviceSignaturePayload(opts);
}

/**
 - 生成一对 Ed25519 密钥(raw 公钥 + pkcs8 私钥,均 base64url).
 - 公钥必须是 raw 32 字节:上游要求 "base64url raw Ed25519 public key",
 - 传 SPKI 会被 400 拒绝.见
 - .agents/notes/implemented/bug-fix/2026-10-02-device-signing-raw-public-key.md
 - @returns {{ version: number, publicKey: string, privateKey: string, registrations: object }}
 -   新的密钥记录
 */
export function generateDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // SPKI DER = 12 字节头部 + 32 字节原始公钥
  const rawPublicKey = publicKey.slice(-32);
  return {
    version: 1,
    publicKey: base64UrlEncode(rawPublicKey),
    privateKey: privateKey,
    registrations: {},
  };
}

/**
 - 校验并规范化一个已存的密钥记录.
 - @param {any} value 已落盘的密钥记录原文
 - @returns {{ version: number, publicKey: string, privateKey: string, registrations: object } | null}
 -   合法则返回规范化记录,否则 null
 */
export function parseDeviceKeyRecord(value: any) {
  if (!value || typeof value !== 'object') return null;
  if (value.version !== 1) return null;
  if (typeof value.publicKey !== 'string' || typeof value.privateKey !== 'string') {
    return null;
  }
  const registrations: any = {};
  const stored = value.registrations;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [scope, keyId] of Object.entries(stored)) {
      if (typeof keyId === 'string' && keyId) registrations[scope] = keyId;
    }
  }
  return {
    version: 1,
    publicKey: value.publicKey,
    privateKey: value.privateKey,
    registrations,
  };
}

/**
 - 注册作用域:一个 (apiHost, account) 一个 keyId(官方同款字符串).
 - @param {any} apiHost 上游 API 主机
 - @param {any} accountId 账号用户 id
 - @returns {string} 作用域字符串
 */
export function registrationScope(apiHost: any, accountId: any) {
  return `${apiHost} user:${accountId}`;
}

/**
 - 从 PEM/PKCS#8 私钥导入 KeyObject.
 - @param {any} record 密钥记录(含 privateKey)
 - @returns {any} KeyObject;无法导入返回 null
 */
export function importDevicePrivateKey(record: any) {
  try {
    const pem = record.privateKey;
    // 既支持 PEM 字符串(本实现落盘格式),也支持 base64url DER(旧格式)
    const key = pem.includes('-----BEGIN')
      ? pem
      : base64UrlDecode(pem);
    return createPrivateKey(
      pem.includes('-----BEGIN')
        ? { key: pem, format: 'pem' }
        : { key, format: 'der', type: 'pkcs8' },
    );
  } catch {
    return null;
  }
}

/**
 - 对一个请求算签名,返回三个头.纯函数(不碰 IO).
 - @param {any} args 签名输入 { privateKey, keyId, method, url, body, fetchId, timestampMs }
 - @returns {Record<string, string>} 三个设备签名头
 */
export function signDeviceRequest(args: any) {
  const { privateKey, keyId, method, url, body, fetchId, timestampMs } = args;
  const urlObj = new URL(url);
  const ts = timestampMs ?? Date.now();
  const payload = deviceSignaturePayload({
    method,
    path: urlObj.pathname,
    timestampMs: ts,
    bodySha256: bodySha256(body),
    fetchId: fetchId ?? null,
  });
  const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey);
  return {
    [DEVICE_KEY_HEADER]: keyId,
    [DEVICE_TIMESTAMP_HEADER]: String(ts),
    [DEVICE_SIGNATURE_HEADER]: base64UrlEncode(signature),
  };
}

/**
 - Ed25519 签名(payload → base64url)
 - @param {any} privateKeyPem PEM 私钥
 - @param {any} payload 签名载荷
 - @returns {string} base64url 签名
 */
export function signPayload(privateKeyPem: any, payload: any) {
  const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), {
    key: privateKeyPem,
    format: 'pem',
  });
  return base64UrlEncode(signature);
}

/**
 - 生成一份新的设备密钥记录(Ed25519).
 *
 - 独立导出而非只作为 DeviceSigner 的方法:bun 通道装配 cfg 时
 - (official-rpc.ts buildRpcCfg)也需要在密钥文件缺失时就地生成----
 - Docker 全新卷上该文件从来没有过,而生成它的 DeviceSigner 只在 Node
 - 路径被调用,session 走 bun 时压根不经过它(死锁).
 - 同一份生成逻辑,两处复用,避免私钥格式漂移.
 - @returns {{ version: number, publicKey: string, privateKey: string, registrations: object }}
 -   新的密钥记录
 */
export function createDeviceKeyRecord() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // 从 SPKI 格式中提取原始的 32 字节 Ed25519 公钥
  // SPKI 格式: 头部(12字节) + 原始公钥(32字节)
  const rawPublicKey = publicKey.slice(-32);

  return {
    version: 1,
    publicKey: base64UrlEncode(rawPublicKey),
    privateKey: privateKey,
    registrations: {}
  };
}
