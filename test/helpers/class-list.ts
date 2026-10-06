/**
 * StubNode 的 classList 视图 -- 从 ./dom-stub.ts 按体量红线切出.
 *
 * 组件用 toggle / contains / add / remove 表达[选中], 测试若读不到它就分不清
 * [点了但没生效] 与 [生效了]. 与 className 是同一份数据的两个视图.
 */

/** classList 的最小实现. */
export interface StubClassList {
  /** 是否含有该类. */
  contains: (name: string) => boolean
  /** 添加类. */
  add: (name: string) => void
  /** 移除类. */
  remove: (name: string) => void
  /** 切换类; force 给了就按它, 否则取反. */
  toggle: (name: string, force?: boolean) => boolean
}

/**
 * 造一个绑定到某节点的 classList.
 *
 * @param {any} node 承载 className 的节点
 * @returns {StubClassList} classList 视图
 */
export function makeClassList(node: any): StubClassList {
  const read = () => String(node.className || '').split(/\s+/).filter(Boolean)
  const write = (list: string[]) => { node.className = list.join(' ') }
  return {
    contains: (name: string) => read().includes(name),
    add: (name: string) => { const l = read(); if (!l.includes(name)) write([...l, name]) },
    remove: (name: string) => write(read().filter((x) => x !== name)),
    toggle: (name: string, force?: boolean) => {
      const has = read().includes(name)
      const want = force === undefined ? !has : Boolean(force)
      if (want !== has) want ? write([...read(), name]) : write(read().filter((x) => x !== name))
      return want
    },
  }
}
