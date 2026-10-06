/**
 * 设置快照的读取 -- 从 routes/control/settings.ts 按体量拆出.
 *
 * 拆出原因: 原文件补完[官方 system 提示词]回显后 346 行, 撞了后端 300 行硬红线.
 * 本文件只放[读], 写(校验 + 落盘)仍在 settings.ts.
 *
 * 真源约定: 这里回显的每个字段都必须在 settings-store.ts 里有对应的读回逻辑,
 * 否则表现为[控制台改了, 重启就自己变回去].
 */
import fs from 'node:fs'

import { TUNABLES } from '../../../../config/tunable/specs.ts'
import {
  snapshotTunables, secretsEffective,
} from '../../../../config/tunable/store.ts'
import { OFFICIAL_TOOL_META } from '../../../../upstream/signals/tools/official-tool-select.ts'

/**
 * 提示词占位符名单与可用性.
 *
 * 语法与官方一致({CODEBUFF_NAME}, 见 orchestrator 的 PLACEHOLDER). filled 表示
 * 本代理能否给出真值 ---- 取不到的那些替换成空串(官方对没有值的占位符也是空串).
 */
const PROMPT_PLACEHOLDERS = [
  { name: 'CURRENT_DATE', filled: true, note: '当前日期(en-US 长格式)' },
  { name: 'AGENT_NAME', filled: true, note: '代理名(本代理恒为 Buffy)' },
  { name: 'USER_INPUT_PROMPT', filled: true, note: '本次用户消息' },
  { name: 'INITIAL_AGENT_PROMPT', filled: true, note: '首轮提示(有则填)' },
  { name: 'REMAINING_STEPS', filled: true, note: '剩余步数(有则填)' },
  { name: 'FILE_TREE_PROMPT', filled: false, note: '客户端文件树' },
  { name: 'FILE_TREE_PROMPT_SMALL', filled: false, note: '客户端文件树(小预算)' },
  { name: 'FILE_TREE_PROMPT_LARGE', filled: false, note: '客户端文件树(大预算)' },
  { name: 'GIT_CHANGES_PROMPT', filled: false, note: '客户端仓库 git 摘要' },
  { name: 'KNOWLEDGE_FILES_CONTENTS', filled: false, note: '客户端知识文件内容' },
  { name: 'PROJECT_ROOT', filled: false, note: '客户端项目根路径' },
  { name: 'USER_CWD', filled: false, note: '客户端工作目录' },
  { name: 'SYSTEM_INFO_PROMPT', filled: false, note: '客户端系统信息' },
]

/**
 * 读官方 system 抓包原文(worker 层).
 *
 * 为什么从文件直读而不是走 cli-bridge: cli-bridge 是 bun 侧的执行体,
 * 控制台(本进程)只为[恢复官方原文]按钮提供一份对照文本, 不需要执行任何上游逻辑.
 * 读不到时返回空串 ---- 前端据此把按钮置灰, 比给一份假文本安全.
 *
 * @returns {string} 官方 worker 层 system 原文;读不到为空串
 */
export function officialSystemPromptDefault() {
  try {
    const p = new URL(
      '../../../../../docs/reverse/captures/official-system-prompts.json',
      import.meta.url,
    )
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return typeof raw?.worker === 'string' ? raw.worker : ''
  } catch {
    return ''
  }
}

/**
 * 读快照:把内存设置与 config.yaml 默认值合成一个扁平对象.
 *
 * @param {any} config 运行配置
 * @param {any} settingsStore 运行设置存储
 * @returns {Record<string, any>} 前端消费的设置快照
 */
export function readSettings(config: any, settingsStore: any) {
  const s = settingsStore?.get() || {}
  return {
    freeToolSignatureEnabled: s.freeToolSignatureEnabled !== false,
    stripToolsOnSchemaRejection: s.stripToolsOnSchemaRejection === true,
    accountMaxConcurrency: s.accountMaxConcurrency ?? 2,
    // 账号调度模式('sticky' 默认 / 'spread' 并发优先)+ 溢出排队上限.
    accountSchedulingMode: s.accountSchedulingMode === 'spread' ? 'spread' : 'sticky',
    accountOverflowWaitMs: s.accountOverflowWaitMs ?? 15_000,
    blockPremiumModels: s.blockPremiumModels === true,
    // 第三方工具承载开关(见 settings-store 的接口注释).
    toolCarrierEnabled: s.toolCarrierEnabled !== false,
    // 额度保护:空闲自动释放秒数 + 单请求新会话预算.
    // 未在控制台保存过时回落 config.yaml 的默认值(默认 600s,见 config.js).
    idleReleaseSec: s.idleReleaseSec ?? config.session.idleReleaseSec ?? 600,
    maxNewSessionsPerRequest:
      s.maxNewSessionsPerRequest ?? config.limits.maxNewSessionsPerRequest ?? 2,
    // "低额度"分组阈值(FB).纯前端分组,不参与调度;0 = 关闭分组.
    lowBalanceThreshold: s.lowBalanceThreshold ?? 15,
    // 遥测上报开关:官方 CLI 会发 app_launched 等生命周期事件,我们默认不发.
    cliTelemetryEnabled: s.cliTelemetryEnabled === true,
    // 上游请求形态通道('legacy' 默认 / 'official' 照抄官方抓包).
    upstreamChannel: s.upstreamChannel === 'official' ? 'official' : 'legacy',
    // 官方工具注入: null = 未配置(全注入), 数组(含空) = 控制台配过的名单.
    // [未配置] 与 [空数组] 必须分开回显, 否则前端会把[全不注入]显示成[全注入].
    officialToolNames: Array.isArray(s.officialToolNames) ? s.officialToolNames : null,
    /** 官方 system 提示词三态与自定义正文(见 settings-store 接口注释). */
    officialSystemPromptMode:
      s.officialSystemPromptMode === 'custom' || s.officialSystemPromptMode === 'none'
        ? s.officialSystemPromptMode
        : 'official',
    officialSystemPromptText: typeof s.officialSystemPromptText === 'string'
      ? s.officialSystemPromptText
      : '',
    /**
     * 官方抓包原文: 前端[恢复官方原文]按钮需要它, 且必须是同一份真源
     * (docs/reverse/captures/official-system-prompts.json, 由 cli-bridge 读取).
     * 这里从文件直读只回 worker 层 ---- manager 层很长且用户改的多是 worker.
     */
    officialSystemPromptDefault: officialSystemPromptDefault(),
    /** 自动签到开关(默认关闭). 间隔固定 25 小时. */
    autoSignInEnabled: s.autoSignInEnabled === true,
    /** 官方工具分类目录(分组 + 一句话说明), 前端据此渲染勾选列表. */
    officialToolCatalog: OFFICIAL_TOOL_META,
    /**
     * 系统提示词里可用的占位符与各自的可用性.
     *
     * 前端据此在编辑器上方给出说明 ---- 用户改了正文也能继续复用这些占位符.
     * filled=false 的那些取值来自客户端本地上下文, 本代理拿不到, 会被替换成空串.
     */
    promptPlaceholders: PROMPT_PLACEHOLDERS,
    /**
     * 可调项(除 server.host/port 外的全部).
     *
     * 与上面那批实时字段是两套东西, 不要混:
     *   - 实时字段: 保存即生效(走 getter);
     *   - 可调项:   保存后需重启才生效(启动时合并进 config).
     * 前端必须把这两类分开渲染并分别提示.
     *
     * 值来自 config 现值(已含启动时合并进的可调项), 所以这里回显的就是"当前生效值"
     * ---- 但凭据项(secret)例外: snapshotTunables 把它们的值一律写 null,
     * 只经 secrets 回[有没有设置]. 明文凭据不进任何响应体.
     */
    tunables: snapshotTunables(config),
    secrets: secretsEffective(config, settingsStore?.savedTunables?.() || {}),
    /** 可调项的声明(前端据此渲染控件类型/范围/分组), 与后端校验同一真源. */
    tunableSpecs: TUNABLES,
  }
}
