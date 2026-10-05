/**
 - serve.ts -- OpenAI 兼容服务(Node 侧入口),上游请求交给 bun 执行.
 *
 - 端点:
 - GET  /v1/models
 - POST /v1/chat/completions      (stream / 非 stream)
 - GET  /healthz
 *
 - 与 freebuff-proxy 的关系:独立实现,不改动它.
 - 本目录是验证[用官方 bun 运行时承载上游请求]的可行性,
 - 结论成立后再决定如何并回主项目.
 *
 - 实现已按职责拆进 cli-bridge/serve/**(sse / http / catalog / catalog-state /
 - handler);本文件保留入口与装配,所以启动命令与端口行为完全不变.
 */

import { createServer } from 'node:http';
import { BUN_BIN, hasBun, loadConfig } from './bridge.ts';
import { setConfig } from './serve/api/catalog.ts'
import { handleRequest } from './serve/api/handler.ts'

if (!hasBun()) {
  console.error(
    `[cli-bridge] bun not found (looked at: ${BUN_BIN}).\n` +
      `[cli-bridge] run: sh tools/fetch-bun.sh\n` +
      `[cli-bridge] or set FREEBUFF_BUN_BIN=/path/to/bun`,
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8791);
const HOST_BIND = process.env.HOST || '127.0.0.1';

// 可用环境变量指定账号(客户端未登录 / 想用另一个号时).
// 例:FREEBUFF_TOKEN=xxx FREEBUFF_USER_ID=xxx node serve.ts
//
// 为什么需要:loadConfig() 默认读官方客户端的登录态,一台机器同时只有
// 一个登录账号;而多账号池场景常常要显式指定用哪个号.
const override = {}
if (process.env.FREEBUFF_TOKEN) override.token = process.env.FREEBUFF_TOKEN
if (process.env.FREEBUFF_USER_ID) override.userId = process.env.FREEBUFF_USER_ID
if (process.env.FREEBUFF_INSTALL_ID) {
  override.installId = process.env.FREEBUFF_INSTALL_ID
}
const CONFIG = await loadConfig(override);
setConfig(CONFIG);

const server = createServer(handleRequest);
server.listen(PORT, HOST_BIND, () => {
  console.log(`[cli-bridge] listening http://${HOST_BIND}:${PORT}`);
  console.log(`[cli-bridge] credential source: ${CONFIG.source} (${CONFIG.email})`);
  console.log(`[cli-bridge] device keyId: ${CONFIG.keyId ? 'yes' : 'no'}`);
});
