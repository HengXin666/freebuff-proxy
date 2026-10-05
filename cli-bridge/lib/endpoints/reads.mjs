/**
 - 只读端点(auth / catalog / deviceKeys / session / release) -- 从 cli-bridge/upstream.mjs 搬出.
 - 每个函数第一个参数是 bridge 实例; 原方法体里的 this 已逐字改为 bridge.
 */
import { dumpReq } from '../wire/dump.mjs'
import { b64u, sha256Hex, derFromB64u, devicePayload } from '../wire/crypto.mjs'

/**
 - 认证头.
 - @param {any} bridge Bridge 实例
 - @returns {{Authorization: string}} 认证头
 */
export function auth(bridge) {

  return { Authorization: `Bearer ${bridge.cfg.token}` };
}

/**
 - 抓目录并记下 fetchId(头集逐字对齐官方抓包).
 - @param {any} bridge Bridge 实例
 - @returns {Promise<any>} 目录对象
 */
export async function fetchCatalog(bridge) {

  const url = `${bridge.host}/api/v1/freebuff/models`;
  /**
   *  头集逐字对齐官方抓包(165 条里 catalog 那 1 条原样):
   *
   *   Authorization: Bearer <token>
   *   x-freebuff-catalog-protocol: 1
   *   x-freebuff-client: desktop
   *   User-Agent: Bun/1.4.2      ← bun 裸 fetch 的默认 UA,天然一致
   *   Accept: * / *               ← bun 默认,天然一致
   *
   * 两处修正(见 docs/reverse/19 §19.10):
   *   - 补 x-freebuff-client: desktop(此前缺);
   *   - 去掉设备签名:官方这一跳不签(只有 session 才签),
   *     带了会让目录行数从 13 变成 53 ---- 那是形态偏离换来的另一份响应.
   *
   * bun 不会像 Node 那样自动加 accept-language / sec-fetch-mode,
   * 所以这一跳在 bun 上与客户端完全一致.
   */
  const h1 = {
    ...bridge.auth(),
    'x-freebuff-catalog-protocol': '1',
    'x-freebuff-client': 'desktop',
  };
  await dumpReq('catalog', 'GET', url, h1, null);
  const res = await fetch(url, { headers: h1 });
  if (!res.ok) throw new Error(`catalog ${res.status}: ${(await res.text()).slice(0, 200)}`);
  bridge.catalog = await res.json();
  bridge.fid = bridge.catalog.fetchId;
  return bridge.catalog;
}

/**
 - 注册设备公钥换 keyId(签名前置).
 - @param {any} bridge Bridge 实例
 - @param {string} publicKey base64url raw Ed25519
 - @returns {Promise<{status: number, body: any}>} 注册结果
 */
export async function registerDeviceKey(bridge, publicKey) {

  const url = `${bridge.host}/api/v1/freebuff/device-keys`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...bridge.auth(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ publicKey, client: 'desktop' }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/**
 - GET 会话(支持官方"持有心跳"形态).
 - @param {any} bridge Bridge 实例
 - @param {{instanceId?: string|null, heartbeat?: boolean}} [opts] 选项
 - @returns {Promise<{status: number, body: any}>} 会话结果
 */
export async function getSession(bridge, opts = {}) {

  const instanceId = opts.instanceId || null
  const heartbeat = opts.heartbeat === true
  const url = `${bridge.host}/api/v1/freebuff/session`;
  const res = await fetch(url, {
    headers: {
      ...bridge.auth(),
      'x-freebuff-catalog-protocol': '1',
      ...(bridge.fid ? { 'x-freebuff-catalog-fetch': bridge.fid } : {}),
      'x-freebuff-client': 'desktop',
      // 官方:心跳不带时区(...!heartbeat ? freebucksTimeZoneHeaders() : {}).
      // 非心跳形态仍带(docs/reverse/21 §21.3 真值).
      ...(heartbeat
        ? {}
        : {
            'x-fb-timezone':
              bridge.cfg.timeZone ||
              (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
          }),
      //  不要发字面量 'null':主服务没传 installId 时整个头应省略
      ...(bridge.cfg.installId ? { 'x-freebuff-install-id': bridge.cfg.installId } : {}),
      'x-freebuff-first-tab-discount': '0',
      'x-freebuff-multi-session': '1',
      //  实例标识:官方只有"带 instanceId"这一种 GET 形态
      ...(instanceId ? { 'x-freebuff-instance-id': instanceId } : {}),
      // 二选一(官方三元):心跳用 -heartbeat,普通查询用 -include-unused-rate-limits
      ...(heartbeat
        ? { 'x-freebuff-heartbeat': '1' }
        : { 'x-freebuff-include-unused-rate-limits': '1' }),
      ...(await bridge.signHeaders('GET', url, null, bridge.fid)),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 - DELETE 会话(带 instance-id).
 - @param {any} bridge Bridge 实例
 - @param {string} instanceId 会话实例
 - @returns {Promise<{status: number, text: string}>} 释放结果
 */
export async function release(bridge, instanceId) {

  const url = `${bridge.host}/api/v1/freebuff/session`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...bridge.auth(),
      'x-freebuff-catalog-protocol': '1',
      ...(bridge.fid ? { 'x-freebuff-catalog-fetch': bridge.fid } : {}),
      'x-freebuff-instance-id': instanceId,
      'x-freebuff-multi-session': '1',
      'x-freebuff-purchase-continuity': '1',
      ...(await bridge.signHeaders('DELETE', url, null, bridge.fid)),
    },
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, text: text.slice(0, 300) };
}
