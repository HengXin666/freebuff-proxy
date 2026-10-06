/**
 * 官方 system 模板的[占位符形态]: 把抓包快照里的动态段换回官方占位符.
 *
 * 抓包文件(docs/reverse/captures/official-system-prompts.json)存的是渲染后的文本,
 * 里面三条动态内容被冻在抓包那一刻: 日期(October 3, 2026), 仓库统计(69/5),
 * 变更文件块. 官方源码里的同一份模板写的是 ${PLACEHOLDER2.CURRENT_DATE} /
 * ${PLACEHOLDER2.KNOWLEDGE_FILES_CONTENTS} / ${PLACEHOLDER2.GIT_CHANGES_PROMPT}.
 *
 * 控制台把正文给人看给人改, 必须给模板形态而不是[别人机器那次渲染的结果] ----
 * 否则用户改完保存, 出站文本里就带着抓包当天的日期与别人的仓库统计.
 *
 * 只做形态还原, 不做任何取值: 运行时渲染仍走 cli-bridge 的 renderWorkerSystem.
 * 判据见 .agents/notes/implemented/bug-fix/2026-10-06-effort-chip-click-and-template-placeholder.md
 */

/** 官方日期占位符在模板里的写法(语法与 orchestrator 的 PLACEHOLDER 一致). */
export const PLACEHOLDER_CURRENT_DATE = '{CODEBUFF_CURRENT_DATE}'

/** 知识文件内容的占位符(官方模板里 K 与 G 两块各占一行). */
export const PLACEHOLDER_KNOWLEDGE = '{CODEBUFF_KNOWLEDGE_FILES_CONTENTS}'

/** 仓库上下文(git 摘要 + 统计 + 变更文件)的占位符, 官方一个占位符生成整块. */
export const PLACEHOLDER_GIT_CHANGES = '{CODEBUFF_GIT_CHANGES_PROMPT}'

/** git 上下文块的起始锚点(官方 GIT_CHANGES_PROMPT 提供器输出的首句). */
const GIT_HEAD = 'Git repository summary captured at the start of the conversation.'

/** git 上下文块的结束锚点. */
const GIT_TAIL = '</changed_file_paths>'

/**
 * 把渲染后的官方文本还原成占位符形态.
 *
 * 三处替换:
 *   1. Current date 那一行 -> 官方日期占位符;
 *   2. 从 git 摘要首句到 changed_file_paths 闭标签的整块 -> 仓库上下文占位符;
 *   3. 该块之前原本属于知识文件占位符的空行 -> 知识文件占位符.
 *
 * 找不到锚点时原样返回: 模板换代后宁可不改, 也不要按猜测截断正文.
 *
 * @param {string} rendered 渲染后的官方文本(抓包快照)
 * @returns {string} 占位符形态的模板文本
 */
export function toPlaceholderTemplate(rendered: any): string {
  const src = typeof rendered === 'string' ? rendered : ''
  if (!src) return ''
  let out = src.replace(/Current date: [^\n]*/, `Current date: ${PLACEHOLDER_CURRENT_DATE}.`)
  const head = out.indexOf(GIT_HEAD)
  const tail = head >= 0 ? out.indexOf(GIT_TAIL, head) : -1
  if (head < 0 || tail < 0) return out
  const end = tail + GIT_TAIL.length
  // 该块之前是[知识文件占位符渲染成空串]留下的空行: 还原成占位符本身.
  let cut = head
  while (cut > 0 && out[cut - 1] === '\n') cut -= 1
  const prefix = out.slice(0, cut)
  const gap = out.slice(cut, head)
  const restoredGap = gap.includes('\n\n\n\n')
    ? `\n\n${PLACEHOLDER_KNOWLEDGE}\n\n`
    : gap
  out = prefix + restoredGap + PLACEHOLDER_GIT_CHANGES + out.slice(end)
  return out
}

/**
 * 占位符形态 -> 渲染后文本(测试与对照用: 复原快照必须以它自证).
 *
 * 只填三处已知动态段; 其余占位符替换成空串(与 applyPlaceholders 的官方行为一致).
 *
 * @param {string} template 占位符形态文本
 * @param {{ date?: string, knowledge?: string, gitChanges?: string }} values 三处动态值
 * @returns {string} 渲染后文本
 */
export function renderTemplateForCompare(template: any, values: any = {}): string {
  return String(template || '')
    .replaceAll(PLACEHOLDER_CURRENT_DATE, values.date ?? '')
    .replaceAll(PLACEHOLDER_KNOWLEDGE, values.knowledge ?? '')
    .replaceAll(PLACEHOLDER_GIT_CHANGES, values.gitChanges ?? '')
}
