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
 *
 - 纯函数层(头部名常量 / 载荷构造 / 签名 / 密钥记录)已按职责搬进 device/signing.ts,
 - 这里原样 re-export 以保持既有 import 点不变; 本文件只保留有状态的 DeviceSigner
 - (读密钥文件 / 注册 / 退避). 见 .agents/notes/implemented/bug-fix/
 - 2026-10-02-device-signing-raw-public-key.md.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../../util/log.ts';
import {
  DEVICE_KEYS_PATH,
  DEVICE_KEY_HEADER,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_TIMESTAMP_HEADER,
  REGISTER_RETRY_MS,
  REGISTER_TIMEOUT_MS,
  bodySha256,
  buildSignaturePayload,
  createDeviceKeyRecord,
  signPayload,
} from './signing.ts';
import { registerDeviceKey } from './register.ts';

export {
  DEVICE_KEYS_PATH,
  DEVICE_KEY_HEADER,
  DEVICE_KEY_HEADER_NAME,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_SIGNATURE_HEADER_NAME,
  DEVICE_SIGNATURE_VERSION,
  DEVICE_TIMESTAMP_HEADER,
  DEVICE_TIMESTAMP_HEADER_NAME,
  FREEBUFF_DEVICE_KEYS_PATH,
  HEADER_DEVICE_KEY,
  HEADER_DEVICE_SIGNATURE,
  HEADER_DEVICE_TIMESTAMP,
  REGISTER_RETRY_MS,
  REGISTER_TIMEOUT_MS,
  base64UrlDecode,
  base64UrlEncode,
  bodySha256,
  buildSignaturePayload,
  createDeviceKeyRecord,
  deviceSignaturePayload,
  generateDeviceKey,
  importDevicePrivateKey,
  parseDeviceKeyRecord,
  registrationScope,
  signDeviceRequest,
  signPayload,
} from './signing.ts';

/**
 - 设备签名器
 */
export class DeviceSigner {
  declare storePath: any
  declare apiHost: any
  declare accountId: any
  declare token: any
  declare fetchImpl: any
  declare keyStore: any
  declare loading: any
  declare retryAfter: any
  declare registering: any
  constructor({ storePath, apiHost, accountId, token, fetchImpl }: any) {
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
   * 生成一对新的设备密钥(纯本地, 不联网).
   * @returns {any} 设备密钥记录(含私钥与 keyId)
   */
  generateKeyPair() {
    return createDeviceKeyRecord()
  }

  /**
   * 确保本地有可用设备密钥: 已加载则直接返回, 否则从磁盘读/新建并落盘.
   * @returns {Promise<any>} 设备密钥记录
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
      } catch (err: any) {
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

  /** 持久化密钥到磁盘(mode 0600, 目录不存在则递归创建). */
  async persist() {
    if (!this.keyStore) return;
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(this.keyStore, null, 2), { mode: 0o600 });
  }

  /**
   * 取设备密钥的 id(必要时先生成密钥).
   * @returns {Promise<string|null>} keyId; 拿不到时返回 null
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
   * 用设备私钥向上游注册公钥, 换回服务端签发的 keyId.
   * @param {string} scope 注册用途(上游按它区分密钥)
   * @param {any} key 设备密钥记录
   * @returns {Promise<any>} keyId; 失败返回 null 并退避
   */
  async register(scope: any, key: any) {
    return registerDeviceKey(this, scope, key)
  }

  /**
   * 为请求生成设备签名头.
   * @param {string} method HTTP 方法
   * @param {string} url 请求 URL
   * @param {string | null} body 请求体
   * @param {string | null} fetchId 目录 fetchId
   * @returns {Promise<Record<string, string>>} 设备签名头(拿不到密钥时为空对象)
   */
  async headersFor({ method, url, body, fetchId }: any) {
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
    } catch (err: any) {
      logger.error('device signature generation failed', {
        error: err.message,
        stack: err.stack?.slice(0, 300),
      });
      return {}; // 签名失败,返回空头
    }
  }

  /** 忘记注册(上游报 device_key unknown 错误时调用). */
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
