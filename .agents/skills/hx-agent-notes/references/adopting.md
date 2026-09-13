# 在一个已有项目里接入

这套机制以「一棵目录树 + 一份配置 + 一组门禁」的形式到来. 按下面的顺序引入,才能让第一次绿色的 CI 变得可达.

## 1. 装之前先看

先找项目里是否**已经有**决策记录 —— `docs/adr/`、`docs/decisions/`、一个 RFC 目录、或者一份要求写设计文档的 `CONTRIBUTING.md`. 如果有,就明确决定:notes 树是**取代**它,还是**并行存在**. 迁移存量通常不值得;更划算的做法是把旧目录留作「被引用的历史归档」,让新决策流进 notes 树.

也读一遍项目自己的 `AGENTS.md` / `CLAUDE.md`. 里面任何关于设计文档的既有指令,都是新规则要嵌进去的地方.

## 2. 装上目录树

```sh
npx tsx .agents/skills/hx-agent-notes/scripts/init-agent-notes.ts
```

它会写出:带三个生命周期与六个类别的 notes 根目录、带 kind 子目录的归档区、契约文件 `AGENTS.md`、`.agents/notes.config.json`,以及在有 `package.json` 时的 package scripts. **没有 `--force` 它绝不覆盖已有文件.**

轻量引入也是合法的:只建项目实际会用的那几个 `implemented/<class>/`,等第一篇 note 需要时再补 `proposed/`、`rejected/`、`archived/`. 空目录可以删掉. **门禁能容忍某个生命周期目录不存在.**

## 3. 把覆盖率保护指向真正的决策

编辑 `coverage.guarded`,指到决策可能藏身的目录. 默认值(`src/**`、`packages/*/src/**`、`apps/**/src/**`、`lib/**`、`scripts/**`)是不错的起点;如果某个生成目录会让门禁天天报警,就把它收窄掉.

树刚建起来的时候,把 `backlinks.required` 设成 `false`. 等每一篇 implemented note 都有了锚点再打开;否则第一次运行会因为**历史**而失败,而不是因为这次改动.

## 4. 把门禁放进仓库,并接上 agent 指令

**把 skill 目录搬进项目,否则 package scripts 指向空气.** `init-agent-notes.ts` 写出来的命令引用的是 `.agents/skills/hx-agent-notes/scripts/`,而一个 CI 全新 clone 出来的仓库够不到用户级目录下的 skill. 拷进去:

```sh
mkdir -p .agents/skills/hx-agent-notes
cp -r <skill>/{scripts,assets,templates} .agents/skills/hx-agent-notes/
cp <skill>/SKILL.md .agents/skills/hx-agent-notes/
```

**提交它**,这样门禁的版本就和它所守护的代码钉在一起了. 交互式地从仓库外运行这个 skill 没问题 —— 需要目录树在场的是 CI 和全新 clone.

**根指令文件不是可选项.** 没有任何东西会自动加载 `.agents/notes/AGENTS.md`:一个 agent 之所以会读那个文件,只因为项目根的 `AGENTS.md` 或 `CLAUDE.md` 让它去读. 如果项目两个都没有,**就新建一个**;第 5 步的片段就是那条路由规则. **一棵没有入口的树,是任何会话都不会打开的树.**

把 [../assets/AGENTS.snippet.md](../assets/AGENTS.snippet.md) 拷进那个根文件,并替换占位符. 这才是让机制**不必靠人记得去调用**就能生效的东西.

## 5. 先把运行时确认好,再信任那些命令

脚本要在 `tsx` 下运行,而安装器是通过 `npx` 调它的. 一个既没有 `node_modules`、也没有 npx 缓存的项目,要么加一个 `tsx` devDependency,要么用一个能原生剥类型的 Node(Node >= 22.6,直接 `node script.ts`). **把门禁接进 CI 之前先确认这两条里有一条能跑**,否则流水线会因为一个跟 note 毫无关系的原因失败.

## 6. 写下最初的几篇 note

为代码里**已经承重**的那些决策写 note —— 就是新维护者一定会问的那些. 两三篇就够把形状立起来了;之后这棵树靠真实改动生长.

如果项目不维护中文对照,把 `translationSuffixes` 设成 `[]`.

## 7. 打开门禁,然后配分支保护

在本地把 `verify-all.ts` 跑到绿. 把 CI workflow 放进去,确认它在一次真实改动上通过,然后把这个 job 标记为必需.

## 8. 看板

`npm run notes:board` 会写出 `board.html` —— 一个单文件页面,通过浏览器目录选择器直接读取 notes 目录,无构建步骤、无服务. 换成 `--bundle` 则把所有 note 内嵌进去,得到可脱机副本或 Pages 部署件.

## 迁移已有存量

如果项目在别处已经有决策文档,只有当它们**仍然权威**时才搬进这棵树. 对每一篇:按它描述的对象选生命周期,按[分类规则](classification.md)选类别,文件名日期取该文档自己首次提交那天. 去掉旧的编号体系;如果大家会引用那些编号,就把它保留成一个 tag.

**描述的是代码早已放弃的决策的 note,不值得迁移.** 旧目录原地留着,该引用时引用它,然后让这棵树干干净净地开始.
