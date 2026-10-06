# Agent Note: 官方工具卡整份列表必须独占卡片整行 (不可与说明共处一条 flex 行)

Status: implemented

## Problem

设置页 官方工具 卡有 37 个勾选项, 但列表被挤到卡片右缘一条 583px 的窄柱里, 左侧留出约
500px 空白(用户连续五个版本都在抱怨"很难看", 却一直被当成配色问题处理).

根因不是列表自己的宽度约束, 而是**卡片这一层 flex 的行分配**:

- 卡容器是 `class="card settings-band"`, 而 `.settings-band` 是
  `display:flex; justify-content:space-between; flex-wrap:wrap`(见 `dashboard/css/base.css`);
- 卡片里的直接子节点依次是 [卡头行] [生效时点行] [勾选列表];
- 前两个子节点都小于整行宽, 于是它们与列表**被排进同一条 flex 行**; `space-between`
  再把列表推到行的末端 ---- 列表宽度本身没变, 位置被挪了.

单变量钉死(Playwright, 同一次会话内只改一个属性):

| 操作 | `.official-tools-body` 的 x / 宽度 |
|---|---|
| 原样 | 950 / 583 |
| 仅把卡片 `display` 改 `block` | **297 / 1236** |
| 改回 | 950 / 583 |

297 = 卡片左缘 + 18px 内边距, 1236 = 卡片内容宽. 同一节点, 同一份 DOM, 只换显示模型,
位置就归位 ---- 与 `.official-tool-item` 的 `grid-template-columns` 无关.

## Decision

让大块内容**独占整行**, 而不是去调列表自己的宽度.

- `dashboard/css/base.css`: `.settings-band` 上加 `.settings-band > .official-tools-body
  { flex: 0 0 100%; }`(空名单警告同样处理);
- `dashboard/views/proxy/inject/official-tools.ts`: 生效时点并入卡头说明块, 列表成为卡内
  最后一块, 不再与任何小元素共享 flex 行.

判据落在 `.settings-band` 的使用规则上, 不是"这张卡特殊": 只有"一行内两个元素"的卡
(标签 + 开关)才适合 `space-between`; 多块纵向内容的卡必须让内容独占行. 那条规则连同
本次实测数字一起写进了 `base.css` 该类的注释.

## Alternatives considered

- **给列表写 `width: 100%` / `flex: 1`** ---- 治不了: `space-between` 分配的是行内主轴,
  列表已经在行内被推到末端, 变宽只会让它从右缘往左长, 仍然不左对齐; 而且它一旦变宽会
  把同一行的说明文字压成竖排.
- **把 `.settings-band` 全局改成 `display:block`** ---- 一次性解决本卡, 但会拆掉其余 7 张
  开关卡的[标签左 / 开关右]两端对齐(那些卡确实只有一行), 属于拿一个更贵的问题换一个便 宜的.
- **只改这张卡: 去掉 `settings-band` 类, 换成普通 `.card`** ---- 可行且最小, 但把"这张卡
  为什么不跟着同类卡片走"变成一条隐式例外; 下一个改这张卡的人会以为漏了类, 顺手加回去.
- **什么都不做(把这当成配色问题)** ---- 这正是前五个版本的净结果: 37 行挤在窄柱里读不了,
  用户每次都要重新报一遍同一个问题.

## Consequences

- 列表 / 空名单警告 / 卡头 / 说明全部左对齐到卡片内容区, 实测列表宽 1236 = 卡片内容宽
  (卡片 1274 - 2 x 18 内边距), 行宽 1226.
- 37 行在同一列里按行高 34px 排布, 窄屏(760px)下无横向滚动.
- `.settings-band` 的适用边界现在写在注释里: 它是[一行两元素]的形状, 不适用于纵向多块.

## Testing

Playwright 实测(1600x1000, admin/admin12345, `#settings` -> 官方工具):

- 列表 x=297(卡片左缘 278 + 18 内边距), 宽 1236, 与卡片内容区等宽; 无横向滚动.
- 交互实测: 点名字切换勾选后 `is-on` 与进度数字同步(勾选 10 -> 9); 组内[全不选]后
  进度为 0 且 0 行高亮, [全选]后回到 10.
- 保存路径用 stub 的 `/api/settings` 实测: 提交 [5 个名字] 后回读显示
  [已配置: 注入 5 个], 勾选 5 行 / 高亮 5 行 / 进度 5; 提交 [] 后显示
  [已配置: 一个都不注入] 且空名单红字警告出现(此前该警告只在首屏渲染时才会出现).
- 三态首屏实测: `officialToolNames=[]` -> 红字警告 + 0/37; `null` -> 无警告 + 10/37.
- `node scripts/gates/run.ts pre-commit` 全绿; `npx tsc -p tsconfig.dashboard.json --noEmit`
  对本文件零错误.
