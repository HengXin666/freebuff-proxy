/**
 - 官方 CLI 的 User-Agent 指纹  --  chat 与裸 fetch 两条通道的 UA 真值.
 *
 * 为什么单独成文件: 原 official-fingerprint.ts 569 行超 300 红线. UA 是本仓
 * 最常被单独查证的一条指纹(UA 里多一个自有标记就会被上游按代理客户端识别),
 * 它与头部名/实例 id 是三类互不相干的东西, 放一起会淹没它.
 *
 * 全部取值来自对官方发布二进制的静态提取, 见 ../official-fingerprint.ts 的文件头.
 */

/**
 * 已知的官方 CLI 版本(提取自 freebuff@0.0.178 二进制):
 *   CODEBUFF_CLI_VERSION:"0.0.178"
 * 仅作离线兜底;在线时优先用 npm 上 freebuff 包的最新版本.
 */
/*
 * 决策与四处偏差的原文锚点见
 * .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
 */
export const KNOWN_CLI_VERSION = '0.0.178'

/**
 * 官方 chat/completions 的 UA ---- 两段式,逐字对齐真机抓包.
 *
 * 实测(mitmproxy 抓官方 CLI 0.2.6):
 *
 * ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser
 *
 *
 *  但 desktop 客户端的第三段是 runtime/bun/1.4.2,不是 browser:
 * 2026-10-03 抓包(官方 desktop 经 HTTP_PROXY 走 mitm 解密,
 * docs/reverse/captures/2026-10-03-official-client.jsonl)实测为
 *   .../codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2
 * 因为官方 orchestrator 本身就是 bun 跑的.
 * 本仓库走 desktop 路线,故 OFFICIAL_CHAT_UA_SUFFIX 取 bun 形态.
 *
 * 两个此前搞错的点:
 *
 * 1. 版本是 0.0.0-test,不是真实 CLI 版本号. 二进制原文:
 *    Qo=typeof __PACKAGE_VERSION__<"u"?__PACKAGE_VERSION__:"0.0.0-test"
 *    ---- 官方发布构建里该变量未注入,于是回退到字面量 0.0.0-test.
 *    我们此前发 0.0.178(包版本),反而与官方不一致.
 * 2. 后面还有第二段(ai-sdk 的 provider-utils 与 runtime 标记),我们整段漏了.
 *
 * 绝不能在中间插项目自有标记(freebuff-proxy 等):上游按 UA 指纹代理客户端.
 * 见 .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
 * 与 .agents/notes/implemented/bug-fix/2026-10-01-chat-ua-two-part.md
 * @param {string} [version] 覆盖版本段(默认对齐官方的 0.0.0-test)
 * @returns {string}
 */
export const OFFICIAL_CHAT_UA_VERSION = '0.0.0-test'
//  第三段是 runtime/bun/1.4.2,不是 runtime/browser.
//
// 真机抓包(2026-10-03,官方 desktop 客户端经 mitm 解密,
// docs/reverse/captures/2026-10-03-official-client.jsonl):
//   User-Agent: ai-sdk/openai-compatible/0.0.0-test/codebuff
//               ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2
// 官方 orchestrator 就是 bun 跑的,所以 runtime 段是 bun 而非 browser.
// 此前写成 browser 是按 CLI 侧抓包填的 ---- 与 desktop 路线不符.
// 见 docs/reverse/14-captured-diff.md
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
 * 官方 BYOK 分支的 UA(二进制原文 .../freebuff-byok).仅作参考:BYOK 是用户自带
 * key 的通道,与免费模式相反,不要用它冒充免费客户端.
 * @param {string} [version]
 * @returns {string}
 */
export function officialByokUserAgent(version = KNOWN_CLI_VERSION) {
  return 'ai-sdk/openai-compatible/' + version + '/freebuff-byok'
}

/**
 * 官方 CLI 的裸 fetch UA(非 chat 调用).二进制原文:
 *   CODEBUFF_IS_BINARY:"true" 走 Bun 自带 UA;对齐 trefeon bunUserAgent.
 */
export const BUN_USER_AGENT = 'Bun/1.3.14'
