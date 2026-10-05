/**
 - chat 端点 -- 从 cli-bridge/upstream.ts 的 Bridge.chat 搬出.
 - 各段构造见 ./chat-payload.ts; 这里只做编排.
 */
import { dumpReq } from '../wire/dump.ts'
import { loadOfficialAssets } from '../assets.ts'
import {
  buildTools, buildSystemMessages, buildMetadata,
  buildBody, buildHeaders, extractMessageId,
} from './chat-payload.ts'

/**
 - chat: 逐字段照抄官方抓包(worker 层形态).
 - @param {any} bridge Bridge 实例
 - @param {{row: any, instanceId: string, runId: string, messages: any[], tools: any[], stream?: boolean, layer?:
 - string, reasoningEffort?: string|null, noSend?: boolean}} opts 参数
 - @returns {Promise<any>} chat 结果
 */
export async function chat(bridge, opts) {
  const {
    row, instanceId, runId, messages, tools,
    stream = true,
    layer = 'worker',
    reasoningEffort = null,
    noSend = false,
  } = opts;
const url = `${bridge.host}/api/v1/chat/completions`;
const { OFFICIAL_TOOLS, OFFICIAL_DECIDE, OFFICIAL_SYS } = await loadOfficialAssets();
const outTools = buildTools(layer, tools, OFFICIAL_TOOLS, OFFICIAL_DECIDE);
const outMessages = buildSystemMessages(messages, layer, OFFICIAL_SYS);
const metadata = await buildMetadata({ bridge, layer, runId, instanceId, reasoningEffort });
const body = buildBody({ row, metadata, outMessages, outTools, layer, stream });
const hdrs = await buildHeaders(bridge, url, body);
await dumpReq(`chat-${layer}`, 'POST', url, hdrs, body);
if (noSend) return { status: 0, text: '(dry-run, not sent)' };
await dumpReq('chat', 'POST', url, hdrs, body);
const res = await fetch(url, { method: 'POST', headers: hdrs, body });
const text = await res.text();
const messageId = extractMessageId(text);
return { status: res.status, text, messageId };
}
