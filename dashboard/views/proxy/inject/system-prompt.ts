import { t } from '../../../locale/index.ts'
import { api } from '../../../lib/api.ts'
import { el } from '../../../lib/dom.ts'
import { createCodeEditor } from '../../../lib/editor.ts'
import { toast } from '../../../lib/ui.ts'

/** 当前编辑器句柄(模块级: 同一时刻页面上只有一个提示词编辑器). */
let editorRef: any = null

/**
 * 官方 system 提示词卡 -- 三态切换 + 自定义正文 + 一键恢复官方原文.
 *
 * 为什么需要这张卡(用户要求): 官方 worker 模板里明文要求模型调用
 * suggest_prompts / write_todos / request_elevation / 预览类工具. 其中一部分
 * 下游没有对应物, 模型照着提示词去调就会失败; 用户需要能
 *   - 看到官方原文到底要求了什么;
 *   - 换成自己的指令;
 *   - 或干脆整段不带;
 *   - 并且随时一键回到官方原文.
 *
 * 三态真源在服务端(src/web/store/config/settings-store.ts 的
 * officialSystemPromptMode). 本文件只做 DOM 与提交.
 *
 * @param {string} mode 当前态: official / custom / none
 * @param {string} text 当前自定义正文(官方态时为空)
 * @param {string} officialDefault 官方抓包原文(用于[恢复官方原文]按钮)
 * @param {boolean} disabled 非管理员时禁用交互
 * @returns {any} 卡片元素
 */
export function buildSystemPromptCard(
  mode: string, text: string, officialDefault: string, disabled: boolean,
) {
  /**
   * 正文用 Monaco(VSCode 同款) + One Dark Pro 渲染.
   *
   * 为什么不是 textarea: 官方 system 模板是 13KB 的整段文本, 纯 textarea 里
   * 既没有行号也没有高亮, 想改一句得靠肉眼找. 编辑器初始化是异步的(要加载
   * Monaco), 所以先放占位容器, 拿到句柄后再把值灌进去.
   *
   * 降级路径在 dashboard/lib/editor.ts: Monaco 加载失败时它自己回落成
   * textarea, 本文件不需要分支.
   */
  const holder = el('div', {
    class: 'system-prompt-holder', id: 'official-system-editor',
  })
  void createCodeEditor({
    value: text || '',
    language: 'plaintext',
    height: 320,
    onChange: () => {
      const flag = document.getElementById('official-system-dirty')
      if (flag) flag.style.display = 'inline'
    },
  }).then((ed: any) => {
    editorRef = ed
    holder.append(ed.element)
    ed.setReadOnly(disabled || mode !== 'custom')
  })

  // onchange 里按 id 回查而不是闭包引用 select: 自我引用会让类型推断退化成
  // HTMLElement(拿不到 .value), 而 .value 正是这里唯一需要的东西.
  const select = el('select', {
    class: 'input', id: 'official-system-mode',
    disabled: disabled ? '' : undefined,
    onchange: () => {
      const self = document.getElementById('official-system-mode') as HTMLSelectElement | null
      editorRef?.setReadOnly?.(disabled || (self?.value ?? 'official') !== 'custom')
      const flag = document.getElementById('official-system-dirty')
      if (flag) flag.style.display = 'inline'
    },
  }, [
    el('option', { value: 'official', selected: mode === 'official' ? '' : undefined },
      t('system.officialSystemModeOfficial')),
    el('option', { value: 'custom', selected: mode === 'custom' ? '' : undefined },
      t('system.officialSystemModeCustom')),
    el('option', { value: 'none', selected: mode === 'none' ? '' : undefined },
      t('system.officialSystemModeNone')),
  ])

  return el('div', { class: 'card settings-band', id: 'official-system-card', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.officialSystem')),
      el('span', { class: 'muted' }, t('system.officialSystemHint')),
    ]),
    el('div', { class: 'row', style: 'margin-top:10px;gap:8px;align-items:center' }, [
      el('span', { class: 'muted' }, t('system.officialSystemMode')),
      select,
      el('span', {
        class: 'muted', id: 'official-system-dirty', style: 'display:none',
      }, t('system.officialSystemDirty')),
    ]),
    holder,
    actionRow(disabled, officialDefault),
  ])
}

/**
 * 卡片的按钮行: 应用 / 恢复官方原文 / 查看官方原文.
 *
 * 抽成子函数而不是内联: 三个按钮各自带着 disabled 判据与回调, 内联会让
 * 卡片构造函数超过函数长度红线, 也不便单独读.
 *
 * @param {boolean} disabled 非管理员时全禁用
 * @param {string} officialDefault 官方抓包原文(为空时[恢复/查看]不可用)
 * @returns {any} 按钮行元素
 */
function actionRow(disabled: boolean, officialDefault: string) {
  return el('div', { class: 'row', style: 'margin-top:10px;gap:8px' }, [
    el('button', {
      class: 'btn btn-primary', type: 'button', id: 'official-system-apply',
      disabled: disabled ? '' : undefined,
      onclick: saveOfficialSystemPrompt,
    }, t('system.officialSystemApply')),
    el('button', {
      class: 'btn btn-sm', type: 'button', id: 'official-system-restore',
      disabled: disabled || !officialDefault ? '' : undefined,
      onclick: restoreOfficialSystemPrompt,
    }, t('system.officialSystemRestore')),
    el('button', {
      class: 'btn btn-sm', type: 'button', id: 'official-system-view',
      disabled: !officialDefault ? '' : undefined,
      onclick: () => {
        // 把官方原文灌进编辑器供对照: 不直接保存, 用户看清后再点[应用].
        const sel = document.getElementById('official-system-mode') as HTMLSelectElement | null
        editorRef?.setValue?.(officialDefault)
        editorRef?.setReadOnly?.(false)
        if (sel) sel.value = 'custom'
        const flag = document.getElementById('official-system-dirty')
        if (flag) flag.style.display = 'inline'
      },
    }, t('system.officialSystemView')),
  ])
}

/**
 * 保存官方 system 提示词配置.
 *
 * 提交的是[三态 + 当前正文]整份: 只切态不传正文会把已保存的自定义内容清空,
 * 所以两者一起提交(正文在非 custom 态下也保留, 用户切回去时还在).
 *
 * @param {any} event 应用按钮的 click 事件
 * @returns {Promise<void>} 无返回值
 */
export async function saveOfficialSystemPrompt(event: any) {
  const btn = event.currentTarget
  const sel = document.getElementById('official-system-mode') as HTMLSelectElement | null
  if (!sel || !editorRef) return
  btn.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        officialSystemPromptMode: sel.value,
        officialSystemPromptText: editorRef.getValue(),
      }),
    })
    toast(t('system.officialSystemSaved'))
    const flag = document.getElementById('official-system-dirty')
    if (flag) flag.style.display = 'none'
  } catch (err) {
    toast(err.message, true)
  }
  btn.disabled = false
}

/**
 * 一键恢复官方原文: 把抓包原文作为自定义正文保存, 并切到 custom 态.
 *
 * 为什么不直接切回 official 态: official 态的语义是[用抓包原文], 而用户点
 * [恢复官方原文]通常是想[先把原文放回输入框, 再在它基础上改]. 若只切态,
 * 输入框是空的, 用户看不到原文就无从改起. 这里把原文写进正文并按 custom 保存,
 * 行为与官方态在链路上等价(渲染出的 system 文本一致), 但用户看得见, 可再编辑.
 *
 * @returns {Promise<void>} 无返回值
 */
export async function restoreOfficialSystemPrompt() {
  const sel = document.getElementById('official-system-mode') as HTMLSelectElement | null
  if (!sel || !editorRef) return
  try {
    const s = await api('/api/settings')
    const def = typeof s.officialSystemPromptDefault === 'string' ? s.officialSystemPromptDefault : ''
    if (!def) {
      toast(t('system.officialSystemRestoreUnavailable'), true)
      return
    }
    sel.value = 'custom'
    editorRef.setReadOnly(false)
    editorRef.setValue(def)
    await saveOfficialSystemPrompt({ currentTarget: document.getElementById('official-system-apply') })
  } catch (err) {
    toast(err.message, true)
  }
}
