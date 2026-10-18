# 安装与红线

先确认仓库根, 现有质量红线目录和实际代码目录. 不启动项目程序. 将 skill 自身复制到项目 `.agents/skills/hx-agent-notes`, 所有脚本随仓库版本化, 再执行安装器. 外部路径运行安装器时也会复制 skill

```sh
uv run .agents/skills/hx-agent-notes/scripts/setup/install.py --repo . --guarded src --guarded packages/client --redline-dir scripts/redlines --github
```

安装器写入精确路径配置, 项目红线入口, `.agents/notes/AGENTS.md` 和根 `AGENTS.md` 的带标记短块. 有 package.json 时补上 verify-notes, `verify-notes:all` 和 `verify-notes:staged`. 不覆盖冲突文件, 相同参数重跑幂等. 自定义红线目录会同步到 AGENTS 命令, GitHub 工作流直接调用同一 skill 实现

```json
{"version": 2, "guarded": ["src", "packages/client"]}
```

配置只接受这两个字段, guarded 必须为非空精确仓库路径列表, 可指向目录或单个源码文件. 不继承默认 exempt, 不接受 glob, 不支持用环境变量禁用门禁. 受保护的非 AST 文件仍参与 diff 并报告 resource-review, 请求人工核对决策和引用 若使用 `--guarded scripts`, 安装时产生的红线脚本也属于源码, 需要关联一条真实的工具决策

需要 Python 3.10+, Git 和 uv. 第一次运行 uv 下载固定版本的 Tree-sitter 依赖, 以后可以使用本地缓存. 离线环境先准备 uv 缓存, 然后设置 `UV_OFFLINE=1` 继续使用相同 uv 命令. 缺依赖不会跳过检查

```sh
uv run scripts/redlines/agent_notes.py --diff
uv run scripts/redlines/agent_notes.py --all
uv run scripts/redlines/agent_notes.py --staged
uv run scripts/redlines/agent_notes.py --diff --base <base-commit> --head <head-commit> --json /tmp/notes-report.json
```

| 模式 | 读取内容 | 检查范围 |
|---|---|---|
| 默认 / --diff | HEAD 对当前工作区, 含未追踪文件 | diff 关联的完整决策邻域 |
| --all | 整个当前工作区 | 全图结构与每个源码目录的决策覆盖, 同时检查待提交 diff 的配对 |
| --staged | HEAD 对真实 Git index | 仅暂存内容, 不让未暂存修复冒充提交内容 |
| --base X --head Y | 两个精确 Git tree | 不读取工作区内容, 调用方显式决定比较范围 |
| --all --base HEAD --head HEAD | 已提交 HEAD | 全图, 无待配对 diff |

diff 模式读取 note 元数据以发现反向关系, AST 只扫描变更关联的目录并核对其中重复引用, 只输出受影响邻域的结构问题. 文件增加, 修改, 删除和改名按旧图与新图并集核对. 每条 note 与其每个目录分别满足两边有 diff 或两边都无 diff. 改同目录兄弟文件算代码端有 diff, 修改不关联的 note 不算

全量扫描与 guarded 配置变更同时检查存量目录覆盖. 每个有受保护源码的直接父目录必须有 active note 的 Code 代表路径, 缺少时报告 unowned-directory 并要求 review. 上级目录的决策不覆盖子目录, 已提交且没有 diff 的无主源码也会报告. 已退休最后一条决策的目录若仍有受保护源码, 必须建立仍有效的决策或在独立 review 中调整受保护范围

本地退出码 0 表示通过, 1 表示结构违规或需要 review, 2 表示工具或配置错误. JSON 为 version, ok, issues 等字段, 每个 issue 包含 rule, path, line, message, severity, related. base 保存比较树, base_commit 保存实际基线提交, deleted 列比较中删除的相关路径, 用于评论定位删除前的文件. Code 路径与缺失反向锚点问题定位到 note 中的精确 Code 行, related 带对应源码路径. 单边变化用 severity=review, 门禁只识别需要 review 的事实, 不伪造 review 已完成

CI 由 `scripts/github/collect.py` 调用同一个严格扫描器并保存 JSON, 有诊断和工具错误都退出 0. 工作流步骤与 job 都容错, 上传报告不依赖扫描结果. CI 成功表示流程完成, 数据中的 ok 才表示关系有效, 评论机制见 github.md

## Review 如何处理

先核对单边变化是否意味着 note 已过时或代码遗漏, 按事实修复. 若只是文字纠错等确实不应改代码的情况, 由有仓库权限的人独立审核评论, 不为凑 diff 修改无关代码. 本地诊断保留 review, CI 不因此失败. 不接受作者自行写 NOTE-EXEMPT, 标签, reviewer 字符串或本地开关把无效双链改判有效

guarded 配置发生变化时报告 policy-review, 且用新旧目录并集扫描. 配合 CODEOWNERS 审核配置, skill 实现, 项目红线入口及工作流. 不将始终成功的 CI 当作双链有效的 required check, 合入判断由诊断与 review 支持

## 从 v1 迁移

v1 的宽松配置不会被自动解释为 v2. 显式重写 `.agents/notes.config.json`, 选择精确 guarded 路径, 将每篇 active note 的影响字段改成 Code, 选择同目录代表文件, 增补 Decision-ID, 将源码引用移到 AST 合法位置, 删除全局豁免. 项目已有 npm 命令时人工迁移到新入口, 再运行安装器

先跑全量扫描看存量缺口, 分批修复和独立 review, 不设置通过阈值掩盖欠账. 基线中的坏格式 note 在移动或删除时报告 baseline-review, 避免旧关系解析失败变成隐式豁免. 初始化新机制和迁移规则本身也需要 note

旧 `scripts/cli/verify-all.ts`, `verify-backlinks.ts`, `verify-coverage.ts` 都委托新门禁, 不能经旧命令绕过 AST. `verify-tree.ts`, `verify-format.ts`, `seal-archive.ts` 仅供 v1 数据调研, 不是 v2 的通过标准. 新流程不写 archive; 存量 archive 只作为历史数据, 源码不能引用它来满足 active 关系

同一 diff 显式改写 v1 配置为 v2 时, 比较基线的旧 guarded 模式展开为旧提交中的精确源码路径并保留到新旧扫描并集. 这一转换只用于迁移比较, 报告 migration-review, 目标配置仍只接受 v2. 根目录源码可以作为单文件 guarded 路径, 纯声明源码的锚点见 ast-contract.md
