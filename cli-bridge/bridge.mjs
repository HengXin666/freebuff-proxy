/**
 - bridge.mjs — Node 侧封装:把上游请求交给 bun 子进程执行.
 *
 - 动机见 README.md:chat 端点可能做 TLS 指纹分级检测,
 - Node(OpenSSL 3.6.5 / undici)与官方 bun 的 Client Hello 可区分
 - (52 vs 17 ciphers).与其伪装,不如用官方同一个运行时发请求.
 *
 - 这不是绕过检测:我们照常带真实登录态,真实设备签名,真实 catalog,
 - 只是让承载它们的 TLS 栈与官方客户端同源.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 - bun 可执行文件位置(按优先级):
 - 1. FREEBUFF_BUN_BIN 环境变量
 - 2. 本目录下的 ./bun(从官方客户端 AppImage 提取后放这里)
 - 3. PATH 里的 bun
 *
 - bun 二进制不入 git(79MB).部署时通过 tools/fetch-bun.sh 获取,
 - 或在 Dockerfile 里解压官方 AppImage 取得 与官方完全同一份运行时.
 */
function resolveBun() {
  const envBin = process.env.FREEBUFF_BUN_BIN;
  if (envBin) return envBin;
  const local = join(HERE, 'bun');
  if (existsSync(local)) return local;
  return 'bun';
}

export const BUN_BIN = resolveBun();
export const UPSTREAM = join(HERE, 'upstream.mjs');

/** bun 是否可用(缺失时上层应给出明确错误而不是 fetch 失败). */
export function hasBun() {
  if (BUN_BIN !== 'bun') return existsSync(BUN_BIN);
  return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
}

/**
 - 调一次 bun 子进程.stdin 传参,避免命令行长度限制与参数泄露.
 - @param {object} input
 - @param {number} [timeoutMs]
 - @returns {Promise<object>}
 */
export function callBun(input, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(BUN_BIN, [UPSTREAM], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bun bridge timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`bun exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop()));
      } catch {
        reject(new Error(`bun output not JSON: ${stdout.slice(0, 300)} | stderr: ${stderr.slice(0, 300)}`));
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

/**
 - 从 freebuff-proxy 的凭据 + 官方客户端状态构造 cfg.
 *
 - 凭据优先取官方客户端的登录态(state.json),它天然带 userId 与 installId;
 - 取不到时回落到 freebuff-proxy 的 credentials/*.json.
 - @param {{ token?: string, userId?: string }} [override]
 */
export async function loadConfig(override = {}) {
  const home = process.env.HOME || '/home/hx';
  const statePath = join(home, '.config/freebuff-desktop/state.json');
  const keyPath = join(home, '.config/freebuff-desktop/state.json.device-key.json');
  const HOST = 'https://www.codebuff.com';

  let cfg = null;
  try {
    const st = JSON.parse(await readFile(statePath, 'utf8'));
    const sess = st.authSessions?.[HOST];
    if (sess?.token) {
      let keyId = null;
      let privateKey = null;
      try {
        const dk = JSON.parse(await readFile(keyPath, 'utf8'));
        keyId = dk.registrations?.[`${HOST} user:${sess.user.id}`] ?? null;
        privateKey = dk.privateKey ?? null;
      } catch { /* 无设备密钥时退化为不签名 */ }
      cfg = {
        token: sess.token,
        userId: sess.user.id ?? null,
        installId: st.installId ?? null,
        keyId,
        privateKey,
        email: sess.user?.email ?? null,
        source: 'official-client',
      };
    }
  } catch { /* 客户端未登录 */ }

  if (!cfg) {
    // 回落:读主项目 data/credentials 与 credentials 两处
    const { readdir } = await import('node:fs/promises');
    const dirs = [join(HERE, '..', 'data', 'credentials'), join(HERE, '..', 'credentials')];
    const picked = [];
    for (const dir of dirs) {
      let files = [];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      } catch {
        continue; // 目录不存在
      }
      for (const f of files) {
        try {
          const c = JSON.parse(await readFile(join(dir, f), 'utf8'));
          if (c.authToken) picked.push(c);
        } catch { /* skip */ }
      }
      if (picked.length > 0) break;
    }
    if (picked.length === 0) throw new Error('no credentials available');
    const c = picked[0];
    cfg = {
      token: c.authToken,
      userId: c.id ?? null,
      installId: null,
      keyId: null,
      privateKey: null,
      email: c.email ?? null,
      source: 'freebuff-proxy-credentials',
    };
  }
  return { ...cfg, ...override };
}
