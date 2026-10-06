/**
 * Bridge 实例 -- 从 cli-bridge/upstream.ts 逐字搬出.
 *
 *
 * 口径: 纯搬移, 不改行为. HOST 常量与类体逐字保留.
 */
import { b64u, sha256Hex, derFromB64u, devicePayload } from '../wire/crypto.ts'
import {
  auth, fetchCatalog, registerDeviceKey, getSession, getStreak, release,
  admit, startRun, reuseChat, finishRun, chat, _traceFor, _stepFor,
} from '../endpoints.ts'

/**
 *  上游主机必须可注入,不能硬编码.
 *
 */
const HOST = process.env.FREEBUFF_API_HOST || 'https://www.codebuff.com';

/**
 * 绑定到一份 cfg 的上游请求层(方法即端点).
 *
 * 刻意不 export: 对外只给 createBridge() 与 BridgeLike 类型. 这样
 * "这个类怎么签名, 怎么持有 cfg" 被锁在本文件里, 改它不需要看消费者;
 * 而 16 个一字转发的端点方法也不必各写一段 JSDoc(它们的契约在
 * lib/endpoints/** 的实现处).
 */
class Bridge {
  constructor(cfg) {
    this.cfg = cfg;
    /**
     * 每个实例按 cfg.apiHost 解析主机(不共享模块级常量).
     * 硬编码会让"本地镜像对照"变成"真的打到上游".
     */
    this.host = cfg?.apiHost || HOST;
    this.fid = null;      // catalog fetchId
    this.catalog = null;
  }

  async ensureKey() {
    if (this.priv) return this.priv;
    this.priv = await crypto.subtle.importKey(
      'pkcs8', derFromB64u(this.cfg.privateKey), { name: 'Ed25519' }, false, ['sign'],
    );
    return this.priv;
  }

  /**
   * 确保拿到 keyId:没有就自己注册一个(惰性注册).
   *
   *
   * 抓包真值(docs/reverse/21 §21.2):全 165 条里只有
   * /api/v1/freebuff/session 带签名(13 次).也就是说我们恰好在唯一
   * 的必签端点上裸奔 → 上游按未注册设备拒 → 401 → 控制台显示
   * [凭证失效],而 token 本身完全有效.
   *
   * [本地能通,远程不通]的全部差异就在这里:本地那份注册过了
   * (keyId 已落盘),远程那份没有.
   *
   * 主服务侧的 Node 路径(DeviceSigner)本来就有惰性注册,但 session 走
   * bun 通道时根本不经过它 -- 两条通道的能力不对等,这是缺口本身.
   * 这里在 bun 侧补齐,让[走 bun]不再等于[放弃签名].
   *
   * 注册成功后把 keyId 记在 this.registeredKeyId,由入口回传给主服务落盘
   * (避免每次请求都重新注册).
   */
  async ensureKeyId() {
    if (this.cfg.keyId) return this.cfg.keyId;
    // 没有公钥就没有注册原料(主服务未生成密钥):保持"不签名"的原行为
    if (!this.cfg.publicKey) return null;
    if (this._registering) return this._registering;
    this._registering = (async () => {
      try {
        const r = await this.registerDeviceKey(this.cfg.publicKey);
        const kid = r?.body?.keyId || null;
        if (r?.status === 200 && kid) {
          this.cfg.keyId = kid;
          this.registeredKeyId = kid;
          return kid;
        }
        return null;
      } catch {
        return null;
      } finally {
        this._registering = null;
      }
    })();
    return this._registering;
  }

  /** 设备签名三头.没有 catalog 就不签(对齐官方 RequestIntegrity 行为). */
  async signHeaders(method, url, body, fetchId) {
    if (!this.cfg.privateKey) return {};
    // keyId 缺失时先惰性注册(Docker 全新卷上的首次运行就走这条路)
    if (!this.cfg.keyId && !(await this.ensureKeyId())) return {};
    const priv = await this.ensureKey();
    const ts = Date.now();
    const payload = devicePayload({
      method,
      path: new URL(url).pathname,
      timestampMs: ts,
      bodySha256: await sha256Hex(body),
      fetchId,
    });
    const sig = await crypto.subtle.sign('Ed25519', priv, new TextEncoder().encode(payload));
    return {
      'x-freebuff-device-key': this.cfg.keyId,
      'x-freebuff-device-ts': String(ts),
      'x-freebuff-device-sig': b64u(sig),
    };
  }

  auth() {
    return auth(this)
  }
  async fetchCatalog() {
    return fetchCatalog(this)
  }
  async registerDeviceKey(publicKey) {
    return registerDeviceKey(this, publicKey)
  }
  async getSession(opts = {}) {
    return getSession(this, opts)
  }
  async release(instanceId) {
    return release(this, instanceId)
  }
  async admit(row, opts = {}) {
    return admit(this, row, opts)
  }
  async startRun(agentId = null, opts = {}) {
    return startRun(this, agentId, opts)
  }
  async reuseChat(opts) {
    return reuseChat(this, opts)
  }
  async getStreak() {
    return getStreak(this)
  }
  async finishRun(runId, opts = {}) {
    return finishRun(this, runId, opts)
  }
  _traceFor(runId) {
    return _traceFor(this, runId)
  }
  _stepFor(runId) {
    return _stepFor(this, runId)
  }
  async chat(opts) {
    return chat(this, opts)
  }
}

/**
 * Bridge 实例的对外形状(createBridge 的返回类型).
 *
 */
export interface BridgeLike {
  cfg: any
  host: string
  fid: string | null
  catalog: any
  fetchCatalog(): Promise<any>
  registerDeviceKey(publicKey: any): Promise<any>
  getSession(opts?: any): Promise<any>
  release(instanceId: any): Promise<any>
  admit(row: any, opts?: any): Promise<any>
  startRun(agentId?: any, opts?: any): Promise<any>
  reuseChat(opts: any): Promise<any>
  finishRun(runId: any, opts?: any): Promise<any>
  chat(opts: any): Promise<any>
}

/**
 * 建一个绑到 cfg 的上游请求层.
 * @param {any} cfg 凭据与主机配置(token / apiHost / keyId / privateKey ...)
 * @returns {BridgeLike} 该 cfg 对应的桥接实例
 */
export function createBridge(cfg: any): BridgeLike {
  return new Bridge(cfg)
}
