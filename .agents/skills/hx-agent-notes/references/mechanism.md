# 决策机制与整理

本地参考为 deepseek-harness 的 `.agents/notes/README.md`, `.agents/notes/AGENTS.md` 和 implemented 规则. 保留其一篇记录拥有一条决策, 事实就地更新, 备选方案先给最强理由, 新建先检查是否已有权威这几条. 这里额外用 AST 和双向图把源码关系变成机器契约

本 skill 按当前需求淘汰废弃记录, 不沿用 DSH 的永久封存策略. 旧封存脚本仅供迁移存量, 不自动扫描年龄或字数后删除决策. Git 保存被删除内容的历史

## 整理操作

```sh
uv run --with-requirements .agents/skills/hx-agent-notes/scripts/redline/requirements.txt python .agents/skills/hx-agent-notes/scripts/setup/maintain.py --repo .
```

清单输出每篇 note 的 Decision-ID, 精确代码锚点和结构问题. 按代码目录调研, 搜索相同问题和备选方案, 对每篇作保留, 更新, 合并或删除的判断. 不根据引用数量直接推断价值, 不为清理数量删掉仍能阻止错误的约束

- 保留: 现行决策仍与函数行为一致, 双向图和位置检查通过
- 更新: 路径或事实过时, 就地改写 note 并修复函数锚点
- 合并: 保留一个权威 ID, 迁入仍有用的理由, 去掉同目录重复锚点, 修复所有入站链接
- 删除: 决策无效或已完全被替代, 先修复源码和其他 note 的引用, 再直接淘汰

```sh
uv run --with-requirements .agents/skills/hx-agent-notes/scripts/redline/requirements.txt python .agents/skills/hx-agent-notes/scripts/setup/maintain.py --delete .agents/notes/implemented/architecture/2026-10-07-obsolete.md
uv run --with-requirements .agents/skills/hx-agent-notes/scripts/redline/requirements.txt python .agents/skills/hx-agent-notes/scripts/setup/maintain.py --delete .agents/notes/implemented/architecture/2026-10-07-obsolete.md --apply
```

第一条只列计划和入站引用, 第二条才删除精确指定的文件. 尚有引用即拒绝删除, 删除后仍须跑 diff 门禁. 删除源码与 note 两端属于有效配对; 只删一端会报断链或需要 review

看板由 `scripts/authoring/build-board.ts` 与 `assets/board-template.html` 生成, 只用于浏览. 概率辅助 `scripts/triage/note-triage.py` 不参与红线裁决. 不让它们的结果覆盖严格门禁
