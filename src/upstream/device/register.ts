/**
 * 设备公钥注册: 向上游换回服务端签发的 keyId.
 *
 * 从 device-signing.ts 按职责切出(该方法 58 行, 含完整 HTTP 重试与回执解析).
 * 依赖由调用方以参数注入, 因此不持有 DeviceSigner 实例 ----
 * 这样注册流程可以单独读,单独测, 而不必构造整个签名器.
 */
import { logger } from '../../util/log.ts'
import { DEVICE_KEYS_PATH, REGISTER_RETRY_MS, REGISTER_TIMEOUT_MS } from './signing.ts'

/**
 * 用设备私钥向上游注册公钥, 换回服务端签发的 keyId.
 * @param {any} signer 设备签名器(提供 apiHost / token / fetchImpl / persist / retryAfter)
 * @param {string} scope 注册用途(上游按它区分密钥)
 * @param {any} key 设备密钥记录
 * @returns {Promise<any>} keyId; 失败返回 null 并退避
 */
export async function registerDeviceKey(signer: any, scope: any, key: any) {
    const url = `${signer.apiHost}${DEVICE_KEYS_PATH}`;
    logger.info('registering device key', { url, scope: scope.slice(0, 50) + '...' });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);

      const res = await signer.fetchImpl(url, {
        method: 'POST',
        headers: {
          //  只有 Bearer:客户端注册 device-keys 时也只带 Bearer +
          // Content-Type(抓包真值),没有 x-codebuff-api-key.
          'Authorization': `Bearer ${signer.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: key.publicKey,
          // 官方抓包 body 是 client: "desktop"
          // (二进制 orchestrator.js:216629 同源).
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
        signer.retryAfter = Date.now() + REGISTER_RETRY_MS;
        return null;
      }

      const body = await res.json();
      const keyId = body.keyId;

      if (!keyId) {
        logger.warn('device key registration failed: no keyId in response', { body });
        signer.retryAfter = Date.now() + REGISTER_RETRY_MS;
        return null;
      }

      // 保存注册
      key.registrations[scope] = keyId;
      await signer.persist();
      logger.info('device key registered successfully', { keyId, scope: scope.slice(0, 50) + '...' });
      return keyId;

    } catch (err: any) {
      logger.warn('device key registration error', { error: err.message, stack: err.stack?.slice(0, 300) });
      signer.retryAfter = Date.now() + REGISTER_RETRY_MS;
      return null;
    }
}
