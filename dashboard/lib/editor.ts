/**
 * 代码编辑器: VSCode 同款 Monaco + One Dark Pro 主题.
 *
 * ## 为什么 vendor 而不是 CDN
 *
 * 控制台常在没有外网的环境里跑(离线部署 / 内网). CDN 版一旦拉不到, 提示词
 * 编辑器就直接变白板 ---- 而它恰恰是排障时最需要的那个输入框. 所以把 Monaco
 * 压到最小集合放进 dashboard/vendor/monaco/(约 4.2MB, 见该目录的 README).
 *
 * ## 加载方式
 *
 * Monaco 是 AMD 形态: 先 loader.js 定义 require, 配置 vs 路径, 再
 * require(['vs/editor/editor.main']). 全程不打包 ---- 与本仓[前端无构建链]
 * 的约定一致.
 *
 * ## 降级
 *
 * 加载失败(文件缺失 / 被 CSP 拦 / 网络盘中转失败)时回落成原生 textarea,
 * 而不是留一个白框: 编辑器拿不到不该把"改提示词"这个能力一起废掉.
 */
import { el } from './dom.ts'

/** 已发起过的加载 promise(模块级: Monaco 全页只该加载一次). */
let monacoPromise: Promise<any> | null = null
/** 主题是否已注册(注册一次即可). */
let themeRegistered = false

/**
 * 按需加载 Monaco(只加载一次).
 *
 * @returns {Promise<any|null>} monaco 命名空间;加载失败为 null
 */
function loadMonaco(): Promise<any> {
  if (monacoPromise) return monacoPromise
  monacoPromise = new Promise((resolve) => {
    try {
      const w = window as any
      // loader.js 是 UMD, 用 script 标签加载后它把 require 挂到 window.
      const s = document.createElement('script')
      s.src = './vendor/monaco/vs/loader.js'
      s.onload = () => {
        try {
          const req = w.require
          if (!req) { resolve(null); return }
          // baseUrl 必须指到 vs 的父目录: Monaco 会去拿 vs/editor/editor.main.js
          req.config({ paths: { vs: './vendor/monaco/vs' } })
          req(['vs/editor/editor.main'], (monaco: any) => resolve(monaco || null), () => resolve(null))
        } catch { resolve(null) }
      }
      s.onerror = () => resolve(null)
      document.head.append(s)
    } catch {
      resolve(null)
    }
  })
  return monacoPromise
}

/**
 * 注册 One Dark Pro 主题(带缓存; 同一页只注册一次).
 *
 * 主题 JSON 是 VSCode 主题格式(colors + tokenColors), Monaco 的
 * defineTheme 直接吃这个结构, 所以不需要转换脚本.
 *
 * @param {any} monaco monaco 命名空间
 * @returns {Promise<boolean>} 注册成功为真
 */
async function ensureTheme(monaco: any): Promise<boolean> {
  if (themeRegistered) return true
  try {
    const res = await fetch('./vendor/monaco/one-dark-pro.json')
    if (!res.ok) return false
    const theme = await res.json()
    monaco.editor.defineTheme('one-dark-pro', {
      base: 'vs-dark',
      inherit: true,
      rules: (theme.tokenColors || []).map((t: any) => ({
        token: typeof t.scope === 'string' ? t.scope : (t.scope || []).join(','),
        ...(t.settings || {}),
      })),
      colors: theme.colors || {},
    })
    themeRegistered = true
    return true
  } catch {
    return false
  }
}

/**
 * 建一个代码编辑器(优先 Monaco, 失败回落 textarea).
 *
 * 返回的对象形状对两种实现一致, 调用方不需要分支:
 *   { getValue(), setValue(v), element, dispose(), isMonaco }
 *
 * @param {any} opts 选项对象(value / language / height / onChange)
 * @returns {Promise<any>} 编辑器句柄
 */
export async function createCodeEditor(opts: any) {
  const { value = '', language = 'plaintext', height = 320, onChange } = opts
  const monaco = await loadMonaco()
  if (monaco) {
    const themed = await ensureTheme(monaco)
    const host = el('div', { class: 'monaco-host', style: `height:${height}px` })
    const editor = monaco.editor.create(host, {
      value,
      language,
      theme: themed ? 'one-dark-pro' : 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineNumbers: 'on',
      wordWrap: 'on',
      tabSize: 2,
    })
    if (typeof onChange === 'function') {
      editor.onDidChangeModelContent(() => onChange(editor.getValue()))
    }
    return {
      element: host,
      isMonaco: true,
      getValue: () => editor.getValue(),
      setValue: (v: string) => editor.setValue(v ?? ''),
      setReadOnly: (ro: boolean) => editor.updateOptions({ readOnly: ro }),
      dispose: () => { try { editor.dispose() } catch { /* 已销毁 */ } },
    }
  }
  // 降级: 原生 textarea. 功能不减(读写值一致), 只是没有高亮.
  console.warn('[dashboard] monaco 加载失败, 回落 textarea')
  const ta = el('textarea', {
    rows: '14',
    style: `height:${height}px;width:100%;box-sizing:border-box`,
  }) as HTMLTextAreaElement
  ta.value = value
  if (typeof onChange === 'function') {
    ta.addEventListener('input', () => onChange(ta.value))
  }
  return {
    element: ta,
    isMonaco: false,
    getValue: () => ta.value,
    setValue: (v: string) => { ta.value = v ?? '' },
    setReadOnly: (ro: boolean) => { ta.readOnly = ro },
    dispose: () => { ta.remove() },
  }
}
