/**
 - 官方资产加载 -- 从 cli-bridge/upstream.mjs 逐字搬出.
 - 抓包真值见 docs/reverse/captures/; 缺失时返回空集(不静默崩).
 */
let OFFICIAL_TOOLS = null;
let OFFICIAL_DECIDE = null;
let OFFICIAL_SYS = null;

/** 读官方抓包资产(模块级缓存; 缺失时返回空集). */
/**
 - 读官方抓包资产(模块级缓存; 缺失时返回空集).
 - @returns {Promise<{OFFICIAL_TOOLS: any, OFFICIAL_DECIDE: any, OFFICIAL_SYS: any}>} 资产
 */
export async function loadOfficialAssets() {
  if (OFFICIAL_TOOLS && OFFICIAL_SYS) return { OFFICIAL_TOOLS, OFFICIAL_DECIDE, OFFICIAL_SYS };
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  // 本文件在 freebuff-proxy/cli-bridge/,抓包在 ../docs/reverse/captures/
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
