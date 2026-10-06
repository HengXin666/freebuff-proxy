# Agent Note: 设置页编辑器跨页残留句柄 ---- 重进设置页后 Monaco 永不挂载

Status: implemented

## Problem

2026-10-06 用户报[设置页 -> 系统提示词]分区里看不到编辑器. Playwright 实测(28287):

- `.monaco-editor` 节点数 0, holder 有高度但 0 个孩子
- `window.require` 是 undefined ---- Monaco 的 loader 一次都没被加载
- 卡片本身正常渲染, [恢复官方原文]按钮在

所以不是资源缺失(loader.js / editor.main.js / one-dark-pro.json 三个 URL 直连都 200).
真正的判据是: 首次进入设置页能挂上, 一旦离开设置页再回来就永久挂不上.
同一个浏览器会话里逐次探测(holder 的 `isConnected` 与 `editorRef`):

| 时刻 | holder.isConnected | editorRef.element.isConnected | .monaco-editor |
|---|---|---|---|
| 首次进设置页 + 切到该分区 | true | true | 1 |
| 离开设置页 | false | false | 0 |
| 再进设置页 + 切到该分区 | true | false | 0 |

根因: 设置页每次进入都用 `view.innerHTML = ''` 重建面板, 旧容器与旧编辑器 DOM 一起被丢弃,
但 `system-prompt.ts` 的模块级 `editorRef` 还指着那个已被丢弃的编辑器. 新容器走到
`if (editorRef) return` 就提前返回 ---- 挂载逻辑整个被跳过, 连 Monaco 都不去加载.

## Decision

`mountEditorWhenVisible` 在开头的等待循环之前, 先把上一次的编辑器释放并清空句柄:

```
if (editorRef && typeof editorRef.dispose === 'function') {
  try { editorRef.dispose() } catch { /* 已随旧页面回收 */ }
}
editorRef = null
```

同时补上 `editor.ts` 的一处泄漏: Monaco 自建的 model 不随 `editor.dispose()` 释放, 而提示词
是 7918 字符的全文 ---- 不显式销毁, 每重进一次设置页就在 model 表里留一份全文. 因此
`createCodeEditor` 记下 `editor.getModel()`, 在句柄的 `dispose` 里一并销毁.

## Consequences

- 每次进该分区都会先释放上一次的编辑器句柄与它的 model, 再挂新的;
  离开设置页再回来时编辑器正常出现(修复前为 0).
- `createCodeEditor` 的句柄新增 model 销毁, 重进不再在 model 表里残留全文.
- 成本: 每次重进要重建一次编辑器(实测 <300ms, 可接受).

## Alternatives considered

**什么都不做, 把 [挂载] 判据从 `editorRef` 换成 `holder.children.length`.** 否决: 那只是把
[有没有挂过]的判据换个写法, 旧编辑器与其 model 依旧留在内存里, 泄漏照旧.

**每次挂载前无条件 `createCodeEditor`(去掉任何提前返回).** 否决: 卡片与分区在同一页内可能被
重复构建, 无条件重建会让同一页出现两个编辑器与两份自动保存监听.

**把 `editorRef` 挂在 DOM 上(如 `holder.dataset`)而不是模块变量.** 否决: 编辑器句柄是活对象,
挂 DOM 属性会让它的生命周期跟着节点走 ---- 而这里要的恰好相反: 释放时机由挂载逻辑掌握.

## Evidence

Playwright 实测(修复后, 2026-10-06):

```
first visit: monacoExists=true boxW=1116 boxH=640 viewLineCount=40 gutter 1..33
typing:      lastLine 末尾出现输入内容 (ok=true)
reenter:     monacoExists=true boxW=1116 boxH=640 viewLineCount=40
errors:      []
```

可证伪方式: 把 `editorRef = null` 那两行删掉重跑, 上面 reenter 一行立刻变 0
(修前实测就是 0).
