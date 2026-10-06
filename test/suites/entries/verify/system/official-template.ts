/**
 * 官方 system 模板的[占位符形态] -- 控制台给人看的必须是模板, 不是抓包那次渲染结果.
 *
 * 判据(可证伪): 去掉 toPlaceholderTemplate 的三处替换, 或让它原样返回,
 * 本文件即红在[快照里的冻结内容必须被换成占位符].
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  PLACEHOLDER_CURRENT_DATE, PLACEHOLDER_GIT_CHANGES, PLACEHOLDER_KNOWLEDGE,
  renderTemplateForCompare, toPlaceholderTemplate,
} from '../../../../../src/upstream/system/official-template.ts'

const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..', '..')
const SNAPSHOT = path.join(ROOT, 'docs/reverse/captures/official-system-prompts.json')
const raw: any = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

const worker: string = raw.worker
const tpl = toPlaceholderTemplate(worker)

// -- (1) 三处动态内容必须被换成占位符 ------------------------------------
ok(tpl.includes(PLACEHOLDER_CURRENT_DATE), '日期必须换成 {CODEBUFF_CURRENT_DATE}')
ok(tpl.includes(PLACEHOLDER_GIT_CHANGES), '仓库上下文必须换成 {CODEBUFF_GIT_CHANGES_PROMPT}')
ok(tpl.includes(PLACEHOLDER_KNOWLEDGE), '知识文件块必须换成 {CODEBUFF_KNOWLEDGE_FILES_CONTENTS}')

// -- (2) 快照里那些[属于别人那次运行]的冻结值必须消失 --------------------
ok(!/Current date: October 3, 2026/.test(tpl), '不得残留抓包当天的日期')
ok(!/indexed_project_files: 69/.test(tpl), '不得残留抓包那台机器的文件数')
ok(!/detected_test_files: 5/.test(tpl), '不得残留抓包那台机器的测试数')
ok(!/Git metadata unavailable to this host/.test(tpl), '不得残留抓包那次的无 git 文案')

// -- (3) 静态部分必须逐字节保留(不能顺手改到正文) ----------------------
ok(tpl.startsWith('You are Buffy, the coding agent behind Codebuff.'), '开场必须保留')
ok(tpl.includes('Use write_todos to plan and track multi-step tasks.'), '规则条目必须保留')
ok(tpl.includes('# Freebuff Desktop'), 'Desktop 段必须保留')
ok(tpl.length > 3000, `模板不应被截断, got ${tpl.length} 字节`)

// -- (4) 往返自证: 用原值渲染回去必须与快照逐字节相同 --------------------
{
  const head = worker.indexOf('Git repository summary captured at the start of the conversation.')
  const tail = worker.indexOf('</changed_file_paths>') + '</changed_file_paths>'.length
  const gitBlock = worker.slice(head, tail)
  const back = renderTemplateForCompare(tpl, {
    date: 'October 3, 2026', knowledge: '', gitChanges: gitBlock,
  })
  ok(back === worker, '模板渲染回去必须与抓包快照逐字节相同(否则说明还原动了不该动的地方)')
}

// -- (5) 锚点缺失时原样返回(不猜不截断) --------------------------------
{
  const orphan = 'no anchors here at all'
  ok(toPlaceholderTemplate(orphan) === orphan, '找不到锚点时必须原样返回')
  ok(toPlaceholderTemplate('') === '', '空串必须返回空串')
  ok(toPlaceholderTemplate(null) === '', '非字符串必须安全返回空串')
}

// -- (6) /api/settings 回给前端的就是占位符形态 -------------------------
{
  const { officialSystemPromptDefault } = await import(
    '../../../../../src/web/routes/control/settings/read.ts'
  )
  const served = officialSystemPromptDefault()
  ok(served.includes(PLACEHOLDER_CURRENT_DATE), '控制台拿到的默认正文必须是占位符形态')
  ok(served.includes(PLACEHOLDER_GIT_CHANGES), '控制台默认正文必须含仓库上下文占位符')
  ok(!/October 3, 2026/.test(served), '控制台默认正文不得带抓包当天的日期')
}

console.log(`官方模板占位符形态验证通过(断言 ${n} 条)`)
