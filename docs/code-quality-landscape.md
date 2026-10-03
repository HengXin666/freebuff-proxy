# 代码质量全景 — freebuff-proxy

> 生成于 2026-10-04。按 `hx-code-quality` 的取证 → 本地 → 远程 → 全景顺序产出。
> 本文件描述**现状**；具体决策与放弃的选项记在
> `.agents/notes/implemented/architecture/2026-10-03-upstream-contract-single-source.md`
> 等 Agent Note 里，二者互相引用而不互相代替。

---

## 一、总体判断

这是一个**上游协议靠逆向获得**的反向代理，最大的结构性风险不是语法或
风格，而是**上游一改 API 我们就静默漂移**。

已存在且有效的防线：类型检查、冒烟、i18n 红线、note 门禁、镜像启动门禁、
发版版本号门禁、pre-commit。

本轮补的是**此前完全没有的那一层**：上游契约的单一真源与机器对账。
这是本项目最该被结构约束的地方 —— 因为上游端点/头名分散在两个实现
（主服务 `src/` 与官方形态实现 `cli-bridge/`）里各写一份。

---

## 二、已经做得好且保留

| 项 | 证据 | 保留理由 |
|---|---|---|
| `typecheck`（tsc --noEmit） | package.json | 已接线 CI |
| `test:smoke`（mock 上游） | test/smoke.mjs 7815 行 | 覆盖调度/冷却/换号/代理 |
| i18n 红线 | `.github/workflows/docker-image.yml` 的 `i18n` job + `scripts/check-i18n.mjs` | 三条判据钉死多语言退化 |
| 镜像启动门禁 | `image-boot` job + `scripts/pipeline-image-test.mjs` | 真实起容器 + 打坏 data 验证 |
| 发版版本号门禁 | `check-version` job | tag 与 package.json 必须一致 |
| note 门禁 | `agent-notes.yml` + pre-commit | 受保护改动必须带决策记录 |
| pre-commit | `.git/hooks/pre-commit` | 已装，跑 format/backlinks/coverage（本轮追加契约门禁） |

---

## 三、本轮新增：上游契约三层（A 层最小闭环已闭环）

| 层 | 文件 | 职责 |
|---|---|---|
| 真源 | `src/upstream/upstream-contract.js` | 端点与头名的**唯一定义处** |
| 快照 | `docs/reverse/upstream-contract.json` | 从抓包**生成**的客户端真值（7 端点 / 19 头 / 顺序） |
| 门禁 | `scripts/check-upstream-contract.mjs` | 四条判据对账 |
| 生成器 | `scripts/gen-upstream-contract.mjs` | 重建快照（上游变更后第一步） |

### 四条判据（每条都有判据 + 检查点 + 自证）

| # | 判据 | 检查点 | 自证 |
|---|---|---|---|
| 1 | 必需端点必须在真源有常量 | npm script / CI / pre-commit | 删常量 → 红 |
| 2 | 业务头必须在真源有常量 | 同上 | 快照里改头名为 `-v2` → 红，报"未登记到真源" |
| 3 | 源码不得有未登记的 `x-freebuff-*` 字面量 | 同上 | 扫 41 文件无违规 |
| 4 | 废弃头不得出现 | 同上 | 注入 `x-codebuff-api-key` → 红并报出文件 |

排除项（都是实测踩出来的误报）：
- `x-freebuff-proxy-*`：本代理给下游的响应头，不是上游契约。
- 注释里提到废弃头不算违规（那些注释在解释为什么废弃）—— 判据 4 先剥离
  块注释与行注释再扫。

### 上游变更后的固定处置路径

```
重抓包 → npm run gen:contract → 改真源文件（一处）→ npm run check:contract 转绿
```

---

## 四、引用候选规则的对账（REF 编号沿用 skill 模板）

本项目无 Python 后端、无 TS/TSX 前端构建链、无 Playwright，
大量原版条目**不适用**。适用项逐条如下：

| REF | 参考规则 | 本项目适配 | 状态 |
|---|---|---|---|
| 4/20 | arch-check（体量/分层） | 未装；体量热点已取证（见下） | 待确认 |
| 6/21 | api-surface（契约快照） | **已实现**：上游契约快照 + 对账 | 采用 |
| 8 | config-catalog（配置不漂移） | 未装 | 待确认 |
| 12 | inline-secrets（凭据只在白名单文件） | 未装；凭据在 `data/credentials/`、`data/device-keys/` | 待确认（高价值） |
| 17 | tsc --noEmit | **已有** | 采用 |
| 23/24 | notes 格式与双向链接 | **已有**（hx-agent-notes + pre-commit） | 采用 |
| 28 | gate-fingerprint（防静默放松） | 未装 | 待确认 |
| 29 | check-hooks（hook 可运行 + lane 覆盖） | **已实测**：提交时 pre-commit 触发契约门禁并通过 | 采用 |
| 30 | probe-gates（负向验证） | **已做**：两组反向探针（回潮 / 改头名） | 采用 |
| 31 | e2e | 不适用（无浏览器 UI 测试链） | 不适用 |

不适用的证据：扩展名分布里 `.ts/.tsx` 仅 11 个（且是 skill 脚本与类型声明），
无 `package.json` 里的前端构建器，无 playwright/vitest/biome 依赖。

---

## 五、体量热点（取证，尚未设限）

```
7815  test/smoke.mjs            ← 同时是 churn 第一（95 次）
3548  dashboard/app.js          ← churn 第三（59 次）
2643  src/proxy.js              ← churn 第二（69 次）
2276  src/app-context.js
1723  src/web/api.js
1662  src/session-manager.js
1309  src/upstream/client.js
```

高 churn × 大体量的三个文件（`smoke.mjs` / `proxy.js` / `app.js`）是最该被
结构约束的地方。目前**没有**行数上限或目录文件数上限 —— 未设限是因为
需要先用棘轮接纳存量，属于 B 层增量，待用户确认。

---

## 六、本轮明确不装什么及原因

| 不装 | 原因 |
|---|---|
| ESLint / Biome / Ruff | 项目只有 2 个运行时依赖（AGENTS.md 铁律：超级轻量），为一个约束引入工具链不划算；契约检查用自写脚本更贴合"与抓包对账"这个专属需求 |
| 覆盖率门禁 | 冒烟本身就是 mock 上游的行为测试，加覆盖率数字没有新增判据；且当前 smoke 还有一条未通过 |
| 行数上限 | 需要棘轮接纳存量（上面三个文件都超限），属于 B 层，未获确认不擅自加 |
| gate-fingerprint | 契约快照承担了"防静默放松"的职责（快照是从抓包生成的，改真源不同步就红） |
| 远程协作文档（PR/Issue 模板） | 仓库未使用，标为不适用 |

---

## 七、已修复的并发采样竞态（原第七节的未通过项）

曾有一条间歇性失败：`单账号并发上限 3 → 上游并发峰值应为 3, got 2`，
另有一条 `上限 2 → 峰值应为 2, got 1`。

**决定性对照实验**定因：把流式 mock 的帧数 4/5 → 20（每条流活 ~2s）。
- 若稳定得 3 → 采样竞态；
- 若仍 2 → 实现缺陷。

实测连跑 3 次全部退出码 0 → **判定为采样竞态**：流只活 ~500ms 时，排队
放行本身有耗时，会出现"第 1 条已结束、第 3 条还没放行"的窗口，峰值采样
不到上限。加长存活时间让三条必然同时在飞。

关键点：**判据没有弱化** —— 仍断言峰值**等于**上限，只消除竞态，
没有改成 `>= 2` 那种"测不出上限"的写法。

另修两处测试前置不全：
- `requestJitterMs` 默认 200ms 会给请求加随机延迟，并发用例需显式归零；
- `accountMaxConcurrency` 用例断言 3 却用默认 2，现显式设 3。

**当前状态：check:contract / typecheck / test:catalog / smoke / compose 全绿。**

---

## 八、下一层（B）的收益与成本

| 增量 | 收益 | 成本 |
|---|---|---|
| 行数上限 + 逐文件棘轮 | 约束三个高 churn 大文件继续膨胀 | 需先录基线，中 |
| 凭据扫描（REF-12） | 防凭据落进非白名单文件 | 低（正则 + 白名单 3 条） |
| 配置目录对账（REF-8） | config.yaml 与源码不漂移 | 中（需生成器） |
| 契约快照进 CI 的 diff 产物 | 上游变更时一眼看出改了哪个头 | 低 |

---

## 九、命令速查

```bash
npm run check:contract   # 上游契约对账（本轮新增）
npm run gen:contract     # 重建契约快照（上游变更后用）
npm run check:all        # 契约 + catalog + typecheck + smoke
npm run typecheck
npm run test:catalog     # 目录驱动模型表（真机目录离线验证）
npm run test:smoke       # 冒烟（当前一条未通过，见第七节）
npm run verify-notes     # 决策记录门禁
```
