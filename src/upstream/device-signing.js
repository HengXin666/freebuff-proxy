/**
 - Freebuff/Codebuff 设备签名协议实现
 *
 - 逆向自官方客户端 (Freebuff-0.0.156-linux-x86_64.AppImage)
 - orchestrator.js 第 134777-135150 行
 *
 - 协议细节:
 - 1. 使用 Ed25519 密钥对
 - 2. 签名载荷格式 (换行符分隔):
 - freebuff-device-v1\n{METHOD}\n{PATH}\n{TIMESTAMP_MS}\n{BODY_SHA256}\n{FETCH_ID}
 - 3. 三个请求头:
 - - x-freebuff-device-key: {keyId}
 - - x-freebuff-device-ts: {timestampMs}
 - - x-freebuff-device-sig: {base64url(signature)}
 */

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../util/log.js';

export const FREEBUFF_DEVICE_KEYS_PATH = '/api/v1/freebuff/device-keys';
export const DEVICE_KEY_HEADER_NAME = 'x-freebuff-device-key';
export const DEVICE_TIMESTAMP_HEADER_NAME = 'x-freebuff-device-ts';
export const DEVICE_SIGNATURE_HEADER_NAME = 'x-freebuff-device-sig';
export const DEVICE_SIGNATURE_VERSION = 'freebuff-device-v1';

const DEVICE_KEYS_PATH = FREEBUFF_DEVICE_KEYS_PATH;
const DEVICE_KEY_HEADER = DEVICE_KEY_HEADER_NAME;
const DEVICE_TIMESTAMP_HEADER = DEVICE_TIMESTAMP_HEADER_NAME;
const DEVICE_SIGNATURE_HEADER = DEVICE_SIGNATURE_HEADER_NAME;

// 测试与旧 import 点使用的别名(官方头部名逐字,不要另立取值)
export const HEADER_DEVICE_KEY = DEVICE_KEY_HEADER_NAME;
export const HEADER_DEVICE_TIMESTAMP = DEVICE_TIMESTAMP_HEADER_NAME;
export const HEADER_DEVICE_SIGNATURE = DEVICE_SIGNATURE_HEADER_NAME;

const REGISTER_TIMEOUT_MS = 10000;
const REGISTER_RETRY_MS = 300000; // 5分钟

/**
 - Base64url 编码
 */
function base64UrlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 - 计算请求体的 SHA256 (hex)
 - 空 body = 空串的哈希(e3b0c442...),官方同款.
 */
export function bodySha256(body) {
  if (!body) return createHash('sha256').update('').digest('hex');
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  return createHash('sha256').update(content).digest('hex');
}

/**
 - Base64url 解码
 */
function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  return Buffer.from(base64 + padding, 'base64');
}

/**
 - 生成签名载荷(换行拼接,METHOD 大写,fetchId 缺失用空串占位).
 - 逐字对齐官方 freebuffDeviceSignaturePayload():6 行,缺一不可.
 */
export function deviceSignaturePayload({
  method,
  path,
  timestampMs,
  bodySha256,
  fetchId,
}) {
  return [
    DEVICE_SIGNATURE_VERSION,
    String(method).toUpperCase(),
    path,
    String(timestampMs),
    bodySha256,
    fetchId ?? '',
  ].join('\n');
}

/** buildSignaturePayload 的同义名(内部调用点沿用). */
function buildSignaturePayload(opts) {
  return deviceSignaturePayload(opts);
}

/**
 - 生成一对 Ed25519 密钥(raw 公钥 + pkcs8 私钥,均 base64url).
 - 公钥必须是 raw 32 字节:上游要求 "base64url raw Ed25519 public key",
 - 传 SPKI 会被 400 拒绝.见
 - .agents/notes/implemented/bug-fix/2026-10-02-device-signing-raw-public-key.md
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

/** 校验并规范化一个已存的密钥记录. */
export function parseDeviceKeyRecord(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.version !== 1) return null;
  if (typeof value.publicKey !== 'string' || typeof value.privateKey !== 'string') {
    return null;
  }
  const registrations = {};
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

/** 注册作用域:一个 (apiHost, account) 一个 keyId(官方同款字符串). */
export function registrationScope(apiHost, accountId) {
  return `${apiHost} user:${accountId}`;
}

/** 从 PEM/PKCS#8 私钥导入 KeyObject. */
export function importDevicePrivateKey(record) {
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
 */
export function signDeviceRequest({
  privateKey,
  keyId,
  method,
  url,
  body,
  fetchId,
  timestampMs,
}) {
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
 */
function signPayload(privateKeyPem, payload) {
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
 - (official-rpc.js buildRpcCfg)也需要在密钥文件缺失时就地生成——
 - Docker 全新卷上该文件从来没有过,而生成它的 DeviceSigner 只在 Node
 - 路径被调用,session 走 bun 时压根不经过它(死锁).
 - 同一份生成逻辑,两处复用,避免私钥格式漂移.
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

/**
 - 设备签名器
 */
export class DeviceSigner {
  constructor({ storePath, apiHost, accountId, token, fetchImpl }) {
    this.storePath = storePath;
    this.apiHost = apiHost;
    this.accountId = accountId;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.keyStore = null;
    this.loading = null;
    this.registering = null;
    this.retryAfter = 0;

    logger.info('DeviceSigner constructed', {
      storePath,
      apiHost,
      accountId: accountId?.slice(0, 8) + '...',
      hasToken: !!token,
      hasFetch: !!fetchImpl,
    });
  }

  /**
   - 生成设备密钥对
   */
  generateKeyPair() {
    return createDeviceKeyRecord()
  }

  /**
   - 加载或生成设备密钥
   */
  async ensureKey() {
    if (this.loading) return this.loading;

    this.loading = (async () => {
      if (this.keyStore) return this.keyStore;

      try {
        const data = await readFile(this.storePath, 'utf8');
        this.keyStore = JSON.parse(data);
        logger.info('device key loaded', { storePath: this.storePath });
        return this.keyStore;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn('failed to load device key', { error: err.message });
        }
      }

      // 生成新密钥
      this.keyStore = this.generateKeyPair();
      await this.persist();
      logger.info('device key generated and saved', {
        storePath: this.storePath,
        publicKey: this.keyStore.publicKey.slice(0, 16) + '...',
      });
      return this.keyStore;
    })();

    return this.loading;
  }

  /**
   - 持久化密钥
   */
  async persist() {
    if (!this.keyStore) return;
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(this.keyStore, null, 2), { mode: 0o600 });
  }

  /**
   - 获取或注册 keyId
   */
  async getKeyId() {
    const key = await this.ensureKey();
    const scope = `${this.apiHost} user:${this.accountId}`;

    // 已注册
    if (key.registrations[scope]) {
      logger.info('using cached keyId', {
        scope: scope.slice(0, 50) + '...',
        keyId: key.registrations[scope],
      });
      return key.registrations[scope];
    }

    // 重试冷却中
    if (this.retryAfter > Date.now()) {
      logger.info('device key registration in cooldown', {
        retryAfter: new Date(this.retryAfter).toISOString(),
      });
      return null;
    }

    // 正在注册
    if (this.registering) {
      logger.info('waiting for pending registration');
      return this.registering;
    }

    // 开始注册
    this.registering = this.register(scope, key);
    const result = await this.registering;
    this.registering = null;
    return result;
  }

  /**
   - 向上游注册设备密钥
   */
  async register(scope, key) {
    const url = `${this.apiHost}${DEVICE_KEYS_PATH}`;
    logger.info('registering device key', { url, scope: scope.slice(0, 50) + '...' });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);

      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          //  只有 Bearer:客户端注册 device-keys 时也只带 Bearer +
          // Content-Type(抓包真值),没有 x-codebuff-api-key.
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: key.publicKey,
          //  官方抓包 body 是 client: "desktop"(二进制
          // orchestrator.js:216629 同源).此前写 'freebuff-proxy' —— 那是
          // 自报家门的第三方特征.
          client: 'desktop',
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('device key registration failed', {
          status: res.status,
          statusText: res.statusText,
          body: text.slice(0, 200),
        });
        this.retryAfter = Date.now() + REGISTER_RETRY_MS;
        return null;
      }

      const body = await res.json();
      const keyId = body.keyId;

      if (!keyId) {
        logger.warn('device key registration failed: no keyId in response', { body });
        this.retryAfter = Date.now() + REGISTER_RETRY_MS;
        return null;
      }

      // 保存注册
      key.registrations[scope] = keyId;
      await this.persist();
      logger.info('device key registered successfully', { keyId, scope: scope.slice(0, 50) + '...' });
      return keyId;

    } catch (err) {
      logger.warn('device key registration error', { error: err.message, stack: err.stack?.slice(0, 300) });
      this.retryAfter = Date.now() + REGISTER_RETRY_MS;
      return null;
    }
  }

  /**
   - 为请求生成设备签名头
   - @param {{ method: string, url: string, body: string | null, fetchId: string | null }} params
   - @returns {Promise<Record<string, string>>}
   */
  async headersFor({ method, url, body, fetchId }) {
    try {
      const keyId = await this.getKeyId();
      if (!keyId) {
        logger.info('no keyId available, skipping device signature');
        return {}; // 签名失败,返回空头(上游会当作未签名请求处理)
      }

      const key = await this.ensureKey();
      const urlObj = new URL(url);
      const timestampMs = Date.now();

      const payload = buildSignaturePayload({
        method,
        path: urlObj.pathname,
        timestampMs,
        bodySha256: bodySha256(body),
        fetchId: fetchId || ''
      });

      const signature = signPayload(key.privateKey, payload);

      logger.info('device signature generated', {
        method,
        path: urlObj.pathname,
        keyId,
        timestampMs,
        fetchId: fetchId || '(none)',
        payloadPreview: payload.slice(0, 100).replace(/\n/g, '\\n'),
      });

      return {
        [DEVICE_KEY_HEADER]: keyId,
        [DEVICE_TIMESTAMP_HEADER]: String(timestampMs),
        [DEVICE_SIGNATURE_HEADER]: signature
      };
    } catch (err) {
      logger.error('device signature generation failed', {
        error: err.message,
        stack: err.stack?.slice(0, 300),
      });
      return {}; // 签名失败,返回空头
    }
  }

  /**
   - 忘记注册(当上游报 device_key unknown 错误时调用)
   */
  async forgetRegistration() {
    const key = await this.ensureKey();
    const scope = `${this.apiHost} user:${this.accountId}`;

    if (key.registrations[scope]) {
      delete key.registrations[scope];
      await this.persist();
      logger.info('forgot device key registration', { scope: scope.slice(0, 50) + '...' });
    }
  }
}
