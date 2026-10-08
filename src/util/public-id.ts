/**
 * 对外模型 id 的构造 -- 纯函数, 无依赖.
 *
 * 对外 id 必须能被客户端当普通标识存下来: 部分客户端(如 picoclaw)拒绝带空白的
 * 模型 id. 上游目录只给 displayName(可读名, 常带空格), 所以对外 id 按下列顺序取:
 *   1. catalogId(上游 legacy 模型 id, 如 deepseek/deepseek-v4-flash) -- 优先;
 *   2. displayName 归一后的形态(空白与括号换成连字符);
 *   3. 目录 key(m-xxx, 无对应可读名时的兜底).
 *
 * display_name 字段另存可读名, 人类可读性不丢. 反向解析见
 * src/upstream/catalog-protocol.ts 的 keyForName.
 */

/** 归一后允许出现在对外 id 里的字符(其余换成连字符). */
const ILLEGAL_RUN = /[^A-Za-z0-9._/-]+/g

/**
 * 把一个可读名归一成无空白标识.
 *
 * 连续非法字符压成一个连字符, 并去掉首尾分隔符; 归一后为空则返回空串.
 *
 * @param {string} name 可读名
 * @returns {string} 无空白标识; 入参无可用字符时为空串
 */
export function slugModelId(name: unknown): string {
  if (typeof name !== 'string') return ''
  const slug = name
    .trim()
    .replace(ILLEGAL_RUN, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_./]+|[-_./]+$/g, '')
  return slug
}

/**
 * 取模型行的对外 id.
 *
 * @param {{ catalogId?: string | null, displayName?: string | null, key?: string | null }} row 模型行
 * @param {string} [fallback] 全部字段都不可用时的兜底值
 * @returns {string} 对外 id; 全空时返回兜底值
 */
export function publicModelId(
  row: { catalogId?: string | null, displayName?: string | null, key?: string | null },
  fallback = '',
): string {
  const catalogId = typeof row?.catalogId === 'string' ? row.catalogId.trim() : ''
  if (catalogId && !/\s/.test(catalogId)) return catalogId
  const slug = slugModelId(row?.displayName)
  if (slug) return slug
  const key = typeof row?.key === 'string' ? row.key.trim() : ''
  return key || fallback
}
