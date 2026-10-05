/**
 - 前端冒烟:把 dashboard 的两个 ES module 在真实 JS 引擎里完整求值一遍.
 *
 - 为什么需要它(2026-10-04 事故):dashboard/app.ts 里把派生值写在了它依赖的
 - const 之前 → 命中 TDZ
 - ReferenceError: can't access lexical declaration 'rows' before initialization
 - 表现是整个控制台白屏.而 node --check 只做语法解析,抓不到 TDZ
 - (TDZ 是运行期错误,语法完全合法)---- 所以那次改动带着白屏过了全部门禁,
 - 直到用户打开页面才发现.
 *
 - 这里用最小 DOM 桩把模块体真正跑完:任何 TDZ,未定义引用都会在求值阶段抛出来.
 - 不做 UI 断言(项目不出浏览器依赖):只保证"这个文件能被加载".
 *
 - 用法:node test/smoke-frontend.mjs
 */
const HERE = new URL('../../../..', import.meta.url).pathname

/** 万能桩:任何属性访问/调用都返回自身,能撑过 DOM 初始化代码. */
const stub = new Proxy(() => stub, {
  get: (_t, k) => (k === 'then' ? undefined : stub),
  apply: () => stub,
})

globalThis.window = stub
globalThis.document = stub
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
globalThis.location = { hash: '', href: '' }

const targets = ['dashboard/locale/index.ts', 'dashboard/app.ts']

for (const rel of targets) {
  try {
    await import(`${HERE}${rel}`)
    console.log(` ${rel} 完整求值通过`)
  } catch (err) {
    console.error(` ${rel}: ${err?.constructor?.name}: ${err?.message}`)
    process.exit(1)
  }
}

console.log('frontend smoke ok')
