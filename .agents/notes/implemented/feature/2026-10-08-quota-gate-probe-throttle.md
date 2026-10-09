# Agent Note: 额度闸门的接管探测必须退避;拦截日志必须限频

Status: implemented

## Problem

额度不足的账号仍参与逐账号尝试, 同一邮箱也可能对应多个候选.
这容易被理解成[没有跳过不可用账号], 而逐账号的上游探测与拦截日志需要明确的成本边界.

### Quota ranking and gating

- candidates.ts 只排序: 额度耗尽/买不起的账号排到末尾, 不从候选中剔除.
- acquire.ts 逐账号调用 account-gates.ts 的额度闸门. 候选保留使整池耗尽时能返回
  freebucks_exhausted / units_exhausted, 并保留已付费会话接管路径.
- 两本额度账由本地会话回执驱动并刻意 fail-open: 缺少模型 units 行或 freebucks 块时
  known: false, 不拦截; daily.resetAt 已过时 stale: true, affordable: true, 放行.

### Upstream probe cost

闸门即将拒绝时, makePaidUpstreamChecker 检查可接管的已付费会话:
balance: 0 只说明[再买一条买不起], 不说明已付费的一小时不可用.
本地没有持有者且允许探测时, rt.sessions.refresh() 可执行只读 GET /session.
有在途请求时 refresh() 跳过上游访问并置 lastProbeSkipped, 不产生网络往返.

没有退避时, 重复满足探测条件的请求会逐账号支付串行上游往返的成本,
全部发生在首字节之前. 这个成本来自实际探测, 不是本地候选排序.
逐请求逐账号记录额度拦截日志也会反复输出同一结论.

### Same-email identities

账号 key 优先使用 Freebuff 用户 id. GitHub / Google 同邮箱登录可对应不同 key,
各有独立额度与冷却, 因此列表和调度中有多个同邮箱账号并不表示身份重复或覆盖.
仅凭邮箱日志无法区分这些独立候选, 控制台需要明确标注.

## Decision

### Paid-session probe backoff

- rt.paidProbeRetryAt 属于 runtime, 初始为 0, 不是请求级 state.
  实际尝试上游刷新完成后, 无论成功失败, 设置为当前时间 + PAID_UPSTREAM_PROBE_RETRY_MS(60_000ms).
- rt.paidProbeInFlight 初始为 null, 同一 runtime 的并发探测共享一个刷新 Promise,
  完成或失败后清为 null. 共享值只表示刷新未抛异常(包括跳过刷新), 不表示模型是否有持有者;
  每个等待方在刷新完成后独立检查自己请求模型的 holderFor(model).
- holderFor(model) 的本地快照必须先于重试时间检查, 窗口内仍可接管已知持有者.
  若窗口挡住本地快照, 已付费的一小时会被当成不可用, 请求可能转向别的账号重买.
- lastProbeSkipped=true 的共享刷新不得开窗: 它没有访问上游, flight 清理后不留退避;
  在途请求或其他跳过条件结束后必须能立即真正探测.
- 窗口只挡重复网络探测, 不挡首次探测. 成功也开窗, 因为已获得的结果无需重复询问.
- 改代理 / 换 token 导致 runtime 重建时窗口归零且 flight 为 null, 新运行时可重新探测.
- 探测失败降级为 false 并按共享 flight 记一次 warn, 继续使用 freebucks_exhausted 或 units_exhausted
  的具名闸门结论, 不向调用方抛出探测错误.

### Quota-skip log throttling

skipLogOnce(self, key, code, msg, fields) 在账号池内按(账号 key, 闸门码)限频 60s,
窗口内沉默, 窗口外可再记一条. 日志保留对应账目字段, 窗口表不持久化到额度账本.

- 窗口只记录实际输出的 info: 使用与 log 相同的级别判断, 被 warn/error 阈值过滤时
  返回 false, 不创建或更新窗口表; 无 self 的直接输出回退也遵守这个判断.
- 只有 info 输出完成后才写入窗口时间戳. 恢复 info 后此前被过滤的键可立即输出首条.
- 必须先检查已有键是否未过期, 再进行容量清理.
- SKIP_LOG_MAX=512 是窗口表上限: 表大小 >=512 时, 插入前只回收过期条目.
  回收后仍 >=512 则跳过本次日志及新键插入; 实现保证表大小 <=512.
- 保留未过期窗口, 不为新键淘汰最旧条目, 因为淘汰会让被删键在同一窗口内重复输出事件.
- 饱和表可能遗漏新键的首条拦截日志. 这是容量有界且保护已有窗口的代价,
  不是[每个账号必有首条日志]的保证.

### Same-email account identity

- readAccountUser 兜底扫描优先级为精确账号 key > 规范化/小写 key > 邮箱匹配.
  同档只按 accountKeyOf 升序, 不按文件名或是否已在目标文件名上排序; 多候选时记 warn.
- 迁移到 <accountKey>.json 不得改变重复邮箱查询选中的身份.
  按文件名打破平局会使迁移前后选择不同账号.
- 同一邮箱在池内出现多行时, 所有这些行都带[同邮箱]徽章; 唯一邮箱不带.
  不合并不同 key 的独立账号.

## Alternatives considered

- **把已知额度不足的账号从候选里剔除** ---- 看起来最直观,但会破坏两条既有语义:
  (1) [整池耗尽 -> freebucks_exhausted / units_exhausted 具名错误码]会退化成笼统的
  no_available_account(对[等每日池刷新]的用户是信息损失);
  (2) 接管探测**本来就是为[本地买不起但上游有已付费会话]设计的**,剔除候选等于
  把这条路径关掉.现有用例(quota.ts)也把[排到末尾]钉死为预期.
  真正的问题不是[试了], 是无退避时实际探测的串行上游往返成本.
- **什么都不做 / 只复用本地排序** ---- 无额外窗口状态, 但排序不限制网络探测或日志频率.
  重复满足探测条件的请求仍逐账号执行串行 GET, 同一额度结论仍逐请求输出 skip 日志.
- **把探测降到只在控制台手动触发** ---- 转发路径没有探测成本, 但会丢掉自动接管的能力,
  那正是 reuse-paid-session 定下的行为.
- **按账号写[下次探测时间]到账本(持久化)** ---- 重启后仍生效,但把一个纯调度优化
  写进账本会引入落盘写放大与格式迁移;runtime 级窗口足够覆盖[高并发时段].
- **把 skip 日志直接降到 debug** ---- 默认日志更安静, 但 info 下完全看不见[什么时候开始被挡],
  排障就缺少这条线索. 限频在容量允许时保留了可观测性.
- **同邮箱账号合并成一个身份** ---- 列表更简单, 但会把两个独立的 Freebuff 账号(各自独立额度与冷却)
  合成一个,等于凭空丢弃一个号的额度.标注比合并正确.

## Consequences

- **重复网络探测受窗口约束**: 每个 runtime 的首次真实探测完成后开窗,
  60s 内无需为同一额度结论重复询问上游; 已知持有者仍可接管, 跳过刷新不会延迟下一次真探测.
- **探测退化路径**: 上游连不通时记录 warn 并按闸门结论继续,
  用户看到 freebucks_exhausted 或 units_exhausted, 而不是探测异常.
- **会话发现延迟**: 退避可能使别的部署新建的可接管会话晚至 60s 被发现.
- **日志量与遗漏**: 每 60s 每(账号 key, 闸门码)最多一条 skip 日志.
  容量饱和时新键的首条也可能被省略, 排障不能依赖所有账号都有首条记录.

## Evidence

- test/suites/entries/smoke/parts/pool/takeover/probe-backoff.ts 使用刷新替身计数:
  1. 首轮两个账号各探测一次(共 2 次), 全池买不起时抛出错误;
  2. 窗口内 5 个请求不增加探测次数;
  3. rt.paidProbeRetryAt 大于当前时间, 手工归零后允许再次探测;
  4. 4 个请求对两个账号的 skip 日志按(账号, 码)至多一条, 总数 <=2 且至少一条;
  5. 首次探测发现持有者并开窗, 窗口内第二次 checker 仍返回 true, 不增加探测次数.
- test/suites/entries/smoke/parts/pool/takeover/probe/skip-window.ts 使用刷新替身验证:
  lastProbeSkipped=true 时 retryAt 保持 0; 跳过条件结束后可立即真正探测并开窗;
  紧接着再次调用 checker 不刷新, 由直接计数断言保证.
- test/suites/entries/smoke/parts/pool/takeover/probe/concurrent.ts 使用 deferred 刷新替身验证调度:
  1. 十个独立 checker 在刷新完成前只调用一次 refresh, 不提前返回或设置退避时间;
  2. 共享刷新后仅模型 A 的持有者命中, 模型 B 不复用 A 的结果, flight 清为 null;
  3. 实际刷新成功或失败均在完成后只更新一次窗口, 窗口内不再刷新, 本地已知持有者仍可接管;
  4. 失败的十个并发等待方全部返回 false, 共享 flight 清空后立即调用仍退避;
  5. 跳过的共享刷新零窗口更新且清理 flight, 下一波十个请求立即共享一次真实刷新,
     合计两次刷新后仅更新一次窗口, 紧接着调用不再刷新.
- test/suites/entries/smoke/parts/pool/takeover/skip-log-throttle.ts 对 600 个不同 key
  断言窗口表大小 <=513 且最旧的未过期键 k0 保留. 测试容许阈值多一项,
  实现则在 512 回收阈值处拒绝仍满时的插入, 上限为 512.
  测试显式启用 info, 捕获 console 输出并在 finally 恢复日志级别与 console.
  warn/error 下返回 false 且不创建窗口表, 无 self 回退也无输出;
  恢复 info 后相同键立即输出一条, 窗口内重复调用返回 false 且不增加输出.
- test/suites/entries/verify/auth/duplicate-email-resolve.ts 不访问网络:
  同邮箱身份独立落盘, 按 id 精确命中, 重复邮箱读取稳定.
  文件名与账号 key 顺序相反时稳定选择 id-aaa, 迁移前后不换身份.
- test/suites/entries/verify/dashboard/accounts/same-email-badge.ts 使用 DOM 桩:
  同邮箱两行或三行全部带徽章, 唯一邮箱不带徽章.

### Falsifiable counterfactuals

- 删除重试时间检查会违反[窗口内 5 个请求不得增加探测次数]的断言.
- 绕过 skipLogOnce 直接输出 info 会违反[同一(账号, 码)窗口内至多一条]的断言.
- 多候选凭据返回 null 会违反[邮箱兜底扫描必须给出确定结果]的断言.
- 同邮箱计数为空会违反[同邮箱各行都挂徽章]的断言.
- 凭据平局按文件名排序会违反[选择 id-aaa 且迁移前后身份稳定]的断言.
- 表满仍插入会违反容量断言; 表满淘汰最旧项会违反[未过期 k0 保留]的断言.
- 被跳过的刷新也开窗会违反[retryAt 保持 0 且随后立即允许真探测]的断言.
- 窗口内 checker 恒返回 false 会违反[已记录持有者仍能接管]的断言.
- 绕过 runtime flight 共享会违反[十个并发 checker 只调用一次 refresh]的断言.
- 共享模型 A 的持有者结果会违反[模型 B 无持有者时返回 false]的断言.
