# Agent Notes

路径为 `.agents/notes/<implemented|proposed|rejected>/<class>/YYYY-MM-DD-topic.md`, class 为 architecture, feature, bug-fix, simplification, process, testing 之一. 使用仓库相对路径, 状态与路径一致

每篇 note 具有唯一 `Decision-ID: lowercase-slug` 及非空 `## Code`, `## Problem`, `## Decision`, `## Alternatives considered`, `## Consequences`. `Code` 只写逐行的 `- ` 加反引号包裹的精确源码路径. 同一决策在每个直接父目录仅有一个代表文件和一个引用位置

受保护的 shell, JSON, YAML 与文档等非 AST 资源发生 diff 时报告 resource-review, 请求人工核对决策和引用. 不声称 AST 已证明这些资源的双链

全量检查要求每个有受保护源码的直接父目录都有 active 决策. 未建双链的存量目录报告 unowned-directory, 父目录的 note 不覆盖子目录

代表文件在函数或纯声明节点紧邻上方的多行块注释引用 note 的完整仓库相对路径. Python 使用紧邻函数定义的连续至少两行 `#` 注释或函数首条多行 docstring. 普通字符串, 文件头, 类上方及函数中段不算锚点

以同一 diff 的旧图和新图核对关系. 任一端变化另一端没有变化即要求 review, 多目录决策每个目录分别核对. 修改同目录兄弟代码也触发配对. 删除和改名不能消除旧关系的责任

废弃记录直接删除, 同时修复源码和 note 的入站链接. 历史由 Git 保留, 不生成新的 archive 或 seal. 现有归档仅作为迁移输入, 不作为当前代码的决策依据. 不写 INDEX.md, 不接受 NOTE-EXEMPT.md 放行

项目入口委托 `.agents/skills/hx-agent-notes/scripts/redline/verify.py`, 使用 `--diff`, `--all`, `--staged`, `--base <commit> --head <commit>` 和 `--json <path>`. 本地退出码 0 通过, 1 违规或待 review, 2 工具或配置错误

CI 用收集器保存原始诊断, 工作流始终容错完成. PR 问题评论到对应代码行, push 问题评论到对应提交片段, 无法行内定位时用精确路径与行号汇总. 双链仍必须匹配精确现存路径, 合法 AST 声明锚点和每目录唯一引用. 将实现与工作流交给独立 CODEOWNERS 审核, CI 成功不代表双链有效
