# Agent Note: 控制台切页只显示当前页(hidden 判据写反)

Status: implemented

受影响代码: `dashboard/views/shell/index.ts`, `test/helpers/dom-stub.ts`,
`test/suites/entries/verify/dashboard/route-panel-visibility.ts`

## Problem

用户报[点导航栏切页, 每个页面的内容都是错的]. 真浏览器实测
(headless Chrome + CDP, 逐页截图抓 DOM 与几何) 得到三条确凿现象:

1. 首屏整页空白 ---- 登录后 #app 里 header / nav 都在, 内容区高度 0,
   唯一的路由面板 hidden=true;
2. 点[设置]后看到的仍是总览页的账号池, 设置页自己的 DOM 已经渲染好但被隐藏;
3. 再点几次, 访问过的每一页纵向堆在一起(实测切 5 页后同时显示 4 页),
   页面越滚越长, 正文却总是别的页面的.

根因是同一条机制: `showRoute` 里写的是

    for (const [key, node] of viewCache) node.hidden = key === route

语义变成[是当前路由就藏起来], 于是当前页被隐藏, 历史页全部显示. 首屏尤其
直观 ---- 此刻当前页是唯一的面板, 这条规则恰好把唯一的面板藏起来, 整页没有任何
可见内容.

上一版提交 771ae51 引入页面级 DOM 缓存时把这一行写反了, 且没有任何判据覆盖它.

## Decision

判据改为 `node.hidden = key !== route`(不是当前路由就隐藏).

同时补一条可证伪的回归判据 `test/suites/entries/verify/dashboard/
route-panel-visibility.ts`: 沿导航逐个切页, 每次可见面板必须正好 1 个且是刚渲染的
那个; 首屏只应有一个面板且必须可见; 已渲染过的页再切回必须复用面板(不重拉接口);
切走的面板必须仍在 DOM 里. 把判据写回 `key === route`, 该套件立刻变红(实测).

缓存复用的那条判据用总览页做观测点(它的渲染真的会 await /api/overview).
设置页在这里不可用: 它的数据由 need() 钩子提供, 而本桩下钩子未装配 ---- 拿它做
判据会写成恒真断言(实测: 破坏复用短路后计数仍不变).

为了让这条判据能真的跑到缓存路径, `test/helpers/dom-stub.ts` 的
`querySelectorAll` 补齐了逗号并列选择器与裸标签名选择器: 路由层用
`querySelector('.view-enter, .view')` 找内容容器, 用 `querySelector('header')`
判断骨架是否存在. 缺了这两条它会恒返回 null, 于是每次切页都走[重建骨架]分支,
缓冲区在这条路径上等于没被测到(实测: 面板数恒为 1).

## Alternatives considered

- **什么都不做, 只把这一行改回来**: 一行改完就完了, 但那正是上次的处境 ----
  这类[装配层写反]的缺陷没有任何既有判据看得见(加载速度套件只量毫秒数,
  页面全空也一样快; 其余结构断言都在各视图内部). 不补判据等于等下一次复发.
  否决.
- **改成 CSS 方案(给非当前面板加 .hidden 类, 不碰 hidden 属性)**: 语义等价,
  但现有三个断言都读 `node.hidden`, 且 CSS 类会让[可见性]这件事从单一属性散到
  样式表与类名两处. 否决.
- **只更新当前页与上一页(最小化 DOM 写)**: 少几次属性写入, 但漏掉[一次之后仍在
  树里的更早面板]时会留下可见的幽灵页 ---- 正是这次的现象. 全量遍历 viewCache
  才是把状态收敛到唯一真相. 否决.
- **让 dom-stub 支持完整 CSS 选择器解析**: 能覆盖更多调用点, 但按需补齐(逗号 +
  标签名)已经让本套件跑到目标分支, 而桩的边界写明了[不做 CSS 解析], 引入解析器
  会把一个结构计数桩变成半个引擎. 否决.

## Consequences

- 首屏不再是空白; 切页只显示目标页, 其余面板保留在 DOM 里(表单值与滚动位置
  不丢, 这是缓存语义要保住的部分).
- dom-stub 的选择器能力扩大了一点点(逗号并列 + 裸标签名), 既有套件不受影响.
- 前端 checkJs 错误数从 51 降到 47, 门禁提示可 `--update` 重录棘轮.

## Testing

`node test/run.ts dashboard-route-panel-visibility`(16 条断言). 反向探针已实测:
把 `node.hidden` 写回 `key === route`, 该套件立刻变红, 还原后转绿.
真浏览器复核(headless Chrome, 逐页截图): 切 7 次后可见面板恒为 1, 内容区高度
从 857 恢复正常, 页面不再堆叠.
