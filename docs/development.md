# 命令与本地开发

> 本文是 [freebuff-proxy](../README.md) 的详细文档之一。npm 脚本、本地启动、CLI 登录、冒烟测试。
> 快速上手 / 一键部署请看 [主页 README](../README.md)。
## 命令 / 本地开发

```bash
npm install
npm run doctor    # 检查配置 / 凭据 / 上游连通
npm start         # 本地启动反代（默认 ./config.yaml，数据在 ./data）
npm run login     # CLI 方式浏览器登录（同样不会在容器内打开浏览器）
npm test          # 冒烟测试（mock 上游，不消耗真实额度）
npm run typecheck
```

可选 `node bin/serve.js --config /path/to/config.yaml`。
## 发版

版本真源是 `package.json` 的 `version`（CI 的 `check-version` job 会校验 tag 与它一致）。
正常发版**只有一条命令**，不要分两步做：

```bash
npm version patch -m "chore(release): %s"   # 自动 bump + commit + 打 v* tag
git push origin main --tags
```

⚠️ **不要把 `npm version --dry-run` 当预演用**。实测 npm 12.0.2 下它**不是只读的**：
照样会改 `package.json` / `package-lock.json`、建一个版本提交并打上 tag。用它"看一眼版本号"，
再跑一次正式命令，就会得到**两个** release 提交和**两个** tag。想预览下一个版本号，用：

```bash
node -p "require('./package.json').version"   # 当前版本
git tag --sort=-v:refname | head -1             # 最近一个 tag
```

如果真的多生了 tag（尚未 push），清理方式是删掉本地 tag 并把分支退回 feat 提交，再重做一次：

```bash
git tag -d v1.14.4 v1.14.5        # 删掉多出来的 tag
git reset --mixed HEAD~2          # 分支退回，工作区改动保留
git restore package.json package-lock.json
```

`npm version` 会把改动**直接提交**，所以它要求工作区干净：有未提交改动时它会拒绝执行（这是好事，
避免把无关改动卷进版本提交）。先提交功能改动，再 bump 版本。
