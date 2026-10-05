/**
 - bridge.ts -- Node 侧封装:把上游请求交给 bun 子进程执行.
 *
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
export const UPSTREAM = join(HERE, 'upstream.ts');

export function hasBun() {
  if (BUN_BIN !== 'bun') return existsSync(BUN_BIN);
  return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
}

/**
 - 调一次 bun 子进程. stdin 传参,避免命令行长度限制与参数泄露.
 - @param {object} input
 - @param {number} [timeoutMs]
 - @returns {Promise<object>}
 */
export function callBun(input: any, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(BUN_BIN, [UPSTREAM], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout: any = '';
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
      // 汇总行 = 最后一个以 '>' 开头的行(流式正文行不带前缀, 见 upstream.ts 协议).
      const summaryLine = stdout
        .split('\n')
        .filter((l: string) => l.startsWith('>'))
        .pop();
      if (!summaryLine) {
        // 兼容旧格式(无前缀的单行 JSON)与错误路径.
        const last = stdout.trim().split('\n').pop() || '';
        try {
          resolve(JSON.parse(last));
        } catch {
          reject(new Error(`bun output not JSON: ${stdout.slice(0, 300)} | stderr: ${stderr.slice(0, 300)}`));
        }
        return;
      }
      try {
        resolve(JSON.parse(summaryLine.slice(1)));
      } catch {
        reject(new Error(`bun summary not JSON: ${summaryLine.slice(0, 300)} | stderr: ${stderr.slice(0, 300)}`));
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

/**
 - 流式调一次 bun 子进程: 正文按行边收边交, 汇总行最后到.
 -
 - 与 callBun 的差别只有"不把 stdout 拼成一整块":
 - onLine 每拿到一行就调用一次(上游吐一片 -> 主服务立刻能下发一片),
 - onSummary 在末行(以 '>' 开头的那行 JSON 汇总)到达时调用一次.
 -
 - 这是"整段缓冲"的根治点: 旧链路 bun 侧 await res.text() 攒完才返回,
 - 主服务要等整篇回复; 现在字节一到就能往下走.
 -
 - 超时语义保持与 callBun 一致: 到点未结束即 SIGKILL 并以 timeout 拒绝.
 - 注意它约束的是"整次调用"(含上游全篇生成), 首字节延迟不再受它牵连.
 -
 - @param {object} input 传给 bun 的入参
 - @param {object} opts 回调与超时: timeoutMs / onLine(每行) / onSummary(末行汇总) / onError(失败)
 - @returns {object} 句柄(含 kill, 客户端断开时用于掐断子进程)
 */
export function callBunStream(input: any, opts: any) {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const onLine = opts?.onLine || (() => {});
  const onSummary = opts?.onSummary || (() => {});
  const onError = opts?.onError || (() => {});
  const child = spawn(BUN_BIN, [UPSTREAM], { stdio: ['pipe', 'pipe', 'pipe'] });
  let settled = false;
  let pending = '';
  let stderr = '';
  let summarySeen = false;

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(() => onError(new Error(`bun bridge timeout after ${timeoutMs}ms`)));
  }, timeoutMs);

  const handleLine = (line: string) => {
    // 汇总行约定: 以 '>' 开头(见 cli-bridge/lib/endpoints/chat.ts 的 stdout 协议).
    if (line.startsWith('>')) {
      try {
        const obj = JSON.parse(line.slice(1));
        summarySeen = true;
        finish(() => onSummary(obj));
      } catch {
        // 汇总行解析失败不是致命: 正文已经下发, 下游仍能拼出完整响应.
        summarySeen = true;
        finish(() => onSummary({}));
      }
      return;
    }
    if (line) onLine(line);
  };

  child.stdout.on('data', (d: any) => {
    pending += String(d);
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      handleLine(line);
    }
  });
  child.stderr.on('data', (d: any) => { stderr += String(d); });
  child.on('error', (e: any) => {
    finish(() => onError(e instanceof Error ? e : new Error(String(e))));
  });
  child.on('close', (code: number) => {
    if (pending) handleLine(pending);
    if (!settled) {
      // 没有汇总行就退场: 有正文说明响应其实成功了, 无正文才算失败.
      finish(() => onError(
        new Error(
          summarySeen
            ? 'bun stream ended without summary'
            : `bun exited ${code}: ${stderr.slice(0, 300)}`,
        ),
      ));
    }
  });

  child.stdin.write(JSON.stringify(input));
  child.stdin.end();

  return {
    kill() {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish(() => onError(new Error('bun stream aborted')));
    },
  };
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
