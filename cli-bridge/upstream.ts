import { collectRepoSnapshot } from './lib/snapshot.ts'
import { renderManagerSystem, renderWorkerSystem } from './lib/system.ts'
import { dumpReq } from './lib/wire/dump.ts'
import { loadOfficialAssets } from './lib/assets.ts'
import { MAP_TOOLS, UNMAP_TOOLS, mergeOfficialTools, unmapToolCalls } from './lib/tool-map.ts'
import { b64u, sha256Hex, derFromB64u, devicePayload } from './lib/wire/crypto.ts'
import { auth, fetchCatalog, registerDeviceKey, getSession, release, admit, startRun, reuseChat, finishRun, chat, _traceFor, _stepFor } from './lib/endpoints.ts'
/**
 * upstream.ts — 在 bun 里执行的上游请求层.
 *
 * 为什么必须跑在 bun 里:TLS 指纹.
 * 官方客户端的 orchestrator 就是 bun 跑的(resources/bun/bun 1.4.2),
 * 用同一个运行时发请求,Client Hello 与官方同源 —— 这是对齐而不是伪装.
 * (实测 Node 52 ciphers / bun 17 ciphers,JA3 可区分,见
 *   ../freebuff-proxy/docs/reverse/11-tls-fingerprint.md)
 *
 * 协议件全部逐字对齐官方 orchestrator.js:
 *   设备签名 Ed25519 / catalog 协议 / base3-free-catalog /
 *   system 开场白 / 官方签名工具 / codebuff_metadata.run_id
 *
 * 用法:bun upstream.ts '<json>'
 * stdin 也可以传.输出一行 JSON.
 */

/**
 *  上游主机必须可注入,不能硬编码.
 *
 * 硬编码的后果(实测踩到):主服务把 api_base 指向本地镜像做对照验证时,
 * bun 侧仍直连真实 codebuff.com —— 于是"本地验证"变成了"真的打到上游",
 * 既验证不了,又白白发出请求.
 * 现在由调用方(cfg.apiHost)传入;缺省才回落到官方主机.
 */
const HOST = process.env.FREEBUFF_API_HOST || 'https://www.codebuff.com';

/**
 * 官方资产加载(抓包真值,见 docs/reverse/captures/).
 *
 * 我们不再自己编工具与 system —— 直接用抓到的官方原文:
 *   official-tools.json         37 个工具完整定义
 *   official-system-prompts.json 两层 system(manager / worker)
 *
 * 这是"照抄对齐"而非"推测":请求体形态与官方逐字段一致
 * (差异分析见 docs/reverse/14-captured-diff.md).
 */
/**
 * 逐字节 dump:把每个上游请求的原始形态落盘,供与官方客户端抓包逐字节对比.
 * FREEBUFF_DUMP_DIR 设置时启用.落盘内容 = 方法/路径/头部名值/体(Buffer hex + utf8).
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
   * 为什么必须有这一步(2026-10-04 Docker 部署事故):
   * 主服务的设备密钥是每个部署各自生成的(data/device-keys/<key>.json),
   * Docker 里 /data 是全新卷 → 密钥文件有,但 registrations 为空
   * (没注册过就没有 keyId).而 signHeaders() 见 keyId 为空直接返回 {},
   * session GET 于是不带设备签名发出.
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
   * bun 通道时根本不经过它 —— 两条通道的能力不对等,这是缺口本身.
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
  }  auth() {
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

// ---- CLI 入口 ----
const rawArgs = process.argv[2];
const input = rawArgs
  ? JSON.parse(rawArgs)
  : JSON.parse(await Bun.stdin.text());

const bridge = new Bridge(input.cfg);
const act = input.action;
const out = { action: act };

try {
  if (act !== 'catalog') await bridge.fetchCatalog();
  if (act === 'catalog') {
    out.catalog = await bridge.fetchCatalog();
  } else if (act === 'deviceKeys') {
    out.result = await bridge.registerDeviceKey(input.publicKey);
  } else if (act === 'session') {
    // instanceId / heartbeat 由主服务下发(官方的"持有心跳"形态)
    out.result = await bridge.getSession({
      instanceId: input.instanceId || null,
      heartbeat: input.heartbeat === true,
    });
  } else if (act === 'release') {
    out.result = await bridge.release(input.instanceId);
  } else if (act === 'admit') {
    const row = bridge.catalog.rows.find((r) => r.key === input.modelKey)
      || bridge.catalog.rows.find((r) => r.handle === input.modelKey)
      || bridge.catalog.rows[0];
    out.model = { key: row.key, name: row.displayName };
    out.result = await bridge.admit(row);
  } else if (act === 'startRun') {
    out.result = await bridge.startRun(input.agentId, { layer: input.layer || 'worker' });
  } else if (act === 'chat') {
    const row = bridge.catalog.rows.find((r) => r.key === input.modelKey)
      || bridge.catalog.rows.find((r) => r.handle === input.modelKey)
      || bridge.catalog.rows[0];
    out.model = { key: row.key, name: row.displayName };
    out.result = await bridge.chat({
      row,
      instanceId: input.instanceId,
      runId: input.runId,
      messages: input.messages,
      tools: input.tools,
      stream: input.stream,
    });
  } else if (act === 'reuse') {
    // 复用已有会话:只做 startRun + chat,绝不 admission
    const row = bridge.catalog.rows.find((r) => r.key === input.modelKey)
      || bridge.catalog.rows.find((r) => r.handle === input.modelKey)
      || bridge.catalog.rows[0];
    out.model = { key: row.key, name: row.displayName };
    const run = await bridge.startRun(input.agentId, { layer: input.layer || 'worker' });
    out.startRun = { status: run.status, runId: run.runId };
    if (!run.runId) {
      out.ok = false;
    } else {
      const c = await bridge.reuseChat({
        row, instanceId: input.instanceId, runId: run.runId,
        messages: input.messages, tools: input.tools, stream: input.stream,
      });
      out.chat = c;
      out.ok = c.status === 200;
    }
  } else if (act === 'dryrun') {
    // 只构造并 dump,不发送.用于与官方抓包做离线逐字段对比,零额度消耗.
    const row = bridge.catalog.rows.find((r) => r.key === input.modelKey)
      || bridge.catalog.rows.find((r) => r.handle === input.modelKey)
      || bridge.catalog.rows[0];
    const fakeInst = 'cli:dryrun-' + crypto.randomUUID();
    const fakeRun = 'dryrun-' + crypto.randomUUID();
    await bridge.chat({
      row, instanceId: fakeInst, runId: fakeRun,
      messages: input.messages || [{ role: 'user', content: 'x' }],
      tools: input.tools, layer: input.layer || 'worker',
      reasoningEffort: input.reasoningEffort || null,
      stream: input.stream !== false,
      noSend: true,
    }).catch(() => ({}));
    out.dryrun = { instanceId: fakeInst, runId: fakeRun, sent: false };
    out.ok = true;
  } else if (act === 'release') {
    out.result = await bridge.release(input.instanceId);
  } else if (act === 'full') {
    // 一次跑完:admit → startRun → chat(严格单次,不重试,不重建)
    const row = bridge.catalog.rows.find((r) => r.key === input.modelKey)
      || bridge.catalog.rows.find((r) => r.handle === input.modelKey)
      || bridge.catalog.rows[0];
    out.model = { key: row.key, name: row.displayName };
    const ad = await bridge.admit(row);
    out.admit = { status: ad.status, state: ad.body?.status, error: ad.body?.error };
    if (ad.body?.status !== 'active') {
      out.ok = false;
    } else {
      const inst = ad.body.instanceId || ad.instanceId;
      out.instanceId = inst;
      const run = await bridge.startRun(input.agentId, { layer: input.layer || 'worker' });
      out.startRun = { status: run.status, runId: run.runId };
      if (!run.runId) {
        out.ok = false;
      } else {
        //  参数名必须是 instanceId(chat 的解构键名).
        // 此前写成 inst,导致 x-freebuff-instance-id 缺失 →
        // 上游不知道请求属于哪个会话 → 428 waiting_room_required.
        const c = await bridge.chat({
          row, instanceId: inst, runId: run.runId,
          messages: input.messages, tools: input.tools,
          stream: input.stream !== false,
          layer: input.layer || 'worker',
          reasoningEffort: input.reasoningEffort || null,
        });
        out.chat = c;
        out.ok = c.status === 200;
        // FINISH 上报:官方每次 run 结束都发(line 32/65/74).
        // steps[].messageId 取流式响应的 chatcmpl-*.
        if (input.finishRun !== false) {
          const steps = c.messageId
            ? [{ id: c.messageId, stepNumber: 1, credits: 0,
                 childRunIds: [], messageId: c.messageId,
                 status: c.status === 200 ? 'completed' : 'failed',
                 startTime: new Date().toISOString() }]
            : [];
          out.finishRun = await bridge.finishRun(run.runId, {
            status: c.status === 200 ? 'completed' : 'failed',
            steps,
          });
        }
      }
    }
  } else {
    out.error = `unknown action: ${act}`;
  }
} catch (e) {
  out.error = String(e?.message || e);
  out.ok = false;
}

process.stdout.write(JSON.stringify(out) + '\n');
