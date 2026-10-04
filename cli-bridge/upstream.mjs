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

/**
 * ⚠️ 上游主机**必须可注入**，不能硬编码。
 *
 * 硬编码的后果（实测踩到）：主服务把 api_base 指向本地镜像做对照验证时，
 * bun 侧仍直连真实 codebuff.com —— 于是"本地验证"变成了"真的打到上游"，
 * 既验证不了，又白白发出请求。
 * 现在由调用方（cfg.apiHost）传入；缺省才回落到官方主机。
 */
const HOST = process.env.FREEBUFF_API_HOST || 'https://www.codebuff.com';

/**
 * 官方资产加载（抓包真值，见 docs/reverse/captures/）。
 *
 * 我们不再自己编工具与 system —— 直接用抓到的官方原文：
 *   official-tools.json         37 个工具完整定义
 *   official-system-prompts.json 两层 system（manager / worker）
 *
 * 这是"照抄对齐"而非"推测"：请求体形态与官方逐字段一致
 * （差异分析见 docs/reverse/14-captured-diff.md）。
 */
let OFFICIAL_TOOLS = null;
let OFFICIAL_DECIDE = null;
let OFFICIAL_SYS = null;
async function loadOfficialAssets() {
  if (OFFICIAL_TOOLS && OFFICIAL_SYS) return { OFFICIAL_TOOLS, OFFICIAL_DECIDE, OFFICIAL_SYS };
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  // 本文件在 freebuff-proxy/cli-bridge/，抓包在 ../docs/reverse/captures/
  const here = dirname(process.argv[1] || '');
  const capDir = join(here, '..', 'docs', 'reverse', 'captures');
  try {
    OFFICIAL_TOOLS = JSON.parse(await readFile(join(capDir, 'official-tools.json'), 'utf8'));
    OFFICIAL_SYS = JSON.parse(await readFile(join(capDir, 'official-system-prompts.json'), 'utf8'));
    try {
      OFFICIAL_DECIDE = JSON.parse(await readFile(join(capDir, 'official-tool-decide.json'), 'utf8'));
    } catch {
      OFFICIAL_DECIDE = null;
    }
  } catch {
    OFFICIAL_TOOLS = [];
    OFFICIAL_DECIDE = null;
    OFFICIAL_SYS = {};
  }
  return { OFFICIAL_TOOLS, OFFICIAL_DECIDE, OFFICIAL_SYS };
}

/**
 * 采集 repo_snapshot（worker 层用真实项目统计，manager 层全 0）。
 *
 * 官方分层取值：line 14（manager）fileCount 0；
 * line 38（worker）fileCount 69、testFileCount 5。
 * 我们此前统一硬编码 0 —— worker 层会成为不一致点。
 *
 * 只做**轻量**统计：受 .gitignore 影响的文件不逐个读内容，
 * 仅统计数量并识别测试文件，超时/失败即回落到全 0。
 */
async function collectRepoSnapshot(dir) {
  const zero = {
    gitAvailable: false,
    repositoryVisibility: 'unknown',
    fileCount: 0,
    fileCountIsLowerBound: false,
    testFileCount: 0,
    changedFileCount: 0,
    changedFileScanTruncated: false,
  };
  if (!dir) return zero;
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const { join, extname, basename } = await import('node:path');
    const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next',
      '.cache', 'coverage', '.venv', '__pycache__', '.mypy_cache']);
    const TEST_RE = /(^|[._-])(test|spec|tests|specs)([._-]|$)|\.(test|spec)\./i;
    let fileCount = 0, testFileCount = 0, truncated = false;
    const queue = [dir];
    let visited = 0;
    while (queue.length && visited < 20000) {
      const cur = queue.pop();
      let entries = [];
      try { entries = await readdir(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.') {
          if (SKIP.has(e.name)) continue;
        }
        const p = join(cur, e.name);
        if (e.isDirectory()) {
          if (SKIP.has(e.name)) continue;
          if (queue.length < 4000) queue.push(p); else truncated = true;
          continue;
        }
        if (!e.isFile()) continue;
        visited++;
        fileCount++;
        if (TEST_RE.test(e.name)) testFileCount++;
        if (visited >= 20000) { truncated = true; break; }
      }
    }
    let gitAvailable = false;
    try { await stat(join(dir, '.git')); gitAvailable = true; } catch {}
    return {
      gitAvailable,
      repositoryVisibility: 'unknown',
      fileCount,
      fileCountIsLowerBound: truncated,
      testFileCount,
      changedFileCount: 0,
      changedFileScanTruncated: false,
    };
  } catch {
    return zero;
  }
}

/**
 * manager 层 system 的 mission 段是**动态的**：抓包提取的模板里嵌着
 * 当时那条用户消息（USER_TURN_MARKER: create file /tmp/user-turn-proof.txt...）。
 * 原样发出等于每次都告诉上游"我要建这个文件" —— 必须按当前请求替换。
 *
 * 模板尾部形态（抓包 line 14）：
 *   ...固定前缀...

{mission}

Call the `decide` tool exactly once. ...
 *
 * @param {string} tpl manager 模板
 * @param {string} mission 当前用户消息
 */
function renderManagerSystem(tpl, mission) {
  let out = String(tpl || '');
  // 替换 "Call the `decide` tool" 之前、最后一个空行之后的整段为当前 mission
  const anchor = '\n\nCall the `decide` tool';
  const ai = out.lastIndexOf(anchor);
  if (ai > 0) {
    // 找 anchor 之前最后一个空行，作为 mission 起点
    const head = out.slice(0, ai);
    const cut = head.lastIndexOf('\n\n');
    if (cut > 0) {
      out = head.slice(0, cut) + '\n\n' + String(mission || '') + out.slice(ai);
    }
  }
  return out;
}

/**
 * 生成 worker 层 system（官方模板 + 动态区块填充）。
 *
 * 官方模板含两个动态区块 <repository_stats> / <changed_file_paths>，
 * 以及一句 "Current date: ..."。直接发模板而不填会成为新的不一致，
 * 所以这里做最小填充（无 git 信息时给空/unknown，与官方 unknown 语义一致）。
 */
function renderWorkerSystem(tpl, opts = {}) {
  const date = opts.date
    || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  let out = String(tpl || '');
  out = out.replace(/Current date: [^\n]*/, `Current date: ${date}.`);
  const stats = opts.repositoryStats
    || JSON.stringify({
      gitAvailable: false,
      repositoryVisibility: 'unknown',
      fileCount: 0,
      fileCountIsLowerBound: false,
      testFileCount: 0,
      changedFileCount: 0,
      changedFileScanTruncated: false,
    });
  out = out.replace('<repository_stats>', stats);
  out = out.replace('<changed_file_paths>', opts.changedFilePaths || '');
  return out;
}

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

/**
 * 客户端工具名 → 官方工具名的**映射表**（下行方向）。
 *
 * ⚠️ 为什么必须映射而不是直接追加（2026-10-04 定性）：
 * 上游的官方工具集是**固定 37 个**（`docs/reverse/captures/official-tools.json`），
 * 里面**没有** `bash` / `edit` / `read` / `write` / `skill` 这些下游 harness 的
 * 常用名。实测（远程 15:02）把 55 个第三方工具**原样追加**后，上游回
 * `503 {"message":"The model is temporarily unavailable."}` —— 而同会话、
 * 同模型、不带工具时是 200。唯一变量就是工具集。
 *
 * 所以：**能映射的映射到官方等价物**（模型看到的是官方名字，调用的也是官方
 * 语义），映射不了的**丢弃**（宁可让该工具在此链路不可用，也不能让整条链路
 * 因一个陌生工具名被拒）。
 *
 * 反向映射（上行）见 `UNMAP_TOOLS` —— 上游回 `tool_calls` 时把官方名还原成
 * 下游认识的名字，这样两边的模型/客户端都看到自己那套名字。
 */
const MAP_TOOLS = Object.freeze({
  bash: 'run_terminal_command',
  shell: 'run_terminal_command',
  sh: 'run_terminal_command',
  run_command: 'run_terminal_command',
  execute_command: 'run_terminal_command',
  terminal: 'run_terminal_command',
  edit: 'str_replace',
  apply_patch: 'str_replace',
  str_replace: 'str_replace',
  write: 'write_file',
  create_file: 'write_file',
  write_file: 'write_file',
  read: 'read_files',
  cat: 'read_files',
  read_file: 'read_files',
  read_files: 'read_files',
  grep: 'code_search',
  code_search: 'code_search',
  find: 'code_search',
  glob: 'glob',
  ls: 'list_directory',
  list_dir: 'list_directory',
  list_directory: 'list_directory',
  web_fetch: 'read_url',
  fetch: 'read_url',
  curl: 'read_url',
  read_url: 'read_url',
  web_search: 'web_search',
  search: 'web_search',
  todo_write: 'write_todos',
  write_todos: 'write_todos',
  ask_user_question: 'ask_questions',
  ask_questions: 'ask_questions',
  browser_check: 'browser_check',
})

/**
 * 官方工具名 → 客户端熟悉的名字（**上行**方向，用于还原 `tool_calls`）。
 *
 * 只对"我们做过下行映射"的名字建立反向关系 —— 官方原生名（如 `preview_click`）
 * 没有下游对应物，保持原名返回，下游按原样收到即可。
 */
const UNMAP_TOOLS = Object.freeze(
  Object.entries(MAP_TOOLS).reduce((acc, [client, official]) => {
    // 一个官方名可能对应多个客户端名：取**第一个**（表内顺序即优先级），
    // 保证还原是确定的（不能随对象键序漂移）。
    if (!acc[official]) acc[official] = client
    return acc
  }, {}),
)

/**
 * 官方工具集 + **映射后**的客户端工具，按 function.name 去重（官方优先）。
 *
 * 与旧版（直接追加）的区别（这是本次修复的核心）：
 *   - 客户端工具先经 `MAP_TOOLS` 换成官方等价名 → 上游只看到官方名字；
 *   - 映射不到的**丢弃**（旧版直接追加 → 上游看到陌生名 → 503）；
 *   - 去重仍在（客户端声明了官方已有的名字时以官方定义为准）。
 *
 * @param {any[]} official 官方工具定义
 * @param {any[]} clientTools 下游声明的工具
 * @param {Record<string,string>} [dropped] 出参：被丢弃的客户端工具名（供日志）
 */
function mergeOfficialTools(official, clientTools, dropped = {}) {
  const list = Array.isArray(official) ? [...official] : [];
  if (!Array.isArray(clientTools) || clientTools.length === 0) return list;
  const seen = new Set(list.map((t) => t?.function?.name).filter(Boolean));
  for (const t of clientTools) {
    const n = t?.function?.name;
    if (!n) continue;
    const mapped = MAP_TOOLS[n] || null;
    if (!mapped) {
      // 官方没有等价物 → 丢弃（附理由给调用方记日志），绝不原样发出
      dropped[n] = 'no-official-equivalent';
      continue;
    }
    if (seen.has(mapped)) continue; // 官方优先，重复不追加
    seen.add(mapped);
    list.push({
      ...t,
      function: { ...t.function, name: mapped },
    });
  }
  return list;
}

/**
 * 把上游 `tool_calls` 里的官方工具名**还原**成下游认识的名字。
 *
 * 与 `mergeOfficialTools`（下行映射）配对：下行把 `bash`→`run_terminal_command`，
 * 上行就把 `run_terminal_command`→`bash`，这样下游拿到的工具名与它自己声明的
 * 一致，可以直接派发。
 *
 * 官方原生名（下游从没声明过）原样返回 —— 不猜、不丢。
 *
 * @param {any} body 上游 chat 响应体（含 choices[].message.tool_calls）
 * @param {Record<string,string>} [unmappedNames] 本次请求用过的下行映射（客户端名→官方名）
 */
function unmapToolCalls(body, unmappedNames = {}) {
  if (!body || typeof body !== 'object') return body
  const choices = Array.isArray(body.choices) ? body.choices : []
  // 本次请求里**客户端实际声明过**的官方名 → 还原回客户端名。
  // 优先用调用方给的精确表（同一官方名可能被多个客户端名映射到，
  // 只有本次声明过的那个才是正确的还原目标）。
  const back = {}
  for (const [client, official] of Object.entries(unmappedNames || {})) {
    if (!back[official]) back[official] = client
  }
  for (const ch of choices) {
    const tc = ch?.message?.tool_calls
    if (!Array.isArray(tc)) continue
    for (const call of tc) {
      const officialName = call?.function?.name
      if (!officialName) continue
      const clientName = back[officialName] || UNMAP_TOOLS[officialName]
      if (clientName) call.function.name = clientName
    }
  }
  return body
}

class Bridge {
  constructor(cfg) {
    this.cfg = cfg;
    /**
     * 每个实例按 cfg.apiHost 解析主机（不共享模块级常量）。
     * 硬编码会让"本地镜像对照"变成"真的打到上游"。
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
   * 确保拿到 keyId：**没有就自己注册一个**（惰性注册）。
   *
   * 为什么必须有这一步（2026-10-04 Docker 部署事故）：
   * 主服务的设备密钥是**每个部署各自生成**的（data/device-keys/<key>.json），
   * Docker 里 /data 是全新卷 → **密钥文件有、但 registrations 为空**
   * （没注册过就没有 keyId）。而 `signHeaders()` 见 keyId 为空直接返回 {}，
   * session GET 于是**不带设备签名**发出。
   *
   * 抓包真值（docs/reverse/21 §21.2）：全 165 条里**只有
   * /api/v1/freebuff/session 带签名**（13 次）。也就是说我们恰好在唯一
   * 的必签端点上裸奔 → 上游按未注册设备拒 → 401 → 控制台显示
   * 「凭证失效」，而 token 本身完全有效。
   *
   * 「本地能通、远程不通」的全部差异就在这里：本地那份注册过了
   * （keyId 已落盘），远程那份没有。
   *
   * 主服务侧的 Node 路径（DeviceSigner）本来就有惰性注册，但 session 走
   * bun 通道时**根本不经过它** —— 两条通道的能力不对等，这是缺口本身。
   * 这里在 bun 侧补齐，让「走 bun」不再等于「放弃签名」。
   *
   * 注册成功后把 keyId 记在 `this.registeredKeyId`，由入口回传给主服务落盘
   * （避免每次请求都重新注册）。
   */
  async ensureKeyId() {
    if (this.cfg.keyId) return this.cfg.keyId;
    // 没有公钥就没有注册原料（主服务未生成密钥）：保持"不签名"的原行为
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

  /** 设备签名三头。没有 catalog 就不签（对齐官方 RequestIntegrity 行为）。 */
  async signHeaders(method, url, body, fetchId) {
    if (!this.cfg.privateKey) return {};
    // keyId 缺失时先惰性注册（Docker 全新卷上的首次运行就走这条路）
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
    return { Authorization: `Bearer ${this.cfg.token}` };
  }

  async fetchCatalog() {
    const url = `${this.host}/api/v1/freebuff/models`;
    /**
     * ⚠️ 头集逐字对齐官方抓包（165 条里 catalog 那 1 条原样）：
     *
     *   Authorization: Bearer <token>
     *   x-freebuff-catalog-protocol: 1
     *   x-freebuff-client: desktop
     *   User-Agent: Bun/1.4.2      ← bun 裸 fetch 的默认 UA，天然一致
     *   Accept: * / *               ← bun 默认，天然一致
     *
     * 两处修正（见 docs/reverse/19 §19.10）：
     *   - 补 `x-freebuff-client: desktop`（此前缺）；
     *   - **去掉设备签名**：官方这一跳不签（只有 session 才签），
     *     带了会让目录行数从 13 变成 53 —— 那是形态偏离换来的另一份响应。
     *
     * bun 不会像 Node 那样自动加 accept-language / sec-fetch-mode，
     * 所以这一跳在 bun 上与客户端**完全一致**。
     */
    const h1 = {
      ...this.auth(),
      'x-freebuff-catalog-protocol': '1',
      'x-freebuff-client': 'desktop',
    };
    await dumpReq('catalog', 'GET', url, h1, null);
    const res = await fetch(url, { headers: h1 });
    if (!res.ok) throw new Error(`catalog ${res.status}: ${(await res.text()).slice(0, 200)}`);
    this.catalog = await res.json();
    this.fid = this.catalog.fetchId;
    return this.catalog;
  }

  /**
   * 注册设备公钥 → 拿 keyId（**签名前置**，无 keyId 则后续请求无法签名）。
   *
   * 头集逐字对齐抓包真值（docs/reverse/21 §21.3）：
   *   Authorization: Bearer <token>
   *   Content-Type: application/json
   *   User-Agent / Accept / Accept-Encoding 由 bun 裸 fetch 提供（Bun/1.4.2）
   * body: {"publicKey":"<base64url raw Ed25519 32B>","client":"desktop"}
   * ⚠️ 不带 x-codebuff-api-key、不带设备签名（这一跳还没有 keyId）。
   */
  async registerDeviceKey(publicKey) {
    const url = `${this.host}/api/v1/freebuff/device-keys`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.auth(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publicKey, client: 'desktop' }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  /**
   * GET /api/v1/freebuff/session
   *
   * ⚠️ **必须支持"持有心跳"形态**（2026-10-04，逆向官方 0.0.158 后补）。
   *
   * 官方真值（`orchestrator.js:207945-207957` 的 `getSession`）：
   *
   *   getSession(auth, instanceId, heartbeat) {
   *     headers: {
   *       Authorization,
   *       ...catalogHeaders,
   *       ...(!heartbeat ? freebucksTimeZoneHeaders() : {}),   // 心跳不带时区
   *       [x-freebuff-client]: desktop,
   *       ...installIdHeaders(),
   *       [first-tab-discount]: "0",
   *       [multi-session]: "1",
   *       ...(instanceId ? { [instance-id]: instanceId } : {}),  // ★ 必带
   *       [heartbeat ? x-freebuff-heartbeat : include-unused-rate-limits]: "1",
   *     }
   *   }
   *
   * 而官方在 **admission 成功后立刻发一次**这形态的 GET，之后每 45 秒一次
   * （`orchestrator.js:208918-208957` 的 syncHeartbeatTimer；常量
   * `FREEBUFF_SESSION_HEARTBEAT_INTERVAL_MS = 45000`）。
   *
   * 我们此前**一次都没发过**：`makeSessionViaBun()` 返回的函数不收参数，
   * `opts.instanceId` 在 GET 路径被静默丢弃，bun 侧也不构造这两个头。
   * 后果与真实事故吻合：用户日志里 admission（11:25:16）之后 **25 秒**
   * 就被上游退款（11:25:41 `session_superseded` + "purchase was refunded"），
   * 而官方首个心跳窗口 ≤20.5 秒（抓包 line 8 → line 17）。
   *
   * @param {{ instanceId?: string | null, heartbeat?: boolean }} [opts]
   */
  async getSession(opts = {}) {
    const instanceId = opts.instanceId || null
    const heartbeat = opts.heartbeat === true
    const url = `${this.host}/api/v1/freebuff/session`;
    const res = await fetch(url, {
      headers: {
        ...this.auth(),
        'x-freebuff-catalog-protocol': '1',
        ...(this.fid ? { 'x-freebuff-catalog-fetch': this.fid } : {}),
        'x-freebuff-client': 'desktop',
        // 官方：**心跳不带时区**（`...!heartbeat ? freebucksTimeZoneHeaders() : {}`）。
        // 非心跳形态仍带（docs/reverse/21 §21.3 真值）。
        ...(heartbeat
          ? {}
          : {
              'x-fb-timezone':
                this.cfg.timeZone ||
                (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
            }),
        // ⚠️ 不要发字面量 'null'：主服务没传 installId 时整个头应省略
        ...(this.cfg.installId ? { 'x-freebuff-install-id': this.cfg.installId } : {}),
        'x-freebuff-first-tab-discount': '0',
        'x-freebuff-multi-session': '1',
        // ★ 实例标识：官方只有"带 instanceId"这一种 GET 形态
        ...(instanceId ? { 'x-freebuff-instance-id': instanceId } : {}),
        // 二选一（官方三元）：心跳用 -heartbeat，普通查询用 -include-unused-rate-limits
        ...(heartbeat
          ? { 'x-freebuff-heartbeat': '1' }
          : { 'x-freebuff-include-unused-rate-limits': '1' }),
        ...(await this.signHeaders('GET', url, null, this.fid)),
      },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** 释放会话：DELETE /api/v1/freebuff/session（带 instance-id）。 */
  async release(instanceId) {
    const url = `${this.host}/api/v1/freebuff/session`;
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
    const url = `${this.host}/api/v1/freebuff/session/admission`;
    // ⚠️ 官方是**裸 UUID**且**整场复用**（抓包 line 8/34/54 三次 admission
    // 同为 e1be7199-...，line 38 metadata 也是它）。我们此前用 `cli:<uuid>`
    // 且每次新建 —— review 指出这可能就是"购买全额退款作废"的诱因：
    // 官方回执里 desktopRefunds 从未出现，我们每次都退。
    // 见 docs/reverse/15-protocol-review.md E.1
    if (!this.instanceId) {
      this.instanceId = this.cfg.instanceId || crypto.randomUUID();
    }
    const inst = this.instanceId;
    let last = null;
    for (let i = 0; i <= retries; i++) {
      const hdrs = {
          ...this.auth(),
          'x-freebuff-catalog-protocol': '1',
          'x-freebuff-catalog-fetch': this.fid,
          'x-freebuff-client': 'desktop',
          // ⚠️ 不要发字面量 'null'：主服务没传 installId 时整个头应省略
        ...(this.cfg.installId ? { 'x-freebuff-install-id': this.cfg.installId } : {}),
          'x-freebuff-model': row.handle,
          'x-freebuff-wallet-spend-limit': '0',
          'x-freebuff-first-tab-discount': '0',
          // ⚠️ 官方 admission 有而我们此前缺失的两个头（抓包真值）：
          //   x-fb-timezone: Asia/Shanghai
          //   x-freebuff-desktop-attempt-id: <uuid>
          'x-fb-timezone': this.cfg.timeZone
            || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
          'x-freebuff-desktop-attempt-id': crypto.randomUUID(),
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
      // 槽位占用（capacity=排队 / in_use=正被持有着用）：两者都是瞬时的
      const transient =
        body?.status === 'purchase_capacity' || body?.error === 'purchase_capacity'
        || body?.status === 'purchase_in_use' || body?.error === 'purchase_in_use';
      if (!transient) return last;
      // 首次撞到占用：用回执给出的持有者 id 接管重试一次
      if (!takeoverInstanceId && body?.currentInstanceId) {
        return this.admit(row, { retries, takeoverInstanceId: body.currentInstanceId });
      }
      if (i < retries) await new Promise((r) => setTimeout(r, 4000 * (i + 1)));
    }
    return last;
  }

  /**
   * agent-runs 的 agentId 按层用 **desktop 世代**（抓包真值）：
   *   manager → freebuff-desktop-autorun        (line 11/58)
   *   worker  → freebuff-desktop-thread-local-v3 (line 36)
   * 我们此前用 CLI 世代的 base3-free-catalog —— 世代错配。
   */
  async startRun(agentId = null, layer = 'worker') {
    agentId = agentId
      || (layer === 'manager'
        ? 'freebuff-desktop-autorun'
        : 'freebuff-desktop-thread-local-v3');
    const url = `${this.host}/api/v1/agent-runs`;
    const payload = JSON.stringify({ action: 'START', agentId, ancestorRunIds: [] });
    // ⚠️ 官方 agent-runs 只有 3 个业务头（line 11/58）：
    //   content-type / authorization / x-freebuff-acting-user-id
    // 不带 x-codebuff-api-key（全抓包 0 次）、不带 catalog 头、不带设备签名。
    const hdrs = {
      'content-type': 'application/json',
      ...this.auth(),
      'x-freebuff-acting-user-id': this.cfg.userId,
    };
    await dumpReq('startRun', 'POST', url, hdrs, payload);
    const res = await fetch(url, { method: 'POST', headers: hdrs, body: payload });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, runId: body?.runId ?? null };
  }

  /**
   * 复用一个**已存在的会话**发 chat：不建会话、不扣费。
   *
   * 用途：把「建会话」与「说话」两个环节分开定位 ——
   * 若复用客户端已建成的会话能拿到 200，则问题出在 admission；
   * 若仍 428/503，则问题出在 chat 请求本身。
   */
  async reuseChat({ row, instanceId, runId, messages, tools, stream = false }) {
    return this.chat({ row, instanceId, runId, messages, tools, stream });
  }

  /**
   * FINISH 上报：run 结束时告诉上游。
   *
   * 官方每次 run 结束都发（line 32 / 65 / 74），带 steps[].messageId
   * （取自流式响应的 chatcmpl-*）。我们此前**从不发** —— run 悬挂。
   */
  async finishRun(runId, { status = 'completed', steps = [] } = {}) {
    const url = `${this.host}/api/v1/agent-runs`;
    const payload = JSON.stringify({
      action: 'FINISH',
      runId,
      status,
      totalSteps: steps.length,
      directCredits: 0,
      totalCredits: 0,
      steps,
    });
    const hdrs = {
      'content-type': 'application/json',
      ...this.auth(),
      'x-freebuff-acting-user-id': this.cfg.userId,
    };
    await dumpReq('finishRun', 'POST', url, hdrs, payload);
    const res = await fetch(url, { method: 'POST', headers: hdrs, body: payload });
    const text = await res.text().catch(() => '');
    return { status: res.status, text: text.slice(0, 300) };
  }

  /** chat：model 用 handle；run_id 在 codebuff_metadata 里。 */
  /**
   * trace_session_id：一个 run 一个，不是每请求随机
   * （line 14 与 26 同为 a43f616d-...；line 38/42/45/56 同为 6b5550f5-...）。
   */
  _traceFor(runId) {
    if (!this._runState || this._runState.runId !== runId) {
      this._runState = { runId, traceSessionId: crypto.randomUUID(), step: 0 };
    }
    return this._runState.traceSessionId;
  }

  /** llm_step_number：同一 run 内单调递增，返回递增后的值。 */
  _stepFor(runId) {
    if (!this._runState || this._runState.runId !== runId) {
      this._runState = { runId, traceSessionId: crypto.randomUUID(), step: 0 };
    }
    this._runState.step += 1;
    return this._runState.step;
  }

/**
   * chat —— 逐字段照抄官方抓包（worker 层形态）。
   *
   * 官方真值（docs/reverse/captures/2026-10-03-official-client.jsonl）：
   *   TOP KEYS: model, codebuff_metadata, provider, messages, tools, tool_choice, stream
   *   provider:              {"data_collection":"deny"}      ← worker 层
   *   tool_choice:           "auto"
   *   stream:                true
   *   tools:                 官方 37 个（含 write_file）
   *   metadata:              run_id / client_id / cost_mode / freebuff_instance_id /
   *                          freebuff_multi_session / trace_session_id /
   *                          repo_snapshot / llm_step_number / freebuff_reasoning_effort
   *   ⚠️ 官方**没有** surface 与 freebuff_client_env（那两个是 CLI 侧的，
   *      我们此前从第三方实现抄来，desktop 不用 —— 属"协议混用"）
   *   UA 三段完整：.../codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2
   */
  async chat({
    row, instanceId, runId, messages, tools,
    stream = true,
    layer = 'worker',
    reasoningEffort = null,
    noSend = false,
  }) {
    const url = `${this.host}/api/v1/chat/completions`;
    const { OFFICIAL_TOOLS, OFFICIAL_DECIDE, OFFICIAL_SYS } = await loadOfficialAssets();

    // 按层用官方真实工具集：
    //   manager → 官方 decide 定义（1 个，required 含 decision/why/expectedGain/
    //             confidence/evidence）
    //   worker  → 官方 37 个工具
    // ⚠️ lookup_agent_info 在 desktop 世代**不存在**（37 工具里没有），
    //    它是我们从 CLI 侧抄来的，必须删除。
    // ⚠️ **合并**而不是替换：官方工具集在前（满足工具指纹），
    // 客户端自定义工具按名去重后追加。
    //
    // 直接替换会让客户端声明的自定义工具**静默消失** —— 上游 37 工具里
    // 没有 run_code / get_weather 这类名字，用户以为声明了能调，实际发不出去。
    /**
     * ⚠️ **下行**：客户端工具必须经 `MAP_TOOLS` 换成官方等价名，映射不到的丢弃。
     *
     * 旧版直接把客户端工具**原样追加** —— 实测（远程 15:02）55 个第三方工具
     * 原样发出后，上游回 503；同会话同模型不带工具则是 200。唯一变量就是工具集。
     * 官方工具集是固定 37 个，里面没有 `bash`/`edit`/`read`/`write`/`skill`。
     */
    const droppedTools = {};
    const clientToolNames = {};
    for (const t of Array.isArray(tools) ? tools : []) {
      const n = t?.function?.name;
      if (n && MAP_TOOLS[n]) clientToolNames[n] = MAP_TOOLS[n];
    }
    let outTools = tools || [];
    if (layer === 'manager' && OFFICIAL_DECIDE?.length) {
      outTools = mergeOfficialTools(OFFICIAL_DECIDE, tools, droppedTools);
    } else if (layer === 'worker' && OFFICIAL_TOOLS.length > 0) {
      outTools = mergeOfficialTools(OFFICIAL_TOOLS, tools, droppedTools);
    }
    const droppedNames = Object.keys(droppedTools);
    if (droppedNames.length) {
      console.error(
        '[tool-map] dropped client tools with no official equivalent:',
        droppedNames.join(', '),
      );
    }
    const sysTpl = OFFICIAL_SYS?.[layer] || OFFICIAL_SYS?.worker;

    // system：官方模板渲染后置于首位（客户端消息里的 system 不再覆盖它）
    const rest = (messages || []).filter((m) => m && m.role !== 'system');
    const userText = (rest.find((m) => m.role === 'user')?.content) ?? '';
    const sysText = !sysTpl
      ? null
      : layer === 'manager'
        ? renderManagerSystem(sysTpl, typeof userText === 'string' ? userText : JSON.stringify(userText))
        : renderWorkerSystem(sysTpl);
    const outMessages = sysText
      ? [{ role: 'system', content: sysText }, ...rest]
      : messages;

    const metadata = {
      run_id: runId,
      // 官方固定 11 位 base36（line 14 0mrb3znwuim / 38 92jgxqouweo / 60 2qgozlgk45r）
      client_id: (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 11),
      cost_mode: 'free',
      freebuff_instance_id: instanceId,
      freebuff_multi_session: '1',
      trace_session_id: this._traceFor(runId),
      // 分层取值：manager 全 0；worker 用真实项目统计（P1-9）
      repo_snapshot: JSON.stringify(
        layer === 'manager'
          ? {
              gitAvailable: false,
              repositoryVisibility: 'unknown',
              fileCount: 0,
              fileCountIsLowerBound: false,
              testFileCount: 0,
              changedFileCount: 0,
              changedFileScanTruncated: false,
            }
          : await collectRepoSnapshot(this.cfg.projectDir || process.cwd()),
      ),
      // 官方同 run 内递增（line 38=1 → 42=2 → 45=3 → 56=4），字符串形态
      llm_step_number: String(this._stepFor(runId)),
    };
    if (reasoningEffort) metadata.freebuff_reasoning_effort = reasoningEffort;

    const body = JSON.stringify({
      model: row.handle,
      codebuff_metadata: metadata,
      // worker 层 = data_collection:deny；manager 层 = allow_fallbacks:true
      provider: layer === 'manager'
        ? { allow_fallbacks: true }
        : { data_collection: 'deny' },
      messages: outMessages,
      tools: outTools,
      tool_choice: 'auto',
      stream,
    });
    // ⚠️ 严格照抄：官方 chat **只有**这 7 个业务头（抓包真值）。
    // 我们此前多发 x-freebuff-instance-id / -client / -model /
    // -catalog-protocol / -install-id —— 官方 chat 全都不带，
    // 那些是 admission 用的。多发就是多余的指纹面。
    //
    // 注：此前"补 instance-id 后 428 消失"的因果待复核 ——
    // 官方不带该头却正常，说明 428 的真因可能是别的（由 review agent 兜底）。
    // 这里按"照抄"原则先对齐到官方形态。
    const hdrs = {
      'content-type': 'application/json',
      accept: '*/*',
      ...this.auth(),
      'user-agent':
        'ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2',
      'x-freebuff-acting-user-id': this.cfg.userId,
      'x-freebuff-catalog-fetch': this.fid,
      ...(await this.signHeaders('POST', url, body, this.fid)),
    };
    await dumpReq(`chat-${layer}`, 'POST', url, hdrs, body);
    // noSend：只 dump 不发送（离线对比用，零额度消耗）
    if (noSend) return { status: 0, text: '(dry-run, not sent)' };
    // 逐字节 dump chat 请求体（FREEBUFF_DUMP_DIR 设置时启用）——
    // 这是"上游到底看到了什么"的唯一可靠证据（工具集/头/字段全在里面）。
    await dumpReq('chat', 'POST', url, hdrs, body);
    const res = await fetch(url, { method: 'POST', headers: hdrs, body });
    const text = await res.text();
    // 从流式响应里取 chatcmpl-* id —— FINISH 上报需要它（官方 line 32/65/74）
    let messageId = null;
    for (const line of String(text).split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6).trim();
      if (!d || d === '[DONE]') continue;
      const m = d.match(/"id"\s*:\s*"(chatcmpl-[^"]+)"/);
      if (m) { messageId = m[1]; break; }
    }
    return { status: res.status, text, messageId };
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
    // instanceId / heartbeat 由主服务下发（官方的"持有心跳"形态）
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
  } else if (act === 'reuse') {
    // 复用已有会话：只做 startRun + chat，绝不 admission
    const row = bridge.catalog.rows.find((r) => r.key === input.modelKey)
      || bridge.catalog.rows.find((r) => r.handle === input.modelKey)
      || bridge.catalog.rows[0];
    out.model = { key: row.key, name: row.displayName };
    const run = await bridge.startRun(input.agentId);
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
    // 只构造并 dump，不发送。用于与官方抓包做离线逐字段对比，零额度消耗。
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
        // ⚠️ 参数名必须是 instanceId（chat 的解构键名）。
        // 此前写成 inst，导致 x-freebuff-instance-id 缺失 →
        // 上游不知道请求属于哪个会话 → 428 waiting_room_required。
        const c = await bridge.chat({
          row, instanceId: inst, runId: run.runId,
          messages: input.messages, tools: input.tools,
          stream: input.stream !== false,
          layer: input.layer || 'worker',
          reasoningEffort: input.reasoningEffort || null,
        });
        out.chat = c;
        out.ok = c.status === 200;
        // FINISH 上报：官方每次 run 结束都发（line 32/65/74）。
        // steps[].messageId 取流式响应的 chatcmpl-*。
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
