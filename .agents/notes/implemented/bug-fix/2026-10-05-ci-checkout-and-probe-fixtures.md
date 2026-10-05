# Agent Note: CI 检出与负向探针的两处前提被破坏

Status: implemented

受影响代码: `.gitignore`、`scripts/gates/checks/code/syntax.ts`、
`scripts/gates/probes/cases.ts`、`test/suites/entries/smoke/parts/billing/data/**`（新增入库）

## Problem

v2.0.0 推送后 CI 红，两处都是「本地通过、CI 不通过」的形式 —— 即本地环境掩盖了缺陷。

1. **`.gitignore` 的 `data/` 未锚定**，会匹配任意层级的同名目录。测试目录
   `test/suites/entries/smoke/parts/billing/data/` 因此整个被排除在版本控制外：
   本机有这三个文件所以 `npm test` 正常，CI 检出后直接
   `ERR_MODULE_NOT_FOUND: .../parts/billing/data/data-audit.ts`。
   这个形态最危险的地方是它**只在 CI 出现**，本地怎么跑都发现不了。

2. **负向探针夹具用 `.js`**：`syntax` / `dirs` 门禁的探针生成 25 个 `src/ok*.js`，
   但全仓 TS 化之后这两个门禁只扫 `.ts`，于是夹具里的"文件数"与"目录文件数"都是 0，
   控制组报「扫描面可能被写坏」，真值组报不出预期片段（22 条探针里 3 条失败）。
   另有 `syntax` 门禁只在 `CHECK_ROOT` 下找 `tsc`，而探针把 `CHECK_ROOT` 指到
   临时目录（无 `node_modules`），门禁因此报「找不到 typescript」。

两处合起来说明一件事：**改门禁的扫描口径时，探针夹具是同一改动的责任范围**，
只跑真实仓库的门禁总线看不出夹具已经失效。

## Decision

- `.gitignore` 的 `data/` 与 `data-test/` 都加前导 `/` 锚定仓库根。
  被漏掉的 3 个文件（529 行）入库。审计过其余忽略规则，无第二处同类误伤。
- 探针夹具的 `.js` 改成 `.ts`。
- `syntax` 门禁的 `tsc` 增加一条回落：`CHECK_ROOT` 下找不到时，用**门禁自己所在仓库**的
  `tsc`。「能否解析」与仓库根在哪无关，因此对夹具与对真实仓库等价。
- **保留** `sizes` 白名单语法夹具里的 `src/a.js`：那两条探针测的是"白名单条目必须带
  `|N`"与"陈旧条目要报错"，与文件扩展名无关；实测两条都正常 FAIL（非空转）。

## Alternatives considered

- **只是把 `.gitignore` 的 `data/` 改成 `/data/`，不动探针**。最强理由：只修 CI 报错的
  那一处，改动面最小、风险最低。否决原因：探针失败的 3 条是**同一批次 CI 里的另一处红**，
  不修它 CI 依旧红；而且它揭示的是"改了扫描口径却没同步夹具"这个模式，
  留着下次改门禁还会再踩。

- **给 `data-audit.ts` 等文件改名**（例如改成 `audit/`），绕开 `data/` 规则。
  最强理由：不用碰 `.gitignore`，不动全局忽略规则。否决原因：目录名 `data/` 在测试里
  表达的是"这块测的是数据文件处理"，改名是为了绕开工具的缺陷而给代码加噪音。
  `.gitignore` 未锚定本来就是写法问题。

- **让 `syntax` 门禁在找不到 `tsc` 时直接 PASS**（把"缺 tsc"降级为提示）。
  最强理由：避免 CI 环境差异造成的红。否决原因：那会让"CI 没装依赖"与"语法没问题"
  无法区分 —— 正是 `check-fingerprint` 与本案要防的"判据在最该报警的时候变绿"。

- **把负向探针夹具改成从真实文件复制**（不合成文件）。最强理由：夹具永远与真实结构一致。
  否决原因：探针要构造**违规**结构（6 个文件同目录、语法错），真实仓库里不存在也不该存在。

## 影响

- CI 三个 job（test / quality / build-push）的前提恢复；`data/` 相关测试文件进入版本控制。
- 探针 22/22 通过，其中 `syntax` 的两条（真值 + 控制组）与 `dirs` 的两条恢复有效。
- 本地验证：门禁 18/18、探针 22/22、`npm test` ALL SUITES PASS（166.7s）、typecheck exit 0。
