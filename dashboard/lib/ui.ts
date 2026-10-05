import { t } from '../locale/index.ts'
import { $ } from './dom.ts'

/**
 - 用户可见反馈:toast,顶部进度条,按钮加载态,剪贴板.
 *
 - 放一起的理由:这四件事共享同一条"必须有反馈"的判据 ---- 控制台里每个
 - 会发请求的按钮都要给出可见结果,缺了它用户就会重复点(历史上 ps-pool 的
 - "点了没反应"就是这条判据失守).它们也共享同一个 DOM 出口(#toast / #progress).
 */

/**
 - 弹一条 3.2 秒后自动消失的提示.
 - @param {string} msg 提示文案(应经 t() 取,勿写死中文)
 - @param {boolean} [isErr] 是否为错误样式
 - @returns {void}
 */
let toastTimer: any = null

export function toast(msg: any, isErr = false) {
  const box = $('#toast')
  if (!box) return
  box.textContent = msg
  box.classList.toggle('err', !!isErr)
  box.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => box.classList.remove('show'), 3200)
}

/**
 - 复制文本到剪贴板(navigator.clipboard 不可用时回落 execCommand).
 - @param {string} text 要写入剪贴板的文本
 - @returns {void}
 */
export function copyText(text: any) {
  const done = () => toast(t('common.copied'))
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
    return
  }
  fallbackCopy(text, done)
}

function fallbackCopy(text: any, done: any) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    done()
  } catch {
    toast(t('toast.copyFailSelect'), true)
  }
}

let progressTimer: any = null

/**
 - 启动顶部进度条(先冲到 70%,2 秒后自动补满).
 - @returns {void}
 */
export function startProgress() {
  const bar = $('#progress')
  bar.classList.remove('done')
  bar.style.width = '0'
  requestAnimationFrame(() => { bar.style.width = '70%' })
  clearTimeout(progressTimer)
  progressTimer = setTimeout(() => {
    bar.style.width = '100%'
    bar.classList.add('done')
  }, 2000)
}
/**
 - 立即收束顶部进度条.
 - @returns {void}
 */
export function endProgress() {
  clearTimeout(progressTimer)
  const bar = $('#progress')
  bar.style.width = '100%'
  bar.classList.add('done')
}

/**
 - 按钮加载态:把按钮内容换成 spinner,返回恢复函数(调用方负责在 finally 里调它).
 - @param {HTMLElement | null} btn 目标按钮(null 时返回空操作)
 - @param {string} [busyText] 加载期间显示的文字
 - @returns {() => void} 恢复按钮原内容与禁用态的收尾函数
 */
export function withButtonLoading(btn: any, busyText = '') {
  if (!btn) return () => {}
  const original = btn.innerHTML
  const wasDisabled = btn.disabled
  btn.disabled = true
  btn.classList.add('btn-loading')
  btn.innerHTML = `<span class="spinner" style="border-color:currentColor;border-top-color:transparent"></span>${busyText ? `<span>${busyText}</span>` : ''}`
  return () => {
    btn.innerHTML = original
    btn.disabled = wasDisabled
    btn.classList.remove('btn-loading')
  }
}
