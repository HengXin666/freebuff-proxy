---
name: hx-agent-notes
description: Validate bidirectional Agent Notes and code decisions with Tree-sitter declaration anchors, exact paths, one anchor per directory and paired diff review. Keep GitHub workflows successful and report findings as inline PR or commit comments. Use when adopting ADRs, updating a code decision, repairing backlinks, auditing stale notes or configuring Agent Notes checks and bot reports.
license: MIT
metadata:
  author: Heng_Xin
  version: "2.3"
---

# Agent Notes

先读声明顶部引用的 note, 再改代码. 一篇 note 只拥有一条决策, 事实过时就地重写. 每个代码目录选一个代表文件, note 逐行列精确仓库路径, 代表文件用声明顶部多行注释反向引用 note. 不使用 glob, 花括号展开, 冗长影响列表或文件头占位引用. 纯类型, 接口, 常量和配置绑定真实声明, 不增加占位函数

双链由 AST 与新旧关系图严格校验. 支持 cpp/ts/tsx/js/mjs/go/py/rs, 拒绝普通字符串和错误注释位置. 代码端或 note 端发生 diff 时, 两端必须配对, 同目录兄弟文件也算代码端. 单边变化报告需要 review, 不以无关 note, NOTE-EXEMPT 或禁用环境变量改判有效

受保护范围中的非 AST 资源改动报告 resource-review, 由人工核对决策及引用; 不把 shell, JSON, YAML 或文档当成已解析的源码

全量扫描同时检查每个受保护源码目录是否已经建立双链, 没有 note 的存量目录报告 unowned-directory. 目录范围为直接父目录, 不用上级目录的决策代替子目录的决策

CI 工作流始终容错完成, 有问题就在对应代码片段评论, 并保留完整 JSON 诊断. PR 使用行内 review comment, push 使用提交片段评论, 按决策 Markdown 文件聚合源码列表, 无法行内定位时汇总精确路径与行号. 本地 CLI 仍严格返回校验退出码, CI 成功不代表双链有效

审核评论, 扫描诊断和日志摘要使用中文, 标点只用英文半角. 规则 ID, 精确路径, SHA 和 JSON 字段保持原值; 外部工具原始错误附在中文说明后

## 按任务执行

| 任务 | 执行契约 |
|---|---|
| 接入项目 | 读 references/verify.md, 选精确 guarded 文件或目录路径和现有红线目录, 运行安装器, 跑全量检查 |
| 写或改 note | 读 references/note-format.md 和 references/writing.md, 先找旧权威, 补双向路径, 跑 diff |
| 调整锚点 | 读 references/ast-contract.md, 将短注释放到 AST 合法声明顶部 |
| 配置 GitHub | 读 references/github.md, 安装时加 --github, 确认默认分支可信实现与评论权限 |
| 整理或废弃 | 读 references/mechanism.md, 清单调研后保留, 更新, 合并或直接删除, 修复入站引用 |

```sh
uv run .agents/skills/hx-agent-notes/scripts/setup/install.py --guarded src --redline-dir scripts/redlines --github
uv run scripts/redlines/agent_notes.py --diff
uv run scripts/redlines/agent_notes.py --all
uv run scripts/redlines/agent_notes.py --staged
```

安装器将简短约束写入项目根 AGENTS.md, 项目红线入口只委托 vendored skill/scripts. 不启动项目程序. 旧配置须显式迁移, 不把 v1 宽松检查伪装成 v2 通过

废弃 note 直接淘汰, 历史交给 Git. 不再创建永久归档. 仍有指导价值的备选理由必须先迁到存活决策, 不按年龄或数量自动删除

## 门禁实现

- `scripts/redline/verify.py`: 统一 CLI, diff / all / staged / 精确提交树与 JSON 报告
- `scripts/redline/snapshot.py`: 读取工作区, Git index 与历史树, 校验精确 guarded 配置
- `scripts/redline/anchors.py`: Tree-sitter 函数与声明节点与多行注释归属
- `scripts/redline/graph.py`: note 格式, 双向边, 每目录唯一引用和旧新图 diff 配对
- `scripts/redline/requirements.txt`: 固定 parser 依赖, 离线准备时读取
- `scripts/redline/run.ts`: 旧 TypeScript 命令委托同一 Python 门禁
- `scripts/setup/install.py`: 生成项目红线入口, 配置, 根指令块与可选工作流
- `scripts/setup/new_note.py`: 用精确 --code 路径创建 note 骨架
- `scripts/setup/maintain.py`: 只读清单, 删除计划和明确指定的退役动作
- `scripts/github/base.py`: 解析 push 与 PR 精确比较端点
- `scripts/github/collect.py`: CI 收集严格诊断, 把工具错误写入 artifact, 始终正常退出
- `scripts/github/diagnostics.ts`: 校验报告归属和路径, 映射 diff 左右侧代码位置
- `scripts/github/package.json`: 固定报告模块为 CommonJS, 兼容宿主项目的 ESM 配置
- `scripts/github/report.ts`: 可信 workflow_run 发布行内或提交评论, 更新同位置报告并容错

## 验证修改

Python 扫描入口通过 uv 运行, 包括安装器, 项目红线, hook 与开发期校验. CI 收集器只用标准库, 通过 python3 启动并调用 uv 扫描, uv 不可用也能产出工具诊断. 测试子进程继承 uv 提供的解释器

```sh
uv run --with-requirements scripts/redline/requirements.txt python -m unittest discover -s scripts/tests -v
node --experimental-strip-types --test scripts/tests/test_report.ts scripts/tests/github/test_grouping.ts
uv run ../hx-make-skill/scripts/validate_skill.py .
uv run ../hx-make-skill/scripts/prose_rules.py --check .
uv run ../hx-make-skill/scripts/check_layout.py .
```

本 skill 正文和生成的 note, AGENTS 及其他文本遵守 `../hx-make-skill/references/prose-rules.md`, 脚本遵守 `../hx-make-skill/references/code-quality.md`. 缺少这些开发期校验器时明确报告, 安装到其他项目后的运行期红线不依赖它们

- `scripts/tests/test_anchors.py`: 八种语言和错误引用位置的真实 parser 测试
- `scripts/tests/test_gate.py`: 隔离 Git 仓库里的增删改名, 暂存区, 单边 diff 和绕过反例
- `scripts/tests/test_links.py`: 双链删改, 错误代表文件, 入站链接与精确 Code 行号
- `scripts/tests/test_collect.py`: 正常扫描, 违规, 缺失端点和依赖故障下的成功退出与完整诊断
- `scripts/tests/test_setup.py`: 安装幂等, 退役, 骨架与首次 push 基线
- `scripts/tests/github/test_grouping.ts`: 按决策文件聚合, 无归属资源, 删除链接和跨源码幂等更新
- `scripts/tests/test_report.ts`: 模拟 GitHub API 的行内与提交评论, 更新, 失败兜底和不可信报告拒绝

## 兼容与浏览工具

- `scripts/cli/verify-all.ts`, `scripts/cli/verify-backlinks.ts`, `scripts/cli/verify-coverage.ts`: 保留旧路径, 均执行 v2 完整红线
- `scripts/authoring/init-agent-notes.ts`, `scripts/authoring/new-note.ts`: 保留旧路径, 分别委托安装器与骨架生成器
- `scripts/cli/verify-tree.ts`, `scripts/cli/verify-format.ts`, `scripts/cli/seal-archive.ts`: 仅供 v1 存量调研, 不作 v2 放行依据
- `scripts/authoring/archive-note.ts`: 旧归档工具, 新流程使用 maintain.py 直接退役
- `scripts/authoring/build-board.ts`: 可选离线看板, 不启动服务
- `scripts/triage/note-triage.py`: 概率辅助, 不参与红线裁决
- `scripts/lib/notes-lib.ts`: 旧浏览与迁移工具的共享导出
- `scripts/lib/config.ts`: 旧配置发现, v2 配置由 snapshot.py 严格读取
- `scripts/lib/tree.ts`: 旧生命周期树扫描
- `scripts/lib/glob.ts`: 旧 glob 实现, v2 关联路径不使用它
- `scripts/lib/manifest.ts`: 存量归档 manifest 读取
- `scripts/lib/seal.ts`: 存量归档 seal 校验

## 模板

- `templates/implemented.md`, `templates/proposed.md`, `templates/rejected.md`: 同一双向契约的状态骨架
- `assets/AGENTS.snippet.md`: 根指令短块, 由安装器更新标记区间
- `assets/notes-contract.md`: notes 目录的详细机械契约
- `assets/ci/github-actions.yml`, `assets/ci/github-full.yml`, `assets/ci/github-report.yml`: 始终容错的 diff, 主线全量与机器人评论
- `assets/ci/gitlab-ci.yml`: GitLab MR 扫描适配器
- `assets/hooks/pre-commit`: 精确暂存区检查入口
- `assets/board-template.html`: 浏览看板底版, 不参与门禁

## 显式迁移 v1

迁移同一 diff 中的配置和全部 active note, 修复源码引用并替换检查入口. 旧基线仅在配置明确改成 v2 时按旧保护范围参与比较, 仍报告 migration-review 与 policy-review. 决策统一写入 `.agents/notes`, 无本仓有效代码约束的旧记录按退役规则直接删除, 有指导价值的理由先迁入存活决策. 每个仓库使用本仓 vendored skill, 完整迁移后跑 --all 并核对旧保护范围未丢失
