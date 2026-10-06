# test/AGENTS.md -- 测试约定

> 只讲[动 test/ 时才知道的事]. 通用约定见根 [AGENTS.md](../AGENTS.md).

## 测试时机(最重要, 硬性)
**只在[全部改完, 提交前]跑一次最终测试.** **禁止**[改一个文件跑一次]的循环 ---- 那是效率杀手.
例外只有两个: 用户明确要求, 或**验证判据可证伪**(那只跑单个套件).
- 查语法/类型用 `npm run typecheck`(秒级); 查单条门禁用 `node scripts/gates/run.ts <lane>`.
- **不要**拿全量测试当语法检查器(全量要 2 分钟以上).

## 怎么跑
```bash
npm test                      # 全部套件
node test/run.ts              # 同上
node test/run.ts <套件名>      # 只跑一个(名字见 run.ts 的 SUITES)
npm run test:smoke            # 只跑 smoke
npm run test:catalog          # 只跑目录套件
```

## 套件注册
**唯一注册表 = `test/run.ts` 的 `SUITES` 数组**, 格式 `['名字', 'suites/entries/<域>/<文件>.ts']`.
新增套件 = 写文件 + 在这里加一行(漏了这一步等于没写).

## 目录职责
| 路径 | 放什么 |
|---|---|
| `suites/entries/smoke/` | 冒烟: mock 上游跑通主链路(session 复用/并发冷启动/冷却换号/代理池/probe) |
| `suites/entries/verify/` | 判据类: 契约, 映射, 参数翻译, 前端组件结构断言 |
| `suites/entries/e2e/` | 端到端: **前端页面加载速度**等需要真服务/真浏览器的断言 |
| `helpers/` | 夹具: `dom-stub.ts`(轻量 DOM 桩), `mock-routes.ts` |
| `fixtures/` | 数据夹具(如 `dsh-tools.json` = 真实客户端工具形态) |

## 写判据的纪律
- **断言必须可证伪**: 写完测试后**临时破坏实现**, 确认它变红, 再还原. 不这么做就等于没测.
- 断言消息要说清[期望 vs 实际], 带上数字(如 `got ${n}`).
- 前端组件的结构性断言用 `helpers/dom-stub.ts`: 它是**真记账**的迷你 DOM(数得出节点个数),
  与 `smoke-frontend.ts` 的[万能 Proxy 桩]不同 ---- 后者只能抓 TDZ, 数不出[多了一个节点].
  2026-10-06 的[签到警告条重复堆积]缺陷就是靠它抓到的.
- 涉及时间/随机的地方, 让被测对象**接受注入**(如 `now` 参数), 不要在测试里 sleep 等.

## e2e 与前端加载速度
`suites/entries/e2e/` 守护**页面加载速度**: 首屏, 设置页, 系统提示词页各有阈值断言, 且断言
[进设置页不得加载 Monaco](懒加载的守护 ---- Monaco 3.7MB, 进页就加载会让整页卡 6-8 秒).
改 `dashboard/**` 或静态资源加载方式后, 提交前必须跑它.
浏览器不可用时**降级成 HTTP 计时**并把降级事实写进文件头, 不要让它因此失败.
