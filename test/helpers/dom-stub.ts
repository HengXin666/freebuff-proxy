/**
 * 极小 DOM 桩 ---- 只为[能对 dashboard 的组件做结构性断言].
 *
 * smoke-frontend 用的是万能 Proxy 桩: 能抓 TDZ, 但不记账 ---- 数不出有几个孩子
 * 节点. 一件签到警告条重复堆积, 一次[芯片没挂处理器]都是靠这里的真记账桩抓到的.
 *
 * 边界(刻意不做): 不解析 HTML, 不做 CSS, 不做事件冒泡, 不实现 layout.
 * insertAdjacentHTML 只记录片段文本. 这不是通用 DOM, 是结构断言的最小够用集.
 */

import { makeClassList } from './class-list.ts'

/** 一个可数孩子的极简元素. */
class StubNode {
  tagName: string
  attrs: Record<string, any>
  children: any[]
  textContent: string
  className: string
  id: string
  disabled: boolean
  /** insertAdjacentHTML 记下的片段数(只记账, 不解析). */
  htmlFragments: string[]
  /** 已注册的事件处理器(按事件名). */
  handlers: Record<string, Array<(...a: any[]) => any>>
  parentNode: any
  style: any
  value: string

  /**
   * 元素节点的 nodeType 常量(真实 DOM 为 1).
   *
   * 必须有: 本仓的 el() 用 c.nodeType 判断"这是不是节点" ----
   * 缺少它时该判断恒为 undefined, 于是所有子节点都会被当成文本处理,
   * 表现为节点神秘消失(实测: 按钮整个不见了, 只剩它旁边的 span).
   */
  nodeType: number
  constructor(tag: string) {
    this.nodeType = 1
    this.tagName = String(tag).toUpperCase()
    this.attrs = {}
    this.children = []
    this.textContent = ''
    // className 与 id 走属性, 但组件里大量用 node.className = x / node.id = x,
    // 所以给它们真实字段而不是只放进 attrs.
    this.className = ''
    this.id = ''
    this.disabled = false
    this.htmlFragments = []
    this.handlers = {}
    this.parentNode = null
    this.style = {}
    this.value = ''
  }

  /** 与真实 DOM 同义的 append(可多个). */
  append(...nodes: any[]) {
    for (const n of nodes) {
      if (n === null || n === undefined) continue
      this.children.push(n)
      if (n instanceof StubNode) n.parentNode = this
    }
  }

  /** 真实 DOM 的 appendChild 别名. */
  appendChild(n: any) {
    this.append(n)
    return n
  }

  /** prepend(真实 DOM 同义). */
  prepend(...nodes: any[]) {
    for (const n of nodes.slice().reverse()) {
      if (n == null) continue
      this.children.unshift(n)
      if (n instanceof StubNode) n.parentNode = this
    }
  }

  /** classList 的最小实现(见 ./class-list.ts). */
  get classList() {
    return makeClassList(this)
  }

  setAttribute(k: string, v: any) {
    this.attrs[k] = v
    if (k === 'class') this.className = String(v)
    if (k === 'id') this.id = String(v)
    if (k === 'value') this.value = String(v)
  }

  getAttribute(k: string) {
    return this.attrs[k] ?? null
  }

  /** 只记账不解析(见文件头[边界]). */
  insertAdjacentHTML(_pos: string, html: string) {
    this.htmlFragments.push(String(html))
    // 片段在测试里按一个节点计 ---- 它们都是单个 SVG 图标.
    this.children.push(makeText(String(html)))
  }

  addEventListener(name: string, fn: any) {
    ;(this.handlers[name] ||= []).push(fn)
  }

  removeEventListener(name: string, fn: any) {
    const list = this.handlers[name]
    if (!list) return
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }

  /**
   * 触发已注册的处理器(测试用, 真实 DOM 没有这个).
   * @param {any} name 事件名
   * @returns {Promise<void>} 处理器全部执行完
   */
  async dispatch(name: string) {
    for (const fn of (this.handlers[name] || []).slice()) {
      await fn({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} })
    }
  }

  /** 深度优先收集自身与后代里满足判据的节点. */
  walk(pred: (n: StubNode) => boolean, out: StubNode[] = []) {
    if (pred(this)) out.push(this)
    for (const c of this.children) {
      if (c instanceof StubNode) c.walk(pred, out)
    }
    return out
  }

  /**
   * 该节点下匹配选择器的全部节点.
   *
   * 支持三种形式: \.class\ 与 \#id\, 以及它们的逗号并列(如
   * '.view-enter, .view'). 逗号必须支持 ---- 路由层就是靠并列选择器找内容
   * 容器的, 不支持时它会恒返回 null, 于是每次切页都走[重建骨架]分支,
   * 页面缓存这条路径在测试里根本跑不到(实测: 隐藏面板数恒为 0).
   *
   * @param {string} sel 选择器(.class / #id, 可逗号并列)
   * @returns {StubNode[]} 匹配的节点
   */
  querySelectorAll(sel: string) {
    const parts = String(sel).split(',').map((x) => x.trim()).filter(Boolean)
    const hit = (n: StubNode) => parts.some((part) => {
      if (part.startsWith('#')) return n.id === part.slice(1)
      if (part.startsWith('.')) return (n.className || '').split(/\s+/).includes(part.slice(1))
      // 裸选择器 = 标签名. 必须支持: 路由层用 querySelector('header') 判断骨架
      // 是否已存在, 缺了它该判断恒为 null, 于是每次渲染都重建骨架并把页面缓存
      // 作废 ---- 缓存那条路径在测试里等于没覆盖(实测: 面板数恒为 1).
      return n.tagName === part.toUpperCase()
    })
    return this.walk(hit)
  }

  /**
   * 该节点下第一个匹配选择器的节点.
   *
   * @param {string} sel 选择器(.class 或 #id)
   * @returns {StubNode|null} 匹配的节点
   */
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] || null
  }

  /** 深度优先找第一个 tag 匹配的节点. */
  get firstElementChild() {
    return this.children.find((c) => c instanceof StubNode) || null
  }

  /** 本节点的直接子元素(只算 StubNode). */
  get childElements() {
    return this.children.filter((c) => c instanceof StubNode)
  }

  /** 递归统计自身 + 后代的元素节点数. */
  countElements() {
    return this.walk(() => true).length
  }

  /** 焦点(桩里只记状态; 组件用它在对话框里定位默认按钮). */
  focus() {
    const doc: any = (globalThis as any).document
    if (doc) doc.activeElement = this
  }

  /** 失焦. */
  blur() {
    const doc: any = (globalThis as any).document
    if (doc && doc.activeElement === this) doc.activeElement = null
  }

  /** 从父节点摘掉自己(组件里用 n.remove()). */
  remove() {
    const p = this.parentNode
    if (!p) return
    const i = p.children.indexOf(this)
    if (i >= 0) p.children.splice(i, 1)
    this.parentNode = null
  }

  /** innerHTML 语义: 清空(本项目只拿它做清空). */
  set innerHTML(_v: string) {
    this.children = []
    this.textContent = ''
  }

  get innerHTML() {
    return ''
  }

  /** closest: 只按 class 匹配祖先链(组件里用于 .card / .switch). */
  closest(sel: string) {
    const cls = sel.replace(/^\./, '')
    let n: any = this
    while (n) {
      if ((n.className || '').split(/\s+/).includes(cls)) return n
      n = n.parentNode
    }
    return null
  }
}

/** 文本节点(计数用). */
function makeText(s: string) {
  return { nodeType: 3, text: s, parentNode: null }
}

/**
 * 装一套全局 DOM 桩, 返回 document 与一个可复用的 documentElement.
 *
 * @returns {{document: any, body: any}} 桩化的 document
 */
export function installDomStub() {
  const body = new StubNode('body')
  const byId = new Map<string, StubNode>()

  const doc: any = {
    body,
    createElement: (tag: string) => new StubNode(tag),
    // 图标走 createElementNS(建 SVG). 桩不区分命名空间 ----
    // 测试只数节点个数, 不关心它的 namespace.
    createElementNS: (_ns: string, tag: string) => new StubNode(tag),
    createTextNode: (s: string) => makeText(String(s)),
    // 组件里用 getElementById 回查(这也是本次 bug 的成因之一), 必须支持.
    getElementById: (id: string) => byId.get(id) || null,
    addEventListener: () => {},
    removeEventListener: () => {},
    head: new StubNode('head'),
    querySelector: (sel: string) => {
      if (sel.startsWith('#')) return byId.get(sel.slice(1)) || null
      return body.querySelectorAll(sel)[0] || null
    },
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
  }

  /**
   * 挂到全局, 并让 createElement 建出来的节点在 setAttribute('id') 时进索引.
   *
   * 为什么要索引: 组件大量用 document.getElementById 回查自己刚建的节点;
   * 不索引的话这些回查全返回 null, 测试就会静默地测不到东西.
   *
   * @param {any} node 新节点
   * @returns {any} 同一节点
   */
  const trackId = (node: any) => {
    const origSet = node.setAttribute.bind(node)
    node.setAttribute = (k: string, v: any) => {
      origSet(k, v)
      if (k === 'id') byId.set(String(v), node)
    }
    // 组件也会直接写 node.id = x(不走 setAttribute), 用 defineProperty 兜住.
    let idVal = ''
    Object.defineProperty(node, 'id', {
      get: () => idVal,
      set: (v: string) => { idVal = String(v); byId.set(idVal, node) },
      configurable: true,
    })
    return node
  }
  const origCreate = doc.createElement
  doc.createElement = (tag: string) => trackId(origCreate(tag))

  globalThis.document = doc
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    queueMicrotask: (fn: any) => queueMicrotask(fn),
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    location: { hash: '', href: '' },
  }
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  return { document: doc, body }
}

export { StubNode, makeText }
