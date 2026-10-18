# GitHub 工作流与评论

安装器的 `--github` 一次生成三个工作流. 全量触发分支默认 main, 非 main 仓库传 `--main-branch master` 等真实默认分支名. 将 skill 与工作流提交到默认分支后生效, 安装本身不调用 GitHub API 发布评论

| 模板 | 触发 | 行为 |
|---|---|---|
| assets/ci/github-actions.yml | 每次 push 和 pull_request | 默认分支实现检查精确 diff, 收集 JSON artifact, 始终容错完成 |
| assets/ci/github-full.yml | 仅主线 push | 扫描整个 HEAD, 收集同格式 artifact, 始终容错完成 |
| assets/ci/github-report.yml | diff 或全量完成后的 workflow_run | 无论扫描结论都读取 artifact, 有问题才发布代码评论, 始终容错完成 |

PR 比较 merge-base 到真实 head SHA, push 比较 before 到 after, 首次分支 push 比较空树到 after. Git 历史完整 checkout, 不使用浅克隆推测基线. 非法 ref 或缺失比较端点输出工具诊断, 不回落成 HEAD 对 HEAD 的空 diff

扫描 job 的 token 只有 `contents:read`, 持写权限的 report job 只 checkout 默认分支. 不使用 pull_request_target 执行贡献者代码. 报告通过 actions/github-script@v8 的 Node 24 加载可信 TypeScript 实现, 脚本目录的 package.json 固定 CommonJS, 不受宿主项目的 ESM 配置影响. artifact 只作数据读取, 校验版本, 必填 head SHA, ok 与诊断一致性及全部路径和行号, 拒绝越界路径和其他提交的数据

`scripts/github/collect.py` 保留严格扫描器的 ok 和全部 issues, 扫描器异常或依赖缺失时写 scanner-error. 每个 CI 步骤和 job 都配置容错, 收集与上传步骤总会运行. 上传失败时报告器发布 missing-report, 评论权限或 API 错误写 warning. 这些错误都不会让工作流失败, 完整扫描结果保留在 artifact 和日志中

`scripts/github/report.ts` 优先创建 PR review 行内评论, 使用准确 path, line, side 和 head SHA. 删除或改名前的代码定位到 LEFT, 正文链接使用删除前的 base_commit 与旧路径. 没有 base_commit 时用 PR 基线或提交父版本, 不把已删文件链接到新 head. note 的 Code 或反向锚点问题优先定位 related 源码, 正文同时列出关联路径. 无 patch 时使用文件评论, 不在本次 diff 内的问题汇总到 PR 总评论, 保留精确路径与行号链接

push 分页读取提交文件, 使用带 path 和 patch position 的 commit comment, 不可定位的内容汇总到提交评论. 每种扫描按关联的决策 Markdown 文件合并诊断, 同篇决策下的源码文件列成项目符号列表, 保留各自行号与规则原因. 未关联决策的资源显示在单独分组, 不猜测其归属, 按扫描名与决策路径生成稳定标记, 重跑更新已有机器人评论, diff 与全量报告分别保留. 错误优先使用最多 40 组的行内评论预算, 其余内容保留在汇总和完整 artifact 中. 汇总区分错误与待审核数量, 列规则统计和实际比较范围, 每条评论只展开 8 项诊断, 按 Markdown 分组显示关联源码并给出其余数量, 不把一次多提交 push 的累计诊断描述为最后一个提交独有的问题. 已修复问题的旧评论保留为 review 记录, head 已变化的 PR 跳过过时报告

CI 成功只表示流程完成, 双链有效性由 JSON 的 ok 与诊断决定. 不把始终成功的扫描 job 当作双链有效的 required check. 本地 CLI 仍严格使用 0, 1, 2 退出码. Actions 禁止机器人评论时 artifact 和日志仍保留, 开启评论权限后远端报告才可发布

评论级别显示为错误或待审核, 具体原因, 扫描器诊断和 Actions 摘要使用中文及英文半角标点. 规则 ID, 路径, 行号, SHA 和 JSON 字段保留原值, 外部工具错误附在中文说明后. 旧提交上的已有评论不会随本地文案更新自动改变

默认分支需要先装好 skill 与三份工作流, 才能读取可信实现. 修改门禁的 PR 由旧可信实现扫描, 新实现另跑本 skill 的测试. 用 CODEOWNERS 审核 `.agents/notes.config.json`, skill 实现, 项目红线入口和工作流. 不自动修改远端分支保护

GitLab 的 `assets/ci/gitlab-ci.yml` 通过同一收集器保存 MR diff artifact, 设置 allow_failure, 不提供 GitHub 评论能力. 本地 hook 为 `assets/hooks/pre-commit`, 按项目红线入口实际目录调整
