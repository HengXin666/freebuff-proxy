# Note 格式与关联契约

每篇 note 只拥有一个决策, 路径为 `.agents/notes/<lifecycle>/<class>/YYYY-MM-DD-topic.md`. lifecycle 为 implemented, proposed, rejected, class 为 architecture, feature, bug-fix, simplification, process, testing. 文件名日期为首次提出日期, 移动生命周期时保留日期和 Decision-ID

```markdown
# Agent Note: 有界重试

Status: implemented

Decision-ID: bounded-retry

## Code

- `src/client/retry.py`
- `src/server/dispatch.ts`

## Problem

请求失败后需要限制重复执行次数

## Decision

调用端和服务端都执行同一重试上限

## Alternatives considered

- 无限重试: 可以等待短暂故障恢复, 但无法约束重复执行次数
- 什么都不做 / 复用现有: 无需额外状态, 但现有调用没有统一次数上限

## Consequences

执行次数可验证, 长时间故障需要调用方显式处理失败
```

`## Code` 是机器契约, 仅允许上例的逐行精确路径. 禁止 glob, 花括号, 目录, 行号片段, Markdown 链接和路径后的说明. 所有路径从仓库根开始, 使用 `/`, 不使用 `./` 或 `../`. 引用必须落在 guarded 目录内的现存源码文件

同一 Decision-ID 在 active notes 中只能出现一次. 一个 note 的每个直接父目录只列一个代表文件, 并且该目录的源码只能有一个对该 note 的引用位置. 例如 `a/b/c.py`, `a/b/d.py`, `a/e.py`, `a/g/f.py` 只列 `a/b/c.py`, `a/e.py`, `a/g/f.py`. `a/b/d.py` 不重复放引用, 其 diff 仍归属于 `a/b` 的决策

目录范围严格为直接父目录, 不递归吞并子目录. 一个目录可以有不同决策, 每个决策各有一个锚点. 修改这个目录中的任意受保护源码会检查所有属于该目录的决策. 脚本不能识别两个不同 ID 是否语义重复, 整理和 review 时必须搜索问题与备选方案再判断

## 函数锚点

```ts
/**
 * 限制每次调用的重试次数
 * .agents/notes/implemented/architecture/2026-10-07-bounded-retry.md
 */
export function retry() {
  return 3
}
```

```python
def retry():
    """限制每次调用的重试次数
    .agents/notes/implemented/architecture/2026-10-07-bounded-retry.md
    """
    return 3
```

C++, TS, TSX, JS, MJS, Go, Rust 使用紧邻函数声明上方的多行 `/* ... */` 或 `/** ... */`. Python 没有块注释语法, 使用函数首条多行 docstring, 或紧邻定义上方连续至少两行 `#` 注释. 允许 export, decorator, template, Rust attribute 以及变量声明包裹的函数表达式, 具体 AST 判据见 `ast-contract.md`

不要把路径写入普通字符串, 类头, 文件头与声明之间的空白块, 单行注释或函数中段. 代码只保存简短约束与 note 路径, 不复制整篇理由

## 更新与退役

先读拥有决策的旧 note, 事实过时就地改写. 新决策使用新 ID 和新 note, 不把旧 note 偷换成另一个决策. 部分取代时保留仍有效的记录并互链; 完全取代时把仍有用的理由并入新 note, 修复全部入站引用并删除旧文件

proposed 和 rejected 也需要真实的关联代码与锚点, 分别表示约束正在评审和不可重犯的选择. 纯构想尚无源码时先留在 Issue 或普通设计文档, 不伪造占位函数来满足门禁

不生成引入提交 SHA 字段: 同次提交的自身 SHA 无法可靠内嵌, 使用 Git 历史追溯. 不追加历史流水账, 不保存失效记录充当现行权威. 无指导价值的记录直接淘汰, 历史由 Git 保留

纯声明源码没有函数时, 可把同样的多行注释绑定到实际导出, 变量, 类型或接口声明, 具体节点规则见 ast-contract.md. 不添加占位函数. 根目录源码通过单文件 guarded 路径纳入范围
