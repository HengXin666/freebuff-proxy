/**
 - 上游请求的逐字节 dump -- 从 cli-bridge/upstream.mjs 逐字搬出.
 - FREEBUFF_DUMP_DIR 设置时启用; 模块级 dumpSeq 与函数同处一个模块.
 */
const DUMP_DIR = process.env.FREEBUFF_DUMP_DIR || '';
let dumpSeq = 0;

/**
 - 把一次上游请求的原始形态落盘(逐字节).
 - @returns {Promise<void>} 无返回值
 */
/**
 - 把一次上游请求的原始形态落盘(方法/路径/头/体 hex+utf8).
 - @param {string} label 标签(进文件名)
 - @param {string} method HTTP 方法
 - @param {string} url 目标地址
 - @param {Record<string,string>} headers 出站头
 - @param {unknown} body 请求体
 - @returns {Promise<void>} 无返回值
 */
export async function dumpReq(label, method, url, headers, body) {
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
