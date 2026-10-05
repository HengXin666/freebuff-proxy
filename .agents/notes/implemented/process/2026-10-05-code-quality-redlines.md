# Agent Note: 代码质量红线（六条硬标准 + 四类元门禁）

Status: implemented

受影响代码: `scripts/gates/**`（全部判据）、`.gates/**`（棘轮基线/白名单/指纹）、
`.git/hooks/pre-commit`、`.git/hooks/pre-push`、`.github/workflows/docker-image.yml`、
`package.json`

## Problem

用户下了七条硬标准（后三条是第二轮追加的）：

1. 后端每文件 ≤300 行；
2. 前端每文件 ≤500 行；
3. 同一目录的受控文件 ≤5 个（超过必须拆子目录）；
4. 函数长度限制；
5. 注释规范限制；
6. 格式化限制；
7. 类型标注限制。

取证时的现状：**一条都没有机械判据**。

- 体量：`src/app-context.ts` 2803 行 / `src/proxy.ts` 2788 行 / `src/session-manager.ts` 2280 行 /
  `dashboard/app.ts` 4000 行 / `test/smoke.mjs` 9330 行；25 个受控文件超各自档位上限。
- 目录：`src/` 12 个文件、`test/` 11 个、`scripts/` 9 个、`src/upstream/` 9 个、`src/web/` 8 个
  都超过 5。
- 函数：1874 个函数里 93 个超 50 行、37 个超 100 行，最长 `createProxyHandler` **2109 行**。
- 注释：`tsconfig.json` 是 `allowJs: true` + `checkJs: false` —— 等于**解析 JS 但不检查**，
  这是"配置已存在但从不执行"的典型形态（不是"没有配置"，更难发现）。
- 格式：没有 formatter，也没有任何格式判据。

比"缺判据"更危险的是**缺自证**：本仓已有 CI（test / i18n / contract / image-boot / check-version），
但没有任何机制能回答"这些门禁还跑不跑、还是不是原来那么严"。

## Decision

建一套**六条硬标准 + 四类元门禁**，全部零新增运行时依赖（本仓铁律：镜像只带
`undici` / `yaml`）。

### 一、判据真源唯一

`scripts/gates/rules.ts` 是唯一的阈值/分档/白名单语法来源，所有 `check-*.mjs`
只能从它取常量。同一组数字写进两处之后，改一处忘一处就会变成"文档说 300、脚本判 500"，
而两边都看起来是对的。

- 后端档 ≤300 行、前端档（`dashboard/` 前缀）≤500 行、目录 ≤5 文件、函数 ≤80 行、行宽 ≤120。
- 未知路径按 **backend** 处理（保守：用更严的 300 行）；目录覆盖由 `check-lanes.mjs` 兜底。

### 二、六条判据 + 自证

| 门禁 | 拦什么 | 真源 | 自证 |
|---|---|---|---|
| `check-sizes.mjs` | 文件行数超档位上限 | `LIMITS` + `.gates/sizes-baseline.json` | 301 行夹具 FAIL / 300 行夹具 PASS |
| `check-dirs.mjs` | 目录直接挂 >5 文件 | `LIMITS.dirFiles` + `.gates/dirs-baseline.json` | 6 文件 FAIL / 5 文件 PASS |
| `check-functions.mjs` | 单函数 >80 行 | AST + `.gates/functions-baseline.json` | 90 行函数 FAIL / 80 行 PASS |
| `check-notes.mjs` | 导出符号缺 JSDoc、`@param` 与签名不符、缺 `@returns` | AST + `.gates/jsdoc-baseline.json` | 裸导出 FAIL / 完整 JSDoc PASS |
| `check-format.mjs` | tab / 行尾空白 / 末尾换行 / BOM / CRLF / 行宽（棘轮） | 六条 + `.gates/format-long-lines.json` | 违规夹具 FAIL / 规范夹具 PASS |
| `check-types.mjs` | `checkJs` 类型错误数上涨 | tsc + `.gates/types-baseline.json` | 基线外的错误文件 FAIL |

四条元门禁：

- `check-fingerprint.mjs` —— 同时看守**有多严**（阈值/白名单/棘轮水位）与**还跑不跑**
  （总线注册表/hook 接线）。只抽"决定严格度"的字段，**改 `label` 文案不算变化**，
  否则所有人都会被逼去跑 `--update`，报警器退化成确认键。
- `check-lanes.mjs` —— 每个顶层条目必须被某条 lane 或 `NO_GATE_PREFIXES` 认领。
  漏掉一类的症状是"改了东西却一条门禁都不跑"，而它在 hook 运行时**完全看不出来**。
- `probe-gates.mjs` —— 20 条探针，违规组必须 FAIL、控制组必须 PASS，夹具一律建在
  `mkdtempSync(tmpdir())` 里，**绝不写真实仓库**。
- `run.mjs`（总线）—— 唯一注册表 + 唯一入口，`pre-commit` / `pre-push` / CI / 手动
  共用同一份定义；合法参数是闭集（其余 exit 2），脚本缺失即报错而不是当成通过。

### 三、退出码承载三种事实

`0 = PASS`、`1 = FAIL（发现违规）`、`2 = usage（参数/环境/白名单语法错）`。
混用的后果是实测过的：白名单语法写错时抛裸异常，退出码为 1，于是
"我白名单写错了"被读成"代码违反了红线"。

### 四、存量用棘轮过渡，不用白名单

七条标准都是**用户指定的硬标准**，不是本仓统计分位数，因此**不按 p90 调整**。
存量走 `.gates/*-baseline.json` 的逐文件/逐函数/逐符号水位（只许降不许涨，降了必须
`--update` 重录，否则基线留着虚高的数、下次能偷偷涨回去）。

白名单 `.gates/whitelist.txt` **刻意保持为空**，且双向校验：登记了却已不违规的条目
= 陈旧条目 → 直接 FAIL。

## Alternatives considered

- **什么都不做 / 复用现有**：现有 CI 五项（test/i18n/contract/image-boot/check-version）
  覆盖的是"功能正确"与"上游不漂移"，**一条都不覆盖结构**。而 4000 行的 `app.js`
  与 2109 行的 `createProxyHandler` 恰恰是每次改动最容易"改一处坏一片"的地方。
  不做等于把结构性风险留给下一个 agent。
- **引入 eslint / prettier / biome**：最强的理由是"现成工具胜过自写脚本"。
  否决原因：AGENTS.md 铁律规定镜像只带 2 个运行时依赖，且 CI 里新引入一个工具链
  意味着版本升级会带来整仓重排（几千行噪音 diff，把真正的重构淹没）。六条格式判据
  用 40 行脚本就能钉死，且不会有版本漂移。
- **不做棘轮，直接全仓清零**：最强的理由是"棘轮会留下永久的债"。否决原因：清掉
  25 个超限文件（含 9330 行的 `smoke.mjs`）是一个几万行的重构，没人能审，且必须先
  冻结所有并行开发。棘轮让"新增即红"**今天就生效**，存量逐轮偿还。
- **把 `checkJs` 直接设为必过**：否决原因：本仓 JS 在 `checkJs` 下有近千条存量
  （395×TS2339 + 335×TS7006 …）。设成必过只有两个结果：全仓类型化（巨大独立工程）
  或关掉门禁。棘轮是唯一能今天就生效的形态。
- **把六条判据写进 `npm test`**：否决原因：`npm test` 是用户与 CI 的命令行契约
  （`package.json` 里那串 && 链条），且结构性判据失败的原因会被测试输出淹没。
  独立成 `quality` job + `run.mjs` 组名，失败信息直接指向"该拆哪个文件"。
- **把行宽也做成硬上限**：否决原因：实测 p90 远低于 120 但长尾有 541 行
  （`test/smoke.mjs` 一条 mock 数据就有几百字符）。硬上限会立刻红 38 个文件，
  于是只能靠大段白名单豁免 —— 那正是"签空白支票"。棘轮更贴合真实分布。

## Consequences

- 新增一条门禁 = 往 `run.mjs` 的 `GATES` 追加一行，然后跑
  `check-fingerprint.mjs --update`（**语义是承认这次变化，不是让门禁通过**）。
- 改动阈值/白名单/棘轮/接线都会让指纹红；这是刻意的，防止红线被静默放松。
- 负向探针不进 `pre-commit`（要起几十个子进程），由 CI 的 `quality` job 与
  手动 `npm run check:gates:probe` 承担。
- 六条标准落地后，任何"再塞一个新功能进 `app.js`"的改动会立刻红 —— 这正是目的。
