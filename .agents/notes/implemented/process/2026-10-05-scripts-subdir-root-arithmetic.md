# Agent Note: 脚本移入子目录后必须修仓库根计算

Status: implemented

受影响代码: `scripts/release/inject-version.ts`,`scripts/catalog/sync-catalog.ts`

## Problem

`scripts/` 从 9 个文件拆成 `scripts/{ci,release,capture,catalog}/` 之后,
被移动的脚本仍用**相对自身位置**的层数算仓库根:

```js
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
```

`scripts/` 下是对的(上一层就是仓库根);`scripts/release/` 下就错一层,
变成 `<repo>/scripts`.

实测后果(CI):`build-push` 的 "Inject version into frontend" 步骤抛
`ENOENT: ... open '<repo>/scripts/package.json'`,整条发布流水线红.
本地完全看不出来 -- `node --check` 只查语法,测试也不走这条路径.

## Decision

三处一起修(`inject-version`,`sync-catalog`;另三个在搬运时已改对):

- 相对根改为多跳一层;
- 并在本地**真执行**验证,不只看语法:`inject-version --version X --repo Y`
  必须真的写出 `dashboard/version.json`;`gen-upstream-contract` 必须真的
  输出"抓包文件 2 个 / 请求记录 83 条".

## Alternatives considered

- **什么都不做 / 等 CI 报**:最强的理由是"CI 会跑 build-push,红了再修".
  否决原因:本条已经在 CI 上红过一次并阻塞了发布.而它的失败信息
  (`scripts/package.json` 不存在)指向一个**看起来不该存在**的路径,
  第一眼很像构建缓存问题而不是层数问题.
- **改用 `process.cwd()` 算根**:最强的理由是"少一层 infer".否决原因:
  `cwd` 取决于调用者,从仓库根跑和从子目录跑结果不同 -- 那会把一个
  确定性的错误换成随机的错误.`import.meta.url` 至少是确定的.
- **所有脚本统一放回 `scripts/` 顶层**:最强的理由是"就没有层数问题了".
  否决原因:那与"同目录 ≤5 文件"的硬标准冲突,而那条标准是用户明确要求的.

## Consequences

- 移动任何脚本之后,**必须真执行一次**(不是 `--help`,不是 `node --check`),
  并确认它真的产出了预期的文件.
- 已修的两个脚本在本地实测通过;`sync-catalog` 需要网络,未在 CI 里跑.
