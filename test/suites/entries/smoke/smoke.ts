/**
 * smoke 冒烟测试的入口.
 *
 * 本文件曾是一个 9329 行的单文件用例树; 现已按语义域拆进 harness/ 与 parts/.
 * 入口只保留三件事: 环境变量, 装 mock 上游, 以及按原顺序逐个 await import().
 *
 * 顺序 await import(): ESM 会把静态兄弟 import 的顶层 await 交错执行,
 * 那样"装 mock fetch"(原 stmt 33)与"startServer"(原 stmt 50)之间就没有先后保证,
 * 建 server 时的请求会直接打到真实上游.
 */

// 冒烟测试关闭 bun 通道: bun 侧每个动作都会先 fetchCatalog(), 而 mock 上游不响应
// /api/v1/freebuff/models, 会让"释放 / 注册"这类用例依赖回落的时序. 必须在任何
// 会读它的模块之前设置.
process.env.FREEBUFF_DISABLE_BUN = '1'

// 1) 装 mock 上游, 早于任何建 server 的模块(原 stmt 33 的位置).
const { installMockFetch } = await import('./harness/mock/core.ts')
installMockFetch()

// 2) 按原语句顺序逐个求值. 顺序即契约: 后面的用例块依赖前面块建立的 mock 模式
//    与热 session, 例如 stmt 126/127 先关掉主 server, 后面的块才各起自己的.
await import('./parts/units/hermes-delegate.ts') // unit: Hermes delegate_task 兼容别名
await import('./parts/units/free-mode.ts') // unit: free-mode 辅助
await import('./parts/units/gates.ts') // unit: 闸门错误码提取
await import('./parts/api/core/request-shape.ts') // api: 请求形态与工具剥离
await import('./parts/api/core/tool-strip.ts') // api: tool-schema 拒后剥离重试
await import('./parts/api/core/fingerprint.ts') // api: 请求指纹稳定性
await import('./parts/api/tools/tool-signature.ts') // api: 签名工具注入
await import('./parts/api/models/models-list.ts') // api: /v1/models 与鉴权
await import('./parts/api/models/special-models.ts') // api: 特殊模型世代绑定
await import('./parts/pool/tier/access-tier.ts') // pool: 档位与免费会话状态
await import('./parts/scheduling/session/fresh-session.ts') // scheduling: 强制新建会话路径
await import('./parts/scheduling/session/agent-fallback.ts') // scheduling: agent 兜底与退役
await import('./parts/scheduling/session/hold-stream.ts') // scheduling: 挂起流与放行
await import('./parts/scheduling/pick/drain.ts') // scheduling: 粘性优先调度
await import('./parts/pool/proxy/forward-proxy.ts') // pool: 转发代理
await import('./parts/pool/tier/multi-account.ts') // pool: 多账号与 rate_limit_a
await import('./parts/pool/takeover/takeover.ts') // pool: 槽位被占时接管复用
await import('./parts/pool/takeover/takeover-reject.ts') // pool: 接管的反例
await import('./parts/scheduling/tier/limited-tier.ts') // scheduling: limited 档位不是封锁
await import('./parts/scheduling/tier/country-block.ts') // scheduling: 地理封锁
await import('./parts/scheduling/tier/banned.ts') // scheduling: 账号封禁
await import('./parts/scheduling/tier/rate-limit.ts') // scheduling: 完成层限流与冷却
await import('./parts/units/config-defaults.ts') // unit: loadConfig 不得污染全局 DEFAULTS
await import('./parts/units/catalog-cache.ts') // unit: catalog 缓存落 dataDir
await import('./parts/web/bootstrap-admin.ts') // web: 管理员 bootstrap 报告真实结果
await import('./parts/scheduling/pick/round-robin.ts') // scheduling: 轮换开关
await import('./parts/scheduling/pick/sticky.ts') // scheduling: 粘性调度
await import('./parts/web/dup-email.ts') // web: 同邮箱不同 id 并存
await import('./parts/pool/proxy/account-proxy.ts') // pool: 账号专属出口优先
await import('./parts/pool/proxy/proxy-fetch.ts') // pool: 单代理池也必须走代理
await import('./parts/webapi/probe/fixture.ts') // web api 夹具
await import('./parts/webapi/probe/probe.ts') // web api: 账号探测与运行设置
await import('./parts/webapi/proxy/proxy.ts') // web api: 代理池与账号删除
await import('./parts/concurrency/quota/quota.ts') // quota: 额度提取与展示
await import('./parts/concurrency/quota/conversation.ts') // scheduling: conversation_id 不参与选号
await import('./parts/concurrency/session/hot-reuse.ts') // concurrency: 热 session 复用
await import('./parts/concurrency/session/sub2api.ts') // concurrency: 溢出换号
await import('./parts/concurrency/fault/err-500.ts') // concurrency: 500 整号冷却
await import('./parts/concurrency/fault/capacity.ts') // concurrency: capacity_deferred 不冷却
await import('./parts/concurrency/fault/agent-run-fail.ts') // concurrency: startAgentRun 失败
await import('./parts/concurrency/fault/network-err.ts') // concurrency: 网络层错误换号
await import('./parts/concurrency/fault/gate-twice.ts') // concurrency: 同账号连续 gate 失败
await import('./parts/concurrency/stream/stall.ts') // concurrency: 幽灵连接
await import('./parts/concurrency/stream/serial.ts') // concurrency: 账号并发上限
await import('./parts/spread/capacity-spread.ts') // spread: 关 spread + 上限 3
await import('./parts/spread/spread-mode.ts') // spread: 并发优先模式
await import('./parts/spread/timeline.ts') // spread: 账号时间轴与会话临近过期
await import('./parts/concurrency/stream/semaphore.ts') // concurrency: 并发信号量单元测试
await import('./parts/concurrency/stream/reconnect.ts') // concurrency: 全部断开重连与重启端点
await import('./parts/concurrency/session/re-admit.ts') // concurrency: 剩余时间阈值
await import('./parts/concurrency/stream/backpressure.ts') // concurrency: 下游背压与账号卡死
await import('./parts/teardown/shutdown.ts') // teardown: 主 server 下线
await import('./parts/openapi/import.ts') // open api: 账号导入与删除
await import('./parts/money/refund/fixture.ts') // freebucks 夹具
await import('./parts/money/life/paid-window.ts') // freebucks: 付费时段内不释放
await import('./parts/money/life/gates.ts') // freebucks: 两道闸门与扣费顺序
await import('./parts/money/life/budget.ts') // freebucks: 新会话预算
await import('./parts/money/life/queue.ts') // freebucks: 排队等 chat 锁
await import('./parts/money/refund/delete-refund.ts') // freebucks: DELETE 与退款语义
await import('./parts/money/refund/waiting-room.ts') // freebucks: 等候室与收尾
await import('./parts/billing/stall/copy-guard.ts') // billing: 全局请求闸门
await import('./parts/billing/source/dashboard-source.ts') // billing: 控制台源码扫描
await import('./parts/billing/source/copy-sweep.ts') // billing: 已被证伪的说法清扫
await import('./parts/billing/stall/agent-leak.ts') // billing: 客户端中断
await import('./parts/billing/source/client-guard.ts') // billing: 源码级防回归
await import('./parts/billing/data/data-audit.ts') // billing: 数据文件审计
await import('./parts/billing/data/json-store.ts') // billing: JSON store 边界
await import('./parts/billing/data/accounts-view.ts') // billing: 账号视图与源码守卫
await import('./parts/billing/stall/upstream-client.ts') // billing: 上游客户端
await import('./parts/teardown/teardown.ts') // teardown: 拆掉 mock 与临时目录
await import('./parts/protocol/wire/telemetry.ts') // protocol: CLI 遥测上报
await import('./parts/protocol/wire/device-signing.ts') // protocol: 设备签名
await import('./parts/protocol/model/catalog.ts') // protocol: 目录协议与模型清单
await import('./parts/protocol/model/mapping.ts') // protocol: 模型映射用 legacyDigests
await import('./parts/protocol/model/input-profile.ts') // protocol: 输入画像与代理描述
await import('./parts/protocol/view/i18n.ts') // protocol: 前端 i18n 词条一致性
await import('./parts/protocol/view/account-view.ts') // protocol: 账号视图与邮箱遮蔽
await import('./parts/refund/wire/upstream-401.ts') // refund: 上游 401 的真值
await import('./parts/refund/wire/log-buffer.ts') // refund: 日志环形缓冲
await import('./parts/refund/claim/claim-released.ts') // refund: purchase_claim_released 两段式
await import('./parts/refund/claim/heartbeat.ts') // refund: 心跳与结算
await import('./parts/refund/claim/join-order.ts') // refund: 并发 join 顺序
await import('./parts/refund/claim/capacity-codes.ts') // refund: 槽位类码只跳过不冷却
await import('./parts/refund/pool/inventory.ts') // refund: 上游会话清单
await import('./parts/refund/pool/burst.ts') // refund: 突发请求与全池买不起
await import('./parts/refund/wire/log-window.ts') // refund: 日志窗口
await import('./parts/refund/pool/reuse-paid.ts') // refund: 复用已付费会话
