# 核心约定

> 用户明确强调: **不要每次来回折腾, 不要浪费用户时间**.一次说清, 一次做对.

## 本文件规则 (硬性)
1. **禁止未经允许编辑本文件**: 未经用户明确指示, 不得修改任何 AGENTS.md.
2. **记忆禁止写回**: 过程记忆/运行状态/功能清单/教训日志一律落盘到 `data/`,`docs/`, 严禁写入
   AGENTS.md.这里只放开发约定.
3. 本文件 ≤150 行.新增约定需先征得用户同意, 并压缩替换旧内容.

## 渐进式上下文(先读你所在目录的)
| 你要动 | 先读 |
|---|---|
| `src/` 后端逻辑 | [src/AGENTS.md](./src/AGENTS.md) |
| `dashboard/` 前端 | [dashboard/AGENTS.md](./dashboard/AGENTS.md) |
| `cli-bridge/` bun 侧 | [cli-bridge/AGENTS.md](./cli-bridge/AGENTS.md) |
| `test/` 测试 | [test/AGENTS.md](./test/AGENTS.md) |
| `scripts/` 门禁工具 | [scripts/AGENTS.md](./scripts/AGENTS.md) |
| `docs/` 文档 | [docs/AGENTS.md](./docs/AGENTS.md) |

## 项目定位
OpenAI 兼容的 Freebuff 免费额度反向代理

### 定位红线(用户明确裁决, 永久有效)
- **BYOK 永久禁止**: 不得实现自备 key 通道(provider=`openrouter`/`openai-compatible`), 代码/提案/文档里都不得把它当出路重提(官方源码里存在 `normalizeByokBaseUrl` 也不得据此提出).
- **只做免费链路**, 不绕道第三方 provider. **只做用户当前要求的任务**, 不顺带提替代方案.

## 语言与运行时
- **全仓 TypeScript, 零 `.js`/`.mjs`/`.cjs`**: Node 22 原生直跑, 不引入打包器/转译器. 引用本仓
  文件**一律写 `.ts`**. **禁止新增运行时依赖**(现仅 `undici`/`yaml` 两个).
- 前端 `dashboard/**` 是 `.ts` 源, 由 `src/web/static.ts` 用 `stripTypeScriptTypes` 剥类型后直投浏览器

## 铁律(用户明确要求)
1. **轻量优先, 禁止加无用东西**: 镜像 = `node:22-alpine` + 仅 2 个运行时依赖, 保持现状.
   `docker-compose.yml` 保持最小(`image`/`container_name`/`restart`/`network_mode`/`environment`/
   `volumes`), 默认 `image: ghcr.io/hengxin666/freebuff-proxy:latest`, `build: .` 仅本地/离线场景.
   **禁止**: `NETWORK_MODE` 变量, `init`, `extra_hosts`, `stop_grace_period`, 重复 healthcheck.
2. **网络模式 host**: `network_mode: host`, **host 下禁止写 `ports`**(`-p` 被忽略并告警). 应用监听宿主
   `0.0.0.0:${PORT}`, 经 `FREEBUFF_PROXY_PORT` 生效. 本机代理在控制台[代理设置]填 `http://127.0.0.1:<端口>`.
3. **一切配置走前端页面, 禁止让用户改配置文件**: `config.yaml` 只作兜底默认值, 不是日常入口.
   用户原话: "正常人谁会天天改配置, 都是在前端页面操作的."
4. **不要向用户索要配置, 不要反复折腾**: 遇环境差异先自查代码/文档/日志, 能自己验证的自己验证再给
   结论. 不把问题丢给用户.
5. **数据全在 `/data`**(挂载宿主机 `./data`), 删容器不丢数据.

## 代码质量红线(17 条门禁, 违反即返工)

任务完成后, 再跑测试. 禁止编辑一个文件就直接测试 [低效率]

```bash
node scripts/gates/run.ts          # 全部 17 条 · node scripts/gates/run.ts <lane> 按 lane 跑
```
- **体量**: 后端 ≤300 行/文件, 前端 ≤500 行/文件, 同目录 ≤5 个受控文件(唯一例外 `src/` 顶层 12 个,
  已知且故意保留). **结构**: 单函数 ≤80 行; 导出符号必须有 JSDoc 且 `@param`/`@returns` 与签名一致.
- **注释只写[这个是做什么的]**: 禁止写[为什么/所以/决策] ---- 那些属于 `notes/` 与 `docs/`, 用链接指过去.
- **文本**: 注释与文档禁全角标点(逐文件棘轮, 只许降), 禁 emoji/颜文字, 注释里禁 markdown 语法;
  格式六条(缩进/行尾/末尾换行/BOM/CRLF/行宽 ≤120).
- **棘轮**: `.gates/*.json` 是"有多严"的基线, 只许降不许涨; 重录唯一入口是门禁 `--update`(语义是
  "承认这次变化"), 且必须说明理由. **纪律**: 断言必须**可证伪** ---- 写完测试后临时破坏实现, 确认它
  变红, 再还原.

## 测试时机(硬性)
**只在[全部改完, 提交前]跑一次最终测试.** **禁止**[改一个文件跑一次]的循环 ---- 那是效率杀手.
例外只有两个: 用户明确要求, 或验证判据可证伪(那只跑单个套件).
查语法/类型用 `npm run typecheck`(秒级)与 `node scripts/gates/run.ts <lane>`(单条门禁).
提交前全过: `npm test` + `npm run typecheck` + `npm run check:gates` + `npm run verify-notes`.

## 验证方法论(硬性)
结论必须来自**实测**(远程日志 / 直连上游回执 / 单变量对照), 不得只凭源码推断 ---- 本仓已多次出现
"源码看起来该如此, 实测相反".

## 按症状查文档(先读这里, 再动手)
> 路径相对仓库根; `notes` 指 `.agents/notes/implemented/`; 文档总入口 = `docs/README.md`.

| 症状 / 场景 | 先读 |
|---|---|
| 模型名/标识对不上, 映射错模型 | `docs/reverse/19-catalog-is-the-model-list.md` + `notes/architecture/2026-10-04-model-name-three-layers.md`. **唯一真源** = `CatalogHolder.keyForName`. 禁止另写映射 |
| 余额不足 / 有额度却 429 / 有会话不复用 | `notes/architecture/2026-10-04-session-inventory-from-upstream.md` |
| 上游 503 / "model is temporarily unavailable" | `docs/reverse/07-503-root-cause.md` |
| 账号被封 / 排查封禁原因 | `docs/reverse/06-ban-forensics.md`, `docs/reverse/08-second-ban-and-byok.md` |
| 工具集 / 客户端自带工具 / foreign client 警告 | `docs/reverse/18-channel-guide-and-tool-mapping.md`, `docs/reverse/04-chat-and-tools.md` |
| session 建不起来 / purchase_capacity | `docs/reverse/03-session-admission.md`, `docs/reverse/12-waiting-room-slot-contention.md` |
| 付费时段不能换模型 / 早退退不退款 | `notes/architecture/2026-09-14-paid-hour-hold.md` |
| 请求头/形态与官方不符, 通道选择 | `docs/reverse/21-client-request-reference.md` |
| 该不该发请求给上游(零自动探测) | `docs/reverse/20-upstream-endpoint-whitelist.md` |
| 门禁红了 / 棘轮怎么用 | `docs/quality/code-quality-landscape.md` |

## Agent Notes -- 决策记录
非平凡改动(行为/架构/跨文件契约/流程/落盘格式)必须在**同一次提交里**新增或更新一篇 note.
- **改声明前先找它旁边引用的 note**, 先读它记着否决过什么.
- **一篇 note 只管一条决策**; 事实移动就地重写, 绝不改写成另一条决策 ---- 要取代就双向互链.
- 每篇 active note 必带 `## Alternatives considered`, 其中必须有"什么都不做/复用现有".
- 推送前跑 `npm run verify-notes`. 受保护源码改动无 note 会 fail; 刻意豁免写 `.agents/notes/NOTE-EXEMPT.md`.
  规则细节见 `.agents/notes/AGENTS.md`.
