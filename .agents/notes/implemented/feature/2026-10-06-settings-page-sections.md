# Agent Note: 全局配置从总览页剥离为独立设置页, 并按用途分区排版

Status: implemented

## Problem

用户原话: "总览页面为什么会有这个全局配置项呢? 它应该专门移到一个新的/比如说设置页面,
你别全部都堆在同一个页面啊, 这样子也太难看了, 而且这个页面应该要分成好几个区的呀,
你这些输入框全都挤在一起".

改前实测(`dashboard/views/overview/index.ts` 的 renderOverview): 总览页在账号表之后
一次性挂出 8 张配置卡 ----

```
await need('renderProxySettings')(view)   // 工具签名 / 工具兜底 / 工具承载 /
                                          // 请求链路 / 负载均衡 / 额度保护 / 代理池 / 可调项
await need('renderModelSettings')(view)   // 模型管理
```

三处具体问题:

1. **职责混在**一屏: "账号池状态"是只读监控, 配置是写操作, 两者刷新频率与使用场景
   完全不同, 却共用一个页面.
2. **八张卡视觉权重完全相同**: 每张卡都是 `.card` + `margin-top:12px` 平铺, 代理池与
   额度保护这种毫不相干的配置上下相邻, 看不出归属.
3. **没有导航入口**: 只能靠滚动找, 页面越长越找不到想改的项.

## Decision

**总览页只留账号池状态与统计; 全局配置整体搬到独立的 `#settings` 页, 并按用途分区.**

- 新增路由 `#settings`(`dashboard/views/settings/index.ts`), 导航加一项
  `nav.settings`. 位置排在总览之后(配置是第二高频的第二件事).
- 分五区, 每区 = 标题条(标题 + 一句话说明) + 该区卡片:

  | 区 | 内容 |
  |---|---|
  | 上游与工具 | 请求链路 / 工具签名 / 工具兜底 / 工具承载 |
  | 调度与额度 | 负载均衡 / 额度保护 |
  | 网络与出口 | 代理池 |
  | 模型 | 模型管理 |
  | 高级(需重启) | 可调项 |

- **左侧竖排边栏切换分区**(用户补充要求: "左侧边栏有个导航那种, 就像是左侧边栏
  换哪一页"): 一次只显示一个区(`.settings-section.active`), 点边栏换区. 不用
  纵向堆叠 + 跳转条 ---- 那种做法一屏还是能看到所有区, 与"分区"的诉求只解决了一半.
  切换只改 class 不重建 DOM: 用户在某个输入框里改了一半的值, 换区再回来必须还在.
- 分区表是**单列真源** `dashboard/views/proxy/sections.ts` 的 `buildSettingsSections`:
  新增一张卡时只在那里决定归哪个区; 渲染顺序与边栏项都由它派生
  (`views/settings/index.ts` 的 `SECTIONS` 与它一一对应).
- 卡片实现**不搬家**: 配置卡的构造与保存逻辑仍归 `views/proxy/` 与 `views/models/`,
  设置页只做页面级装配(读接口, 套分区外壳, 挂跳转条). 跨视图调用走既有的
  `need(name)` hook 机制(视图之间不互相 import, 会成环).
- 总览页尾部留一张[配置已搬家]提示卡 + 一键跳转, 而不是静默移除.

## Alternatives considered

- **什么都不做**: 用户明确点名这是要修的, 且列了三条具体不满(位置错 / 没分区 / 输入框挤).
- **在总览页内部折叠分区(`<details>` 分组)**: 页面仍是同一个, "配置不该在总览页"这条
  没有被解决; 而且折叠状态下等于把配置藏得更深, 比平铺更难找.
- **把配置卡片的实现也一起搬到 `views/settings/`**: 那些卡与它们的保存函数(以及
  `idleReleaseAdvice` 这类按账号池实时算的逻辑)与 `/api/proxy`, `/api/settings` 的读取
  绑在一起, 整体搬家等于把 `views/proxy/` 复制一遍 ---- 两处保存语义必然漂移.
  只搬页面骨架, 实现留在原处, 是改动面最小的正确切法.
- **`buildSettingsSections` 里连模型区一起返回**: 模型卡片由 `views/models` 渲染, 需要
  `await` 且属于另一个视图的职责; 塞进纯同步的卡片装配函数会引入跨视图 await 依赖.
  改为: 该函数只负责 proxy 的四个区, 模型区与高级区的顺序由设置页决定.
- **把[高级(可调项)]留在 proxy 的区表内**: 它需要排在模型区之后, 而模型区是设置页
  后插的, 留着会出现"高级在模型之前"的错序. 故拆出 `buildAdvancedSection` 单取.

## Consequences

- 导航从 6 项变 7 项(新增"设置"), 排在总览之后.
- 老用户在总览页找不到配置时, 尾部提示卡给出明确去向与一键跳转.
- 分区表是单列真源: 调整归属只改 `sections.ts` 一处; 设置页的跳转条按分区出现次序
  自动贴锚点 id(`SECTION_ANCHORS` 与区序一一对应, 数量不符时多余锚点自动失效).
- `views/proxy/index.ts` 拆出 `sections.ts`(90 行)后才守住前端 500 行红线.
- 新增 `dashboard/css/settings.css`(左侧栏布局 + 分区显隐 + 窄屏回退), 在
  `dashboard/index.html` 挂一行 link. 这些类只有设置页用, 独立成文件让 base.css
  回到通用基础样式的定位(合并写会让 base.css 撞 500 行红线). 窄屏(<=820px)
  回退成横向可滚动标签条 ---- 手机上左侧栏会挤掉内容宽度.

## Evidence

真实浏览器端到端(Playwright + 本机 chromium, 本地实例 `127.0.0.1:18999`, 已登录):

```
== 登录后 ==
  导航项: ['总览', '设置', '测试对话', '用户管理', '系统', '日志', '我的']

== 切到设置页 ==
  分区数: 5
    {'id': 'section-upstream',   'title': '上游与工具',   'cards': 4}
    {'id': 'section-scheduling', 'title': '调度与额度',   'cards': 2}
    {'id': 'section-network',    'title': '网络与出口',   'cards': 1}
    {'id': 'section-models',     'title': '模型',         'cards': 1}
    {'id': 'section-advanced',   'title': 'settings.sectionAdvanced', 'cards': 1}
  边栏项: ['上游与工具', '调度与额度', '网络与出口', '模型', '高级(需重启)']
  grid-template-columns: 208px 1154px   (左栏固定 + 右侧内容)
  nav flex-direction: column            (竖排)
  默认 display: ['flex','none','none','none','none']
  点第 3 项后:  ['none','none','flex','none','none']
```

失败请求只有两处且都无害: `404 /version.json`(发版流水线产物, 本地无, 既有设计),
`401 /api/me`(登录前的身份探测).

门禁与测试:

```
node scripts/gates/run.ts     -> ALL PASS (17/17 条)
npm run verify-notes          -> all gates passed (coverage: 15 guarded paths with a note)
smoke-frontend                -> frontend smoke ok
tsconfig.dashboard.json       -> 58 处既存错误, 改动前后同为 58(未新增)
```
