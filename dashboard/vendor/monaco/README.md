# vendor/monaco -- 第三方编辑器产物

本目录是 **Monaco Editor**(VSCode 的编辑器内核)的最小可用集合, 供控制台的
[官方系统提示词]输入框使用. 与 `data/` 同性质: **不是我们的代码**.

## 为什么 vendor 而不是 CDN

控制台常在没有外网的环境里跑(离线部署 / 内网). CDN 版拉不到时, 提示词编辑器
会直接变白板 ---- 而那正是排障时最需要的输入框.

## 内容与体积

| 文件 | 大小 | 作用 |
|---|---|---|
| `vs/editor/editor.main.js` | 3.7 MB | 编辑器主体(无法再裁) |
| `vs/editor/editor.main.css` | 129 KB | 编辑器样式 |
| `vs/base/worker/workerMain.js` | 368 KB | worker 宿主 |
| `vs/loader.js` | 30 KB | AMD loader |
| `vs/basic-languages/json/` | 若干 | 只留 JSON 高亮 |
| `one-dark-pro.json` | 37 KB | One Dark Pro 主题(见下) |

合计约 **4.2 MB**. 这是 Monaco 的**下限** ---- 上游 `min/` 全量是 14 MB
(含 40+ 语言与 7 MB 的 language server), 这里只取了 editor 核心 + JSON 高亮.

## 这两份东西从哪来

- Monaco: `npm pack monaco-editor@0.52.2` -> 取 `package/min/vs/**` 的上述子集.
- 主题: `npm pack @shikijs/themes@4.5.0` -> `dist/one-dark-pro.mjs` 里的官方
  One Dark Pro 主题 JSON(VSCode 主题格式, 222 项 colors + 275 条 tokenColors).
  Monaco 的 `defineTheme` 直接吃这个结构, 不需要转换.

## 升级方式

```bash
npm pack monaco-editor@<新版本>
tar xzf monaco-editor-*.tgz
cp package/min/vs/loader.js                                  dashboard/vendor/monaco/vs/
cp package/min/vs/editor/editor.main.js                      dashboard/vendor/monaco/vs/editor/
cp package/min/vs/editor/editor.main.css                     dashboard/vendor/monaco/vs/editor/
cp package/min/vs/base/worker/workerMain.js                  dashboard/vendor/monaco/vs/base/worker/
cp -r package/min/vs/basic-languages/json                    dashboard/vendor/monaco/vs/basic-languages/
```

## 门禁与它无关

- `tsconfig.dashboard.json` 的 `exclude` 已排除 `dashboard/vendor/**`
  (不排除会灌进 3.7 万个类型错误, 把棘轮基线冲掉).
- 体量 / 目录数门禁只看 `.ts/.css/.html`, 本目录的 `.js` 与 `.json` 不计入.

## 降级

`dashboard/lib/editor.ts` 在 Monaco 加载失败时**回落成原生 textarea** ----
编辑器拿不到不该把[改提示词]这个能力一起废掉.
