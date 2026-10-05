/**
 * 官方 CLI 的 User-Agent 指纹: chat 与裸 fetch 两条通道的 UA 取值.
 *
 * 全部取值来自对官方发布二进制的静态提取, 见 ../official-fingerprint.ts 的文件头.
 */

/**
 * 已知的官方 CLI 版本(提取自 freebuff@0.0.178 二进制):
 *   CODEBUFF_CLI_VERSION:"0.0.178"
 * 仅作离线兜底;在线时优先用 npm 上 freebuff 包的最新版本.
 * 见 .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
 */
export const KNOWN_CLI_VERSION = '0.0.178'

/**
 * 官方 chat/completions 的 UA 版本段 ---- 两段式, 逐字对齐真机抓包:
 *   ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2
 *
 * 版本段是字面量 0.0.0-test(二进制里 __PACKAGE_VERSION__ 未注入), 不是包版本号;
 * 第三段是 runtime/bun/1.4.2, 不是 runtime/browser.
 *
 * 不在中间插项目自有标记: 上游按 UA 指纹识别代理客户端.
 * 见 .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
 * 与 .agents/notes/implemented/bug-fix/2026-10-01-chat-ua-two-part.md
 * @param {string} [version] 覆盖版本段(默认对齐官方的 0.0.0-test)
 * @returns {string}
 */
export const OFFICIAL_CHAT_UA_VERSION = '0.0.0-test'
// 第三段固定在 runtime/bun/1.4.2; 抓包样本见 docs/reverse/14-captured-diff.md
export const OFFICIAL_CHAT_UA_SUFFIX =
  'ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2'
/**
 - 官方 chat/completions 的 UA  --  两段式,逐字对齐真机抓包(见上方本文件注释).
 - @param {string} [version] 覆盖版本段(默认对齐官方的 0.0.0-test)
 - @returns {string} 拼好的 User-Agent
 */
export function officialChatUserAgent(version = OFFICIAL_CHAT_UA_VERSION) {
  return (
    'ai-sdk/openai-compatible/' + version + '/codebuff ' + OFFICIAL_CHAT_UA_SUFFIX
  )
}

/**
 * 官方 BYOK 分支的 UA(二进制原文 .../freebuff-byok). 仅作参考: BYOK 是用户自带
 * key 的通道, 且本仓不实现该通道.
 * @param {string} [version] 版本段
 * @returns {string} 拼好的 User-Agent
 */
export function officialByokUserAgent(version = KNOWN_CLI_VERSION) {
  return 'ai-sdk/openai-compatible/' + version + '/freebuff-byok'
}

/**
 * 官方 CLI 的裸 fetch UA(非 chat 调用). 二进制原文:
 *   CODEBUFF_IS_BINARY:"true" 走 Bun 自带 UA.
 */
export const BUN_USER_AGENT = 'Bun/1.3.14'
