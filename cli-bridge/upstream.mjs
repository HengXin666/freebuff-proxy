/**
 * upstream.mjs — 在 bun 里执行的上游请求层。
 *
 * 为什么必须跑在 bun 里：TLS 指纹。
 * 官方客户端的 orchestrator 就是 bun 跑的（resources/bun/bun 1.4.2），
 * 用同一个运行时发请求，Client Hello 与官方同源 —— 这是**对齐**而不是伪装。
 * （实测 Node 52 ciphers / bun 17 ciphers，JA3 可区分，见
 *   ../freebuff-proxy/docs/reverse/11-tls-fingerprint.md）
 *
 * 协议件全部逐字对齐官方 orchestrator.js：
 *   设备签名 Ed25519 / catalog 协议 / base3-free-catalog /
 *   system 开场白 / 官方签名工具 / codebuff_metadata.run_id
 *
 * 用法：bun upstream.mjs '<json>'
 * stdin 也可以传。输出一行 JSON。
 */

const HOST = 'https://www.codebuff.com';

/**
 * 逐字节 dump：把每个上游请求的原始形态落盘，供与官方客户端抓包逐字节对比。
 * FREEBUFF_DUMP_DIR 设置时启用。落盘内容 = 方法/路径/头部名值/体（Buffer hex + utf8）。
 */
const DUMP_DIR = process.env.FREEBUFF_DUMP_DIR || '';
let dumpSeq = 0;
async function dumpReq(label, method, url, headers, body) {
  if (!DUMP_DIR) return;
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(DUMP_DIR, { recursive: true });
  const n = String(++dumpSeq).padStart(3, '0');
  const bodyBuf = body == null ? Buffer.alloc(0) : Buffer.from(String(body), 'utf8');
  const headLines = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .sort();
  const rec = {
    n, label, method, url,
    path: new URL(url).pathname,
    headers: Object.fromEntries(
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
    ),
    headerLinesSorted: headLines,
    bodyBytes: bodyBuf.length,
    bodyUtf8: bodyBuf.toString('utf8'),
    bodyHex: bodyBuf.toString('hex'),
  };
  await writeFile(`${DUMP_DIR}/${n}-${label}.json`, JSON.stringify(rec, null, 2));
}

// ---- base64url / sha256（官方同款：complete hex，空 body = sha256("")）----
function b64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Hex(body) {
  const data = body == null ? new Uint8Array(0) : new TextEncoder().encode(String(body));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function derFromB64u(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 官方 freebuffDeviceSignaturePayload：6 行，\n 分隔，缺一不可。 */
function devicePayload({ method, path, timestampMs, bodySha256, fetchId }) {
  return [
    'freebuff-device-v1',
    String(method).toUpperCase(),
    path,
    String(timestampMs),
    bodySha256,
    fetchId ?? '',
  ].join('\n');
}

class Bridge {
  constructor(cfg) {
    this.cfg = cfg;
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

  /** 设备签名三头。没有 catalog 就不签（对齐官方 RequestIntegrity 行为）。 */
  async signHeaders(method, url, body, fetchId) {
    if (!this.cfg.keyId || !this.cfg.privateKey) return {};
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
    return { Authorization: `Bearer ${this.cfg.token}` };
  }

  async fetchCatalog() {
    const url = `${HOST}/api/v1/freebuff/models`;
    const h1 = {
      ...this.auth(),
      'x-freebuff-catalog-protocol': '1',
      ...(await this.signHeaders('GET', url, null, null)),
    };
    await dumpReq('catalog', 'GET', url, h1, null);
    const res = await fetch(url, { headers: h1 });
    if (!res.ok) throw new Error(`catalog ${res.status}: ${(await res.text()).slice(0, 200)}`);
    this.catalog = await res.json();
    this.fid = this.catalog.fetchId;
    return this.catalog;
  }

  async getSession() {
    const url = `${HOST}/api/v1/freebuff/session`;
    const res = await fetch(url, {
      headers: {
        ...this.auth(),
        'x-freebuff-catalog-protocol': '1',
        ...(this.fid ? { 'x-freebuff-catalog-fetch': this.fid } : {}),
        'x-freebuff-client': 'desktop',
        'x-freebuff-install-id': this.cfg.installId,
        'x-freebuff-first-tab-discount': '0',
        'x-freebuff-multi-session': '1',
        'x-freebuff-include-unused-rate-limits': '1',
        ...(await this.signHeaders('GET', url, null, this.fid)),
      },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** 释放会话：DELETE /api/v1/freebuff/session（带 instance-id）。 */
  async release(instanceId) {
    const url = `${HOST}/api/v1/freebuff/session`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        ...this.auth(),
        'x-freebuff-catalog-protocol': '1',
        ...(this.fid ? { 'x-freebuff-catalog-fetch': this.fid } : {}),
        'x-freebuff-instance-id': instanceId,
        'x-freebuff-multi-session': '1',
        'x-freebuff-purchase-continuity': '1',
        ...(await this.signHeaders('DELETE', url, null, this.fid)),
      },
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text: text.slice(0, 300) };
  }

  /**
   * admission：x-freebuff-model 必须传 handle（fbm1.xxx），不是 key。
   *
   * purchase_capacity = 该账号付费槽位瞬时排队（AGENTS.md：slotLimit 1，
   * 回执带 currentInstanceId/nextExpiryAt）。它是**可重试**的，
   * 不是账号故障 —— 实测重试即 200 active。这里按 0/4/8s 退避重试。
   */
  /**
   * 接管槽位：撞 purchase_capacity 时用官方的
   * x-freebuff-takeover-instance-id 显式接管回执给出的 currentInstanceId。
   * 官方源码 FREEBUFF_TAKEOVER_INSTANCE_HEADER（orchestrator.js:135252）。
   */
  async admit(row, { retries = 4, takeoverInstanceId = null } = {}) {
    const url = `${HOST}/api/v1/freebuff/session/admission`;
    const inst = this.cfg.instanceId || `cli:${crypto.randomUUID()}`;
    let last = null;
    for (let i = 0; i <= retries; i++) {
      const hdrs = {
          ...this.auth(),
          'x-freebuff-catalog-protocol': '1',
          'x-freebuff-catalog-fetch': this.fid,
          'x-freebuff-client': 'desktop',
          'x-freebuff-install-id': this.cfg.installId,
          'x-freebuff-model': row.handle,
          'x-freebuff-wallet-spend-limit': '0',
          'x-freebuff-first-tab-discount': '0',
          'x-freebuff-instance-id': inst,
          'x-freebuff-purchase-continuity': '1',
          'x-freebuff-multi-session': '1',
          ...(takeoverInstanceId
            ? { 'x-freebuff-takeover-instance-id': takeoverInstanceId }
            : {}),
          ...(await this.signHeaders('POST', url, null, this.fid)),
        };
      await dumpReq(`admit-${i}`, 'POST', url, hdrs, null);
      const res = await fetch(url, { method: 'POST', headers: hdrs });
      const body = await res.json().catch(() => null);
      last = { status: res.status, body, instanceId: inst, attempt: i };
      if (body?.status === 'active') return last;
      // 首次撞到槽位占用：用回执给出的持有者 id 接管重试一次
      if (!takeoverInstanceId && body?.currentInstanceId
          && (body?.status === 'purchase_capacity' || body?.error === 'purchase_capacity')) {
        return this.admit(row, { retries, takeoverInstanceId: body.currentInstanceId });
      }
      // 只有瞬时排队才重试；banned / catalog_stale 等立即返回
      const transient =
        body?.error === 'purchase_capacity' || body?.status === 'purchase_capacity';
      if (!transient) return last;
      if (i < retries) await new Promise((r) => setTimeout(r, 4000 * (i + 1)));
    }
    return last;
  }

  async startRun(agentId = 'base3-free-catalog') {
    const url = `${HOST}/api/v1/agent-runs`;
    const payload = JSON.stringify({ action: 'START', agentId, ancestorRunIds: [] });
    const hdrs = {
      'content-type': 'application/json',
      ...this.auth(),
      'x-codebuff-api-key': this.cfg.token,
      'x-freebuff-catalog-protocol': '1',
      ...(this.fid ? { 'x-freebuff-catalog-fetch': this.fid } : {}),
      ...(await this.signHeaders('POST', url, payload, this.fid)),
    };
    await dumpReq('startRun', 'POST', url, hdrs, payload);
    const res = await fetch(url, { method: 'POST', headers: hdrs, body: payload });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, runId: body?.runId ?? null };
  }

  /** chat：model 用 handle；run_id 在 codebuff_metadata 里。 */
  async chat({ row, instanceId, runId, messages, tools, stream = false }) {
    const url = `${HOST}/api/v1/chat/completions`;
    const body = JSON.stringify({
      model: row.handle,
      messages,
      stream,
      codebuff_metadata: {
        run_id: runId,
        client_id: Math.random().toString(36).slice(2, 15),
        cost_mode: 'free',
        freebuff_instance_id: instanceId,
        freebuff_multi_session: '1',
        // ⚠️ 必须与 x-freebuff-client 一致：header 是 desktop，
        // metadata 里写 cli 会自相矛盾（"同身份"原则，见 docs/reverse/04）。
        surface: 'desktop',
        trace_session_id: crypto.randomUUID(),
        freebuff_client_env:
          'v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=1;p=shell;g=terminal;osc=1',
      },
      tools,
    });
    const hdrs = {
      'content-type': 'application/json',
      ...this.auth(),
      'user-agent': 'ai-sdk/openai-compatible/0.0.0-test/codebuff',
      'x-freebuff-acting-user-id': this.cfg.userId,
      'x-freebuff-catalog-protocol': '1',
      'x-freebuff-catalog-fetch': this.fid,
      'x-freebuff-model': row.handle,
      'x-freebuff-instance-id': instanceId,
      'x-freebuff-client': 'desktop',
      'x-freebuff-install-id': this.cfg.installId,
      ...(await this.signHeaders('POST', url, body, this.fid)),
    };
    await dumpReq('chat', 'POST', url, hdrs, body);
    const res = await fetch(url, { method: 'POST', headers: hdrs, body });
    const text = await res.text();
    return { status: res.status, text };
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
  } else if (act === 'session') {
    out.result = await bridge.getSession();
  } else if (act === 'admit') {
    const row = bridge.catalog.rows.find((r) => r.key === input.modelKey)
      || bridge.catalog.rows.find((r) => r.handle === input.modelKey)
      || bridge.catalog.rows[0];
    out.model = { key: row.key, name: row.displayName };
    out.result = await bridge.admit(row);
  } else if (act === 'startRun') {
    out.result = await bridge.startRun(input.agentId);
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
  } else if (act === 'release') {
    out.result = await bridge.release(input.instanceId);
  } else if (act === 'full') {
    // 一次跑完：admit → startRun → chat（严格单次，不重试、不重建）
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
      const run = await bridge.startRun(input.agentId);
      out.startRun = { status: run.status, runId: run.runId };
      if (!run.runId) {
        out.ok = false;
      } else {
        const c = await bridge.chat({
          row, inst, runId: run.runId,
          messages: input.messages, tools: input.tools, stream: input.stream,
        });
        out.chat = c;
        out.ok = c.status === 200;
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
