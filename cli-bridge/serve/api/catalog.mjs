/**
 - 目录的缓存与行解析 -- 从 cli-bridge/serve.mjs 逐字搬出后合并.
 - 缓存(TTL)与两行的匹配规则同属"目录"一件事, 拆两个文件只会让 import 绕圈.
 */
import { callBun } from '../../bridge.mjs';


let CONFIG = null;
let CATALOG = null;
let CATALOG_AT = 0;
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 - 设置随请求变化的凭据(serve.mjs 启动时调用).
 - @param {any} cfg 凭据与主机配置
 * @returns {void} 无返回值
 */
export function setConfig(cfg) {
  CONFIG = cfg;
}

/**
 - 取当前凭据(handler 组装 callBun 参数时要).
 - @returns {any} 凭据与主机配置
 */
export function getConfig() {
  return CONFIG;
}

/**
 - 取目录(TTL 内复用缓存, 否则问一次 bun 通道).
 - @param {boolean} [force] 为真时忽略缓存
 - @returns {Promise<any>} 目录对象
 */
export async function getCatalog(force = false) {
  const fresh = CATALOG && Date.now() - CATALOG_AT < CATALOG_TTL_MS;
  if (fresh && !force) return CATALOG;
  const r = await callBun({ cfg: CONFIG, action: 'catalog' });
  if (!r.catalog) throw new Error(r.error || 'catalog failed');
  CATALOG = r.catalog;
  CATALOG_AT = Date.now();
  return CATALOG;
}

/**
 - 目录行到对外模型 id(优先 legacy 风格可读名, 回落到 key).
 - @param {any} row 目录行
 - @returns {string} 对外模型 id
 */
export function toModelId(row) {
  // 对外暴露可读 id:优先 legacy 风格名,回落到 key
  return row.displayName ? String(row.displayName).toLowerCase() : row.key;
}

/**
 - 在目录里按 key / 句柄 / 对外 id / 显示名 依次匹配一行.
 - @param {any} catalog 目录对象(含 rows)
 - @param {string} wanted 客户端请求的 model
 - @returns {any|null} 命中的目录行;都没有返回 null
 */
export function resolveRow(catalog, wanted) {
  if (!wanted) return null;
  const w = String(wanted);
  return (
    catalog.rows.find((r) => r.key === w) ||
    catalog.rows.find((r) => r.handle === w) ||
    catalog.rows.find((r) => toModelId(r) === w) ||
    catalog.rows.find((r) => String(r.displayName) === w) ||
    null
  );
}
