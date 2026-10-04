import { el } from './dom.js'

/**
 - 触发浏览器下载一个文本文件(不落任何服务器状态).
 *
 - 放在 lib 而不是某个视图:账号 JSON 导出,日志导出,凭据导出都要用它,
 - 三个视图各写一份 blob 下载是那类"复制粘贴的第三份就开始不一致"的代码.
 */

/**
 - 把一段文本作为文件下载到本地.
 - @param {string} name 下载文件名
 - @param {string} content 文件内容
 - @param {string} [mime] MIME 类型
 - @returns {void}
 */
export function downloadTextFile(name, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
