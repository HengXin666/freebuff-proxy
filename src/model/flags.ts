/**
 * 模型计费档位判定(免费 / 收费).
 *
 * 依赖方向:本文件 -> catalog-store.ts.不依赖 list-response.ts,
 * 避免与需要 isPremiumModel 的 list-response 形成循环 import.
 * 判据与 FREEBUFF_AVAILABLE_MODELS 的投影等价(catalog 行缺失时 pool 默认 daily).
 */
import { catalogModels } from './catalog-store.ts'

/**
 * 模型是否走"免费额度"计费(影响调度策略):
 *   - 免费模型(pool 非 premium:daily / referral / limited_offer / helper):
 *     额度按次/按小时免费结算,可暴力分散到多账号,会话临近过期(<5 分钟)即提前
 *     re-admit 换新会话 -- 避免请求发到马上过期的会话上中途被掐断/白占额度.
 *   - 付费模型(pool=premium,如 gpt-5.6-luna / minimax-m3):
 *     每次 admit 都会新建计费会话 -> 调度必须热 session 复用(不分散,不浪费),
 *     会话用到接近过期再切换.
 *
 * 未知模型按免费处理(保守:不阻塞可用性).
 * 自定义模型(前端配置)优先于内置 catalog -- 操作者可把某个 id 的 pool 改成
 * premium 让它走热 session 复用调度.
 *
 * @param {string} modelId 模型 id
 * @param {{ id: string, pool?: string }[]} [customModels] 前端配置的自定义模型列表
 * @returns {boolean} true 表示按免费额度计费
 */
export function isFreeModel(modelId: string, customModels?: { id: string, pool?: string }[]): boolean {
  const cm = (customModels || []).find((x) => x && x.id === modelId)
  if (cm) return (cm.pool || 'daily') !== 'premium'
  const m = catalogModels().find((x) => x.id === modelId)
  return !m || (m.pool || 'daily') !== 'premium'
}

/**
 * 模型是否为收费模型(pool=premium):用户用不了,做了还占额度/触风控.
 * 判定优先级:自定义条目(可强制改 pool)> catalog > 按命名规律推断.
 *
 * @param {string} modelId 模型 id
 * @param {{ id: string, pool?: string }[]} [customModels] 自定义模型
 * @returns {boolean} true 表示收费模型
 */
export function isPremiumModel(modelId: string, customModels?: { id: string, pool?: string }[]): boolean {
  const cm = (customModels || []).find((m) => m && m.id === modelId)
  if (cm) return (cm.pool || 'daily') === 'premium'
  const cat = catalogModels().find((m) => m.id === modelId)
  if (cat) return (cat.pool || 'daily') === 'premium'
  return false
}
