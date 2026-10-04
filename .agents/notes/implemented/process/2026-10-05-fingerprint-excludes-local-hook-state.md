# Agent Note: 指纹只记仓库真相, 不记本地环境状态

Status: implemented

受影响代码: `scripts/gates/meta/fingerprint.mjs`,`.gates/fingerprint.json`

## Problem

门禁指纹的用途是"看守红线有没有被静默放松", 它抽取的是**阈值 / 白名单 /
棘轮水位 / 总线注册表**这类**决定严格度**的字段.

但它一度还把 `.git/hooks/pre-commit` 与 `.git/hooks/pre-push` 的**文件内容**
也算进去.而 `.git/hooks` **不入库**(git 不提交它) -- 它在每个工作副本里都是
本地状态: 本地装了 hook, CI 的 checkout 里没有.

实测后果: v1.27.0 的 `quality` job 报 `hook 接线 发生变化`, 而代码一个字节没变.
本地跑 `npm run check:gates` 全绿, CI 红, 原因只是"CI 没装 hook".

同一处还有第二个缺陷: 抽取组名的正则用了 `(\S+)`, 会贪婪匹配到
`if [ -f scripts/gates/run.mjs ];` 那行的 `];`, 所以指纹里原本记的是垃圾值,
且它随 shell 语法微调而变.

## Decision

**从指纹中移除 hooks 字段**.指纹只记录"仓库里的真相"; 本地环境状态不属于它.

hook 是否真的在跑门禁, 改由两条更可靠的东西守:

- pre-commit 自己调 `scripts/gates/run.mjs pre-commit` -- 装了 hook 就会跑;
- CI 的 `quality` job 直接跑 `npm run check:gates` -- 不依赖任何本地 hook.

也就是说: 这个风险的**检查点**本来就不该是指纹, 而是那两个真实入口本身.

## Alternatives considered

- **什么都不做 / 让它随机器而变**: 最强的理由是"指纹只是提示, 红了一眼就懂".
  否决原因: 一个会随机器而变的指纹不是门禁, 是噪音源.它的结局有两种,
  且都不好 -- 要么被人反复 `--update` 到失去意义, 要么整条关掉.
- **把 hooks 值归一为 `<not-wired>`**: 最强的理由是"保留字段就能继续看接线".
  否决原因: 归一之后这个字段在两种环境里恒等于 `<not-wired>`, 它不再携带
  任何信息, 却仍占着一个"看起来在守护什么"的位置.删掉比留一个恒定的假信号诚实.
- **在 CI 里装 hook 后再跑指纹**: 最强的理由是"统一两边环境".否决原因:
  `.git/hooks` 不入库, 在 CI 里安装它等于用流水线脚本伪造本地状态; 而且
  真正要验证的是"门禁有没有被跑", 那个用 `npm run check:gates` 直接验更直接.

## Consequences

- 改动 `.git/hooks/**` 不再触发指纹红.这是刻意的: 它本来就管不到 CI.
- 若要验证"hook 还接不接着跑门禁", 跑 `npm run check:gates:commit` 即可
  (pre-commit 用的同一条命令).
- 指纹的 diff 逐字段比较里不再有 hooks 一项; 旧指纹文件需 `--update` 一次
  (本次已在同一改动里完成).
