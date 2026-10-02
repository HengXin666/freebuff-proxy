/**
 * Freebuff/Codebuff 设备签名协议实现
 * 
 * 逆向自官方客户端 (Freebuff-0.0.156-linux-x86_64.AppImage)
 * orchestrator.js 第 134777-135150 行
 * 
 * 协议细节:
 * 1. 使用 Ed25519 密钥对
 * 2. 签名载荷格式 (换行符分隔):
 *    freebuff-device-v1\n{METHOD}\n{PATH}\n{TIMESTAMP_MS}\n{BODY_SHA256}\n{FETCH_ID}
 * 3. 三个请求头:
 *    - x-freebuff-device-key: {keyId}
 *    - x-freebuff-device-ts: {timestampMs}
 *    - x-freebuff-device-sig: {base64url(signature)}
 */

import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../util/log.js';

const DEVICE_KEYS_PATH = '/api/v1/freebuff/device-keys';
const DEVICE_KEY_HEADER = 'x-freebuff-device-key';
const DEVICE_TIMESTAMP_HEADER = 'x-freebuff-device-ts';
const DEVICE_SIGNATURE_HEADER = 'x-freebuff-device-sig';
const REGISTER_TIMEOUT_MS = 10000;
const REGISTER_RETRY_MS = 300000; // 5分钟

/**
 * Base64url 编码
 */
function base64UrlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 计算请求体的 SHA256 (hex)
 */
function bodySha256(body) {
  if (!body) return createHash('sha256').update('').digest('hex');
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 生成签名载荷
 */
function buildSignaturePayload({ method, path, timestampMs, bodySha256, fetchId = '' }) {
  return [
    'freebuff-device-v1',
    method.toUpperCase(),
    path,
    String(timestampMs),
    bodySha256,
    fetchId
  ].join('\n');
}

/**
 * Ed25519 签名
 */
function signPayload(privateKeyPem, payload) {
  const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), {
    key: privateKeyPem,
    format: 'pem'
  });
  return base64UrlEncode(signature);
}

/**
 * 设备签名器
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
   * 生成设备密钥对
   */
  generateKeyPair() {
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
   * 加载或生成设备密钥
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
   * 持久化密钥
   */
  async persist() {
    if (!this.keyStore) return;
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(this.keyStore, null, 2), { mode: 0o600 });
  }

  /**
   * 获取或注册 keyId
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
   * 向上游注册设备密钥
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
          'Authorization': `Bearer ${this.token}`,
          'x-codebuff-api-key': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: key.publicKey,
          client: 'freebuff-proxy'
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
   * 为请求生成设备签名头
   * @param {{ method: string, url: string, body: string | null, fetchId: string | null }} params
   * @returns {Promise<Record<string, string>>}
   */
  async headersFor({ method, url, body, fetchId }) {
    try {
      const keyId = await this.getKeyId();
      if (!keyId) {
        logger.info('no keyId available, skipping device signature');
        return {}; // 签名失败，返回空头（上游会当作未签名请求处理）
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
      return {}; // 签名失败，返回空头
    }
  }

  /**
   * 忘记注册（当上游报 device_key unknown 错误时调用）
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
