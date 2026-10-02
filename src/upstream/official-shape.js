/**
 * 官方请求体构造（**照抄抓包真值**，不再自己拼）。
 *
 * 背景：主服务原先的 `buildForwardBody()` 是自己拼 system 与工具集
 * （`ensureFreebuffSystemMessages` + `ensureFreebuffToolSignature`），
 * 来源是早期第三方项目 + 多年补丁，已无法与官方逐字段核对。
 * 2026-10-03 抓到官方客户端真实流量后，改为**直接用官方原文**：
 *   - 工具：官方 37 个（worker）/ 官方 decide（manager）
 *   - system：官方模板（worker 7918 字符 / manager 13443 字符）
 *   - agent：desktop 世代
 *
 * 资产来源：docs/reverse/captures/2026-10-03-official-client.jsonl
 * （本目录 official-assets/ 是其解析产物，随代码一起发布，避免 docs 被裁剪）。
 *
 * 详见 docs/reverse/14-captured-diff.md 与 15-protocol-review.md。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, 'official-assets')

function loadJson(name) {
  try {
    return JSON.parse(readFileSync(join(ASSETS, name), 'utf8'))
  } catch {
    return null
  }
}

/** 官方 37 个工具（worker 层）完整定义。 */
export function officialWorkerTools() {
  return loadJson('official-tools.json') || []
}

/** 官方 decide 工具（manager 层，1 个）。 */
export function officialManagerTools() {
  return loadJson('official-tool-decide.json') || []
}

/** 官方 system 模板：{ manager, worker }。 */
export function officialSystemPrompts() {
  return loadJson('official-system-prompts.json') || {}
}

/**
 * desktop 世代的 agent id（抓包真值）。
 *   manager → freebuff-desktop-autorun        (line 11/58)
 *   worker  → freebuff-desktop-thread-local-v3 (line 36)
 *
 * ⚠️ 主服务此前用 CLI 世代的 `base3-free-catalog` —— 世代错配。
 */
export function officialAgentId(layer = 'worker') {
  return layer === 'manager'
    ? 'freebuff-desktop-autorun'
    : 'freebuff-desktop-thread-local-v3'
}

/**
 * 渲染 manager 层 system。
 *
 * 抓包提取的模板尾部嵌着**当时那条**用户消息
 * （如 `USER_TURN_MARKER: create file /tmp/user-turn-proof.txt...`）。
 * 原样发出会变成"每次都告诉上游我要建这个文件"，必须按当前请求替换。
 *
 * 模板尾部形态：
 *   ...固定前缀...\n\n{mission}\n\nCall the `decide` tool exactly once. ...
 */
export function renderManagerSystem(tpl, mission) {
  let out = String(tpl || '')
  const anchor = '\n\nCall the `decide` tool'
  const ai = out.lastIndexOf(anchor)
  if (ai > 0) {
    const head = out.slice(0, ai)
    const cut = head.lastIndexOf('\n\n')
    if (cut > 0) {
      out = head.slice(0, cut) + '\n\n' + String(mission || '') + out.slice(ai)
    }
  }
  return out
}

/**
 * 渲染 worker 层 system。
 *
 * 官方模板含两个动态区块 `<repository_stats>` / `<changed_file_paths>`
 * 与一句 `Current date: ...`。不填会成为新的不一致。
 */
export function renderWorkerSystem(tpl, opts = {}) {
  const date =
    opts.date ||
    new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  let out = String(tpl || '')
  out = out.replace(/Current date: [^\n]*/, `Current date: ${date}.`)
  const stats =
    opts.repositoryStats ||
    JSON.stringify({
      gitAvailable: false,
      repositoryVisibility: 'unknown',
      fileCount: 0,
      fileCountIsLowerBound: false,
      testFileCount: 0,
      changedFileCount: 0,
      changedFileScanTruncated: false,
    })
  out = out.replace('<repository_stats>', stats)
  out = out.replace('<changed_file_paths>', opts.changedFilePaths || '')
  return out
}

/**
 * 按层产出官方形态的 { tools, system, agentId, provider }。
 *
 * provider 也分层：
 *   manager → {"allow_fallbacks": true}
 *   worker  → {"data_collection": "deny"}
 *
 * @param {object} opts
 * @param {'worker'|'manager'} [opts.layer]
 * @param {string} [opts.mission] 当前用户消息（manager 层用于替换 mission 段）
 * @param {object} [opts.repositoryStats] worker 层的 repo 统计
 * @returns {{tools: any[], system: string | null, agentId: string, provider: object}}
 */
export function officialChatShape(opts = {}) {
  const layer = opts.layer || 'worker'
  const prompts = officialSystemPrompts()
  const tpl = prompts?.[layer] || prompts?.worker
  const tools =
    layer === 'manager' ? officialManagerTools() : officialWorkerTools()
  const system = !tpl
    ? null
    : layer === 'manager'
      ? renderManagerSystem(tpl, opts.mission || '')
      : renderWorkerSystem(tpl, { repositoryStats: opts.repositoryStats })
  return {
    tools,
    system,
    agentId: officialAgentId(layer),
    provider:
      layer === 'manager'
        ? { allow_fallbacks: true }
        : { data_collection: 'deny' },
  }
}
