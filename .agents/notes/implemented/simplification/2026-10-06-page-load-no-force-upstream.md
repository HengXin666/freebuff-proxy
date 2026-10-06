# Agent Note: 页面加载不得 force 抓上游 ---- 设置页 1.81s 卡顿的真因

Status: implemented

## Problem

用户报[设置页打开要加载半天]. 实测(Playwright, 到首个 section 出现): **1.81 秒**.

第一反应是 Monaco(3.7MB) ---- 它确实在进设置页时被同步加载. 但测量否掉了这个判断:
设置页加载期间**新增 .ts 模块 0 个, vendor 资源请求 0 个**, 而慢的是另一处.

用浏览器侧接口计时定位到单一元凶:

```
/api/models/upstream    1660 ms     <- 其余接口全部 < 3 ms
```

读它的实现(upstreamModels): 页面加载调的这个接口会 refreshCatalogs({ force: true })
**强制抓上游目录**, 再 probeAllAccountsSession **刷一轮会话** ---- 两跳都打上游.

## Decision

给该接口加 ?cached=1: **只读本地目录缓存, 既不 force 抓目录也不刷会话**.
页面加载(dashboard/views/models/index.ts)改用它; [同步上游模型]按钮保持原样(裸调用 = force).

理由不是[优化], 而是**它本来就违反本仓的[零自动探测]约定**(docs/reverse/20): 页面加载属于自动
行为, 只有用户主动刷新时才准打上游. 所以这里既修了性能也修了纪律.

实测效果: 设置页 **1.81s -> 0.054s**(接口全部回到 1-2ms).

同时把 Monaco 改成**点击才加载**(先渲染等宽只读预览 + [展开编辑器]按钮), 这样即使将来接口变慢,
重资源也不会叠加在首屏.

## Alternatives considered

**什么都不做, 靠用户理解[第一次慢是正常的].** 否决: 1.8 秒是[量级]问题不是抖动, 且它每次都发生
(force 抓目录没有节流). 用户明确要求[秒开], 这是合理的硬要求.

**给接口加节流(如 60 秒内复用上次结果).** 否决: 治标 ---- 仍然会在每个新窗口/新会话上打一次上游,
而[页面加载不打上游]这条纪律本身就要求**绝不**而不是**少打**.

**把 Monaco 从设置页彻底拿掉, 换成 textarea.** 否决: 用户明确要求 VSCode 同款编辑器. 懒加载
已经消除了它对首屏的影响 ---- 不必牺牲能力.

**前端加载时先读缓存, 后台再 force 刷新一次.** 否决: 后台刷新仍属自动打上游, 与纪律冲突;
而且用户没要求[自动保持最新], 提供[同步]按钮已经够了.

## Consequences

- /api/models/upstream 支持 ?cached=1; 页面加载走它, 按钮走 force.
- handleList 签名多一个 req 参数(为读 query), 域分发同步透传.
- Monaco 懒加载: dashboard/lib/editor.ts 不变, 由 views/proxy/inject/system-prompt.ts 在用户
  点击时挂载.
- 新增 e2e 套件 test/suites/entries/e2e/dashboard-latency.ts 钉死两条判据:
  进设置页不得加载 Monaco, 页面加载不得 force 抓上游. 破坏实测 exit=1.