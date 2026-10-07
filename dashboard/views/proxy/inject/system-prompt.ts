/**
 * 官方系统提示词卡: 一个 VSCode 编辑器 + [保存] + [恢复官方原文].
 *
 * 手动保存(用户要求): 编辑后必须点[保存]才落盘 ----
 * 自动保存让"改了到底生效没有"无法判断, 而这段正文直接决定模型行为.
 * 未保存时状态栏显示[有未保存的改动], 保存成功后显示时间戳.
 * 内容始终按[自定义正文]保存; [恢复官方原文]就是把抓包原文写回编辑器并落盘,
 * 渲染出的 system 文本与[照抄官方]完全一致, 但用户看得见, 可继续改.
 *
 * 三态真源在服务端(src/web/store/config/settings-store.ts 的 officialSystemPromptMode).
 */
import { t } from '../../../locale/index.ts'
import { api } from '../../../lib/api.ts'
import { el } from '../../../lib/dom.ts'
import { createCodeEditor } from '../../../lib/editor.ts'
import { toast } from '../../../lib/ui.ts'

/** 编辑器句柄(同一时刻页面上只有一个). */
let editorRef: any = null
/** 已落盘的正文(用于判断是否有未保存改动). */
let savedText = ''
/** 未保存标记(编辑后置真, 保存成功后清除). */
let dirty = false

/**
 * 官方 system 提示词卡.
 *
 * @param {string} text 当前生效的正文
 * @param {string} officialDefault 官方抓包原文(用于[恢复官方原文])
 * @param {boolean} disabled 非管理员时禁用交互
 * @param {any[]} placeholders 可用占位符名单(名字 + 可用性)
 * @returns {any} 卡片元素
 */
export function buildSystemPromptCard(
  text: string, officialDefault: string, disabled: boolean, placeholders: any[] = [],
) {
  // 高度交给 CSS(.system-prompt-holder): 这里写死会和[占满高度]冲突.
  const holder = el('div', {
    class: 'system-prompt-holder', id: 'official-system-editor',
  })
  void mountEditorWhenVisible(holder, text || '', disabled)
  return el('div', { class: 'card settings-band', id: 'official-system-card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('system.officialSystem')),
        el('span', { class: 'muted' }, t('system.officialSystemHint')),
        el('div', { class: 'muted system-prompt-note' }, t('system.officialSystemTemplateNote')),
      ]),
      el('div', { class: 'row', style: 'gap:10px;align-items:center' }, [
        el('span', { class: 'muted', id: 'official-system-state' }, t('system.officialSystemUnchanged')),
        wrapToggle(),
        el('button', {
          class: 'btn btn-sm', type: 'button', id: 'official-system-restore',
          disabled: disabled || !officialDefault ? '' : undefined,
          onclick: () => restoreOfficialSystemPrompt(officialDefault),
        }, t('system.officialSystemRestore')),
        el('button', {
          class: 'btn btn-sm btn-primary', type: 'button', id: 'official-system-save',
          disabled: disabled ? '' : undefined,
          onclick: () => saveNow(true),
        }, t('system.officialSystemSave')),
      ]),
    ]),
    placeholderHelp(placeholders),
    holder,
  ])
}

/**
 * 占位符说明: 列出可用占位符, 点击插入到编辑器光标处.
 *
 * 用户改提示词时可以直接复用这些占位符 ---- 运行时会被替换成真值.
 * 取不到值的那些也列出来但标注[本代理取不到], 免得用户以为写了就有内容.
 *
 * @param {any[]} list 占位符名字与可用性
 * @returns {any} 说明块;名单为空时为 null
 */
function placeholderHelp(list: any[]) {
  if (!Array.isArray(list) || list.length === 0) return null
  const items = list.map((p: any) => el('button', {
    class: p.filled ? 'ph-chip' : 'ph-chip ph-chip-empty',
    type: 'button',
    title: (p.filled ? '' : t('system.phUnavailable') + ' ') + (p.note || ''),
    onclick: () => insertPlaceholder('{CODEBUFF_' + p.name + '}'),
  }, ['{CODEBUFF_' + p.name + '}']))
  return el('details', { class: 'ph-help' }, [
    el('summary', {}, t('system.phTitle')),
    el('div', { class: 'muted', style: 'font-size:12px;margin:6px 0' }, t('system.phHint')),
    el('div', { class: 'ph-list' }, items),
  ])
}

/**
 * 把占位符插入到编辑器光标处.
 *
 * @param {string} token 占位符文本
 * @returns {void} 无返回值
 */
function insertPlaceholder(token: string) {
  const ed = editorRef
  if (!ed) return
  try {
    ed.insert?.(token) ?? ed.setValue(String(ed.getValue() || '') + token)
  } catch {
    // 编辑器不可用时忽略(不阻塞用户手写)
  }
}

/**
 * 自动换行开关.
 *
 * 默认开(提示词是长行散文, 不折行会被右边缘切断); 用户想按原样看整行时可关.
 * 状态存在 localStorage, 刷新后保持.
 *
 * @returns {any} 开关元素
 */
function wrapToggle() {
  const saved = localStorage.getItem('fb-editor-wrap')
  const on = saved !== '0'
  const cb = el('input', {
    type: 'checkbox', id: 'official-system-wrap',
    checked: on ? '' : undefined,
  }) as HTMLInputElement
  cb.addEventListener('change', () => {
    localStorage.setItem('fb-editor-wrap', cb.checked ? '1' : '0')
    editorRef?.setWordWrap?.(cb.checked)
  })
  return el('label', { class: 'editor-wrap-toggle', title: t('system.officialSystemWrapHint') }, [
    cb, el('span', {}, t('system.officialSystemWrap')),
  ])
}

/**
 * 等容器可见后再挂编辑器.
 *
 * 设置页是[左侧分区切换]的: 非当前分区的容器 display:none, 在里面创建的
 * Monaco 量不到宽高, 表现是编辑器一片空白. 等有尺寸再建.
 *
 * 释放旧句柄这一步的由来见 [editor-remount note]:
 * .agents/notes/implemented/bug-fix/2026-10-06-editor-remount-after-page-reentry.md
 *
 * @param {any} holder 容器
 * @param {string} text 初始文本
 * @param {boolean} disabled 非管理员时禁用
 * @returns {Promise<void>} 无返回值
 */
async function mountEditorWhenVisible(holder: any, text: string, disabled: boolean) {
  /**
   * 先把上一次的编辑器放掉.
   *
   * 设置页每次进入都会重建卡片与容器: 旧编辑器连同它的 DOM 已经随旧页面被
   * 丢弃, 但这个模块级句柄还指着它. 不在这里清掉, 新容器就会因为[以为已经
   * 挂过]而永远挂不上编辑器(实测: 第二次进入设置页 monaco 节点为 0).
   */
  if (editorRef && typeof editorRef.dispose === 'function') {
    try { editorRef.dispose() } catch { /* 已随旧页面回收 */ }
  }
  editorRef = null
  /**
   * 等容器[进入 DOM 且有宽度]再挂编辑器.
   *
   * 两个必须等的原因:
   *   1. holder 由本卡片创建, 但卡片要等 buildSystemPromptCard 返回后才被
   *      挂进页面 ---- 一开始 isConnected 是 false, 此时直接 return 会导致
   *      编辑器永远不挂(实测: 一个 Monaco 请求都没发出).
   *   2. 非当前分区的容器是 display:none, 在里面建 Monaco 量不到宽度.
   * 等到就挂; 等满超时也挂 ---- 挂上后 editor.ts 的 ResizeObserver 还能补救,
   * 完全不挂则连补救机会都没有.
   */
  for (let i = 0; i < 60; i += 1) {
    if (holder.isConnected && holder.offsetWidth > 0) break
    await new Promise((r) => setTimeout(r, 80))
  }
  const ed = await createCodeEditor({
    value: text,
    // 用 markdown: 官方模板本身就是 markdown 结构(标题/列表/代码块/标签),
    // 按 md 着色比 plaintext 可读得多.
    language: 'markdown',
    // 高度由容器决定(CSS 给了 calc(100vh - 260px)), 这里传 100% 铺满它.
    // fill: 用[容器到视口底部的剩余空间], 整页就不会出竖直滚动条.
    height: 'fill',
    // 用保存的偏好(默认开; 关过就一直关).
    wordWrap: localStorage.getItem('fb-editor-wrap') === '0' ? 'off' : 'on',
    onChange: () => markDirty(),
  })
  editorRef = ed
  // 基线 = 本次挂载时的值: dirty 判据与[保存]按钮的初始禁用都靠它.
  savedText = String(text || '')
  if (holder) {
    setTimeout(() => {
      const b = document.getElementById('official-system-save') as HTMLButtonElement | null
      if (b) b.disabled = true
    }, 0)
  }
  holder.innerHTML = ''
  holder.append(ed.element)
  ed.setReadOnly(disabled)
}

/**
 * 标记为有未保存的改动, 由编辑器 onChange 调用, 不落盘.
 *
 * 手动保存的意义就在这里: 状态栏明确说"还没生效", 用户点[保存]才看到生效时间.
 *
 * @returns {void} 无返回值
 */
function markDirty() {
  dirty = true
  setState(t('system.officialSystemDirty'))
  const btn = document.getElementById('official-system-save') as HTMLButtonElement | null
  if (btn) btn.disabled = false
}

/**
 * 立即落盘当前正文(点[保存]时调用).
 *
 * @param {boolean} [notify] 是否弹提示(手动保存弹, 恢复官方原文时由调用方弹)
 * @returns {Promise<void>} 无返回值
 */
async function saveNow(notify: boolean) {
  const ed = editorRef
  if (!ed) return
  const value = String(ed.getValue() ?? '')
  const ok = await persist(value)
  if (!ok) return
  savedText = value
  dirty = false
  setState(t('system.officialSystemSavedAt', { time: new Date().toLocaleTimeString() }))
  const btn = document.getElementById('official-system-save') as HTMLButtonElement | null
  if (btn) btn.disabled = true
  if (notify) toast(t('system.officialSystemSaved'))
}

/**
 * 落盘当前正文.
 *
 * @param {string} value 正文
 * @returns {Promise<boolean>} 是否落盘成功
 */
async function persist(value: string): Promise<boolean> {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ officialSystemPromptMode: 'custom', officialSystemPromptText: value }),
    })
    return true
  } catch (err: any) {
    toast(err.message, true)
    return false
  }
}

/**
 * 写状态文案.
 *
 * @param {string} text 文案
 * @returns {void} 无返回值
 */
function setState(text: string) {
  const s = document.getElementById('official-system-state')
  if (s) s.textContent = text
}

/**
 * 恢复官方原文: 写回编辑器并落盘.
 *
 * @param {string} officialDefault 官方抓包原文
 * @returns {Promise<void>} 无返回值
 */
async function restoreOfficialSystemPrompt(officialDefault: string) {
  if (!editorRef || !officialDefault) return
  editorRef.setValue(officialDefault)
  savedText = officialDefault
  dirty = false
  await persist(officialDefault)
  setState(t('system.officialSystemSavedAt', { time: new Date().toLocaleTimeString() }))
  toast(t('system.officialSystemRestored'))
}

export { editorRef, markDirty, saveNow }

/**
 * 已落盘正文(切页时用于判断是否需要挽留).
 * @returns {string} 已保存的正文
 */
export function savedPromptText() {
  return savedText
}

/**
 * 是否有未保存改动.
 * @returns {boolean} 有未保存改动为真
 */
export function promptDirty() {
  return dirty
}
