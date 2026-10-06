# scripts/AGENTS.md -- 门禁与工具脚本

> 只讲[动 scripts/ 时才知道的事]. 通用约定见根 [AGENTS.md](../AGENTS.md).

## 门禁总入口
```bash
node scripts/gates/run.ts            # 全部 17 条
node scripts/gates/run.ts --list     # 列出所有门禁与分组
node scripts/gates/run.ts <lane>     # 只跑某组(快, 改代码时用这个)
node scripts/gates/run.ts --dry-run  # 只看不判
npm run check:gates                  # = run.ts
```
分组(lane)大致是 `code`(文本/体量/注释), `doc`, `guard`(契约/指纹/路由表), `notes`.

## 棘轮基线(最要紧的机制)
`.gates/*.json` 是[有多严]的基线, **只许降不许涨**.
- 重录的**唯一入口**是门禁的 `--update`, 语义是"承认这次变化", **不是**"让门禁通过" ---- 重录必须
  能说明理由(通常在提交信息里写清).
- 常见基线: `.gates/fingerprint.json`(门禁接线指纹, 改了 rules 白名单/阈值就要重录),
  `.gates/style-baseline.json`(逐文件的全角标点/超长行计数).

## 检查脚本在哪
| 路径 | 管什么 |
|---|---|
| `gates/rules.ts` | **门禁的元规则**: 档位(`TIERS`), 豁免目录(`exempt`), 代码扩展名, 行数上限 |
| `gates/checks/code/` | 体量 / 函数长度 / 注释(JSDoc) / 格式 / 样式 |
| `gates/checks/doc/` | 文档登记核对 / 引用存在性 |
| `gates/checks/guard/` | 路由分流表 / 上游契约 / 响应契约 / 接线指纹 |
| `gates/meta/` | 门禁自己的门禁(指纹) |
| `check-upstream-contract.ts` | 上游端点白名单对账(必须端点 / 业务头) |
| `release/inject-version.ts` | 发版时生成 `dashboard/version.json` 写进镜像 |

**加豁免目录**(如新的第三方产物目录)要**同时改两处**: `gates/rules.ts` 的 `TIERS.exempt` 与
`tsconfig.dashboard.json` 的 `exclude` ---- 漏一处会让门禁或类型检查被灌爆(实测漏一次会灌进
3.7 万条类型错误).

## 加一条新门禁
1. `gates/checks/<组>/<名>.ts` 写检查, 用 `gates/lib/` 的公共件(扫描/Report).
2. 在 `gates/lanes.ts` 注册进对应 lane.
3. 若它属于[接线指纹]范围, 跑 `--update` 重录并说明理由.
4. 基线文件按需在 `.gates/` 下新建.

## 其他脚本
- `gen:contract` / `check:contract`: 契约快照的生成与对账.
- `check:all`: 契约 + catalog + typecheck + smoke 一把梭.
