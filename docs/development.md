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
