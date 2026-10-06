# dashboard/AGENTS.md -- 前端约定

> 只讲[动 dashboard/ 时才知道的事]. 通用约定见根 [AGENTS.md](../AGENTS.md).

## 无构建链(最重要的一条)
`dashboard/**` 全是 `.ts` 源, 由 `src/web/static.ts` 用 Node 的 `stripTypeScriptTypes` **剥类型后直投浏览器**.
**浏览器侧没有打包器/转译器** ---- 所以:
- **禁止**用浏览器不认的语法(装饰器/命名空间/枚举; `tsconfig.dashboard.json` 已开 `erasableSyntaxOnly` 拦截).
- 模块引用**必须写完整相对路径 + `.ts` 后缀**(浏览器不做后缀解析).
- **禁止**引入任何前端依赖(无 React/Vue/构建工具). 需要组件就手写 DOM.

## 目录职责
| 路径 | 职责 |
|---|---|
| `app.ts` | 装配入口 + import 方向唯一真源(app.ts -> views/shell -> 各视图 -> lib/*) |
| `lib/` | 通用能力: `dom.ts`(el/icon/$), `api.ts`(请求封装), `ui.ts`(toast/进度), `state.ts`, `editor.ts`(Monaco 封装) |
| `views/<页>/` | 各页面, 每个页面一个目录 |
| `views/shell/` | 外壳: 导航(`renderNav`)与路由分发(`hash` 路由) |
| `locale/dict/` | 文案词条, 按域分文件 |
| `css/` | 样式 |
| `vendor/` | 第三方产物(Monaco), **不参与门禁与类型检查** |

## 加一个新页面
1. `views/<名>/index.ts` 导出 `render<名>(view)`.
2. `views/shell/index.ts`: 加 import + `else if (route === '<名>')` 分支 + `renderNav` 的 items 加一项.
3. `locale/dict/` 加词条(`nav.<名>` 与页面文案); **禁止硬编码中文**(i18n 门禁会拦).
4. 样式加到 `css/`.

## 性能(硬性)
- **首屏必须秒开**. 重资源(如 Monaco 3.7MB)**一律懒加载** ---- 只在用户真的要用时才拉.
  实测教训: 进设置页就加载 Monaco 会让整页卡 6-8 秒; 改成点击才加载后恢复正常.
- 大体积第三方产物放 `vendor/`, 并在 `scripts/gates/rules.ts` 的 `TIERS.exempt` 与
  `tsconfig.dashboard.json` 的 `exclude` 里**同时豁免**(漏一处会让门禁或类型检查被灌爆).
- 改 `dashboard/**` 或静态资源加载方式后, 提交前**必须跑 e2e 加载速度套件**(见 [test/AGENTS.md](../test/AGENTS.md)).

## 交互纪律
- 任何遮罩/对话框**必须有可关闭路径**(按钮 / Esc / 点遮罩), 且不锁 `body` 滚动.
- 破坏性动作的默认焦点落在**更保守**的选项上(如取消).
- 危险配置要在**页面上**显式警告, 不要藏进 `title` tooltip ---- 藏起来的警告等于没有.

## 自查
```bash
npm run typecheck              # 覆盖 tsconfig.dashboard.json
node scripts/gates/run.ts code # 文本类红线(注释全角标点/markdown 语法)
```
