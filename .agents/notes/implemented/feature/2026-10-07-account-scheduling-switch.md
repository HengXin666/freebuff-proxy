# Agent Note: 每账号[调度]开关 -- 指定只调度某几个账号

Status: implemented

## Problem

账号池一直是[全体参与粘性调度]: 用户能做的只有删除账号或手动[解除冷却],
没有"这个号暂时别用, 但先留着"的表达方式.

真实诉求(用户原话: 支持一下指定调度某个账号, 也就是给每 1 个账号添加 1 个开关):
多账号场景下要能钉住一组"只用这几个号", 其余账号留在池里备用 ---- 既不是删号
(凭据要留着), 也不是冷却(冷却会到期自愈, 表达不了"别用它"这个意图).

## Decision

每个账号一行[调度]开关, 默认参与. 真源是账本 `account-state.json` 里的
`accounts[<key>].schedulingEnabled`(缺字段 = 参与, 所以升级不改变既有行为).

读写只有一个入口: `src/context/sched/account-schedule.ts` 的
`schedulingEnabled(key)` / `setSchedulingEnabled(key, on)`. 选号
(`candidateKeys`) 在筛完 skipKeys 之后, 判冷却之前把关闭的账号整个跳过 ----
是被筛掉, 不是排到最后: 显式关掉一个号是[别用它], 不是[没别的可用时再用它].

换号/同号重试两条路径(`_reacquireAfterGateUnlocked` 的续用分支, 
`_retrySameAccount` 的复用分支)也走同一道判据, 否则重试会把已关闭的账号
重新拉回来.

开关只改选号资格: **不动会话句柄**, 不 DELETE 也不 admit,
所以关掉一个正在占着已买断一小时的账号, 那一小时照旧保留到自然过期.

接口: `POST /api/accounts/:key/scheduling` body `{enabled}`(管理员).
控制台: 账号表[状态]与[Session]之间新增一列, 管理员可点, 普通用户只读;
关闭的账号排在所在分区末尾(仍在原分区 ---- 开关不改变"它现在什么处境").

见 .agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md
(关开关为什么不顺手释放会话).

## Alternatives considered

- **什么都不做, 让用户删号再导入**: 最省事, 但删号会连凭据/账本记录一起清掉,
  重新加回来要重新走浏览器登录; 而且"临时别用"与"不要这个号"是两件事. 否决.
- **复用冷却**: 把 `markCooldown` 当成人为关闭用. 冷却会到期自愈,
  且它会污染 `cooldownCode` / 控制台[出现警告]分区 ---- 用户主动关掉的健康号
  会被显示成"限流/风控". 否决.
- **只做前端过滤**: 前端把行隐藏掉. 但选号在服务端, 隐藏 UI 不改变任何调度行为,
  下游请求照旧落到那个号上. 否决.
- **加进全局设置页(settings.json 一份名单)**: 与[一切配置走前端页面]不冲突,
  但名单与账号生命周期会脱钩 ---- 删号要清名单, 导入同 id 的号会继承旧状态.
  落在账本里则天然随 `forgetAccount` 一起清. 否决.
- **排到最后而不是筛掉**: 粘性调度下"最后一个候选"在别的号都满员时仍会被选中,
  表达不出[别用]; 用户要的是排除, 不是降级. 否决.

## Consequences

- 升级零行为变化: 账本里没有该字段的老账号一律按参与处理.
- 关掉池内所有账号时, `candidateKeys` 返回空数组, 此时
  `collectCooldownFailures` 会照旧走 429 分支(失败明细为空, 落回
  `no_available_account`). 用户看到的仍是"没有可用账号", 不是静默挂起.
- `buildAccountRow`(`src/context/ops/account-list.ts`)与前端
  `buildAccountRow`(`dashboard/views/overview/accounts/row.ts`)都是体量棘轮里
  的存量超限函数, 为放下这一列各抽了一个具名函数(`ledgerFields` /
  `sessionMetaRows` / `schedulingCell`), 水位只降不涨.
- 关开关不会释放会话: 已买断的一小时留着, 下次打开开关即复用, 不重新计费.

## Testing

`test/suites/entries/smoke/parts/scheduling/pick/switch.ts`: 关闭的账号不进候选, 
控制台行带该字段, 重新打开即回候选, 落盘并在新 AccountRuntimes 里读回.
反向探针(实测过): 删掉 `candidates.ts` 里的 `this.schedulingEnabled(key)` 那一行,
该用例立刻变红.

`test/suites/entries/verify/dashboard/account-scheduling-switch.ts`: 每行一个开关, 
状态取自后端字段, 点击走保存链, 非管理员禁用, 关闭的账号排分区末尾.
反向探针(实测过): 把勾选判据改成恒 true, 该用例立刻变红.
