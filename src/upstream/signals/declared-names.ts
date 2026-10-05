/**
 * [本次声明]的工具名集合归一.
 *
 * 回程还原名字时要用它: 只有下游这次真的声明过的客户端名才允许被还原出来,
 * 否则会造出下游不认识的别名(本地会话记录实测: unknown tool "ls").
 */

/**
 * 把一组工具声明归一成名字集合(接受 Set / 字符串数组 / OpenAI 工具数组).
 *
 * @param {any} names 名字集合, 字符串数组, 或 [{function:{name}}] 形态的工具数组
 * @returns {Set<string>} 名字集合;空输入返回空集
 */
export function toNameSet(names: any): Set<string> {
  const out = new Set<string>()
  if (!names) return out
  if (typeof names.has === 'function' && typeof names[Symbol.iterator] === 'function') {
    for (const n of names) if (typeof n === 'string' && n) out.add(n)
    return out
  }
  if (Array.isArray(names)) {
    for (const item of names) {
      if (typeof item === 'string') {
        if (item) out.add(item)
      } else if (item && typeof item === 'object' && typeof item.name === 'string') {
        out.add(item.name)
      } else if (item?.function?.name) {
        out.add(item.function.name)
      }
    }
  }
  return out
}
