/**
 * chat 端点 -- 从 cli-bridge/upstream.ts 的 Bridge.chat 搬出.
 * 各段构造见 ./chat-payload.ts; 这里只做编排.
 *
 * 流式语义(2026-10-05 修复): 上游 chat 恒为流式(docs/reverse/04), 本函数曾用
 * await res.text() 把整条流收完才返回 ---- 于是"上游不产完整篇回复 -> bun 子进程
 * 不返回 -> 主服务一个字节都吐不出来", 主服务 45s 调度预算耗尽后降级 legacy 形态,
 * 请求失败(线上 reqId 0f45afc1: rpc timeout 44784ms -> 428).
 *
 * 现在: stream 模式下把上游字节按行(SplitLines)流式写到 stdout, 不在内存里拼整份;
 * 最后一行是 END 帧 + 一行 JSON 汇总(供不需要正文的调用方). 非 stream 保持原样.
 *
 * stdout 协议(bun -> Node, 见 ../../bridge.ts 的 callBunStream):
 *   >JSON...\n          汇总对象(末行, 供 Promise 版 callBun 解析)
 *   其余行原样透传
 * 因此流式行一律不带前缀, 只有汇总行带 '>'.
 */
import { dumpReq } from '../wire/dump.ts'
import { loadOfficialAssets } from '../assets.ts'
import {
  buildTools, buildSystemMessages, buildMetadata,
  buildBody, buildHeaders, extractMessageId,
} from './chat-payload.ts'

/**
 * chat: 逐字段照抄官方抓包(worker 层形态).
 *
 * @param {any} bridge Bridge 实例
 * @param {any} opts 参数(row / instanceId / runId / messages / tools / stream / layer)
 *   / reasoningEffort / noSend / streamStdout)
 * @returns {Promise<any>} chat 结果(status / text / messageId)
 */
export async function chat(bridge, opts) {
  const {
    row, instanceId, runId, messages, tools,
    stream = true,
    layer = 'worker',
    reasoningEffort = null,
    noSend = false,
    streamStdout = false,
    // 官方工具注入名单(undefined = 不裁剪). 由主服务解析好, 副仓只按名单过滤.
    officialToolNames = undefined,
    // 官方 system 提示词的处置(undefined = 照抄官方抓包原文).
    systemPrompt = undefined,
  } = opts;
  const url = `${bridge.host}/api/v1/chat/completions`;
  const { OFFICIAL_TOOLS, OFFICIAL_DECIDE, OFFICIAL_SYS } = await loadOfficialAssets();
  const outTools = buildTools(layer, tools, OFFICIAL_TOOLS, OFFICIAL_DECIDE, officialToolNames);
  const outMessages = buildSystemMessages(messages, layer, OFFICIAL_SYS, systemPrompt);
  const metadata = await buildMetadata({ bridge, layer, runId, instanceId, reasoningEffort });
  const body = buildBody({ row, metadata, outMessages, outTools, layer, stream });
  const hdrs = await buildHeaders(bridge, url, body);
  await dumpReq(`chat-${layer}`, 'POST', url, hdrs, body);
  if (noSend) return { status: 0, text: '(dry-run, not sent)' };

  const res = await fetch(url, { method: 'POST', headers: hdrs, body });

  /**
   * 流式边收边吐: 仅当调用方显式要求(streamStdout).
   * 其余调用方(以及所有非 chat action)保持"汇总行带正文"的旧契约不变.
   */
  if (streamStdout && stream && res.body) {
    /**
     * 状态行: 上游响应头一到就立刻报出去(在正文之前).
     *
     * 为什么必须有: 主服务要在"提交下游响应头"之前知道上游状态码, 否则 428/503
     * 会被包成 200 发给下游(错误被吞). 状态行用 '@' 前缀, 与 '>' 汇总行区分.
     */
    process.stdout.write('@' + JSON.stringify({ status: res.status }) + '\n');
    if (res.status !== 200) {
      const text = await res.text();
      return { status: res.status, text, messageId: extractMessageId(text) };
    }
    // 逐行原样写 stdout: 行尾 '\n' 必须保留 ---- 下游的 SSE 改写按行切分,
    // 且行形态要保持与上游逐字节一致.
    const decoder = new TextDecoder();
    let pending = '';
    let firstId = null;
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, nl + 1);
          pending = pending.slice(nl + 1);
          if (!firstId) firstId = extractMessageId(line);
          process.stdout.write(line);
        }
      }
      pending += decoder.decode();
      if (pending) {
        if (!firstId) firstId = extractMessageId(pending);
        process.stdout.write(pending);
        process.stdout.write('\n');
      }
    } finally {
      reader.releaseLock();
    }
    return { status: res.status, text: '', messageId: firstId, streamed: true };
  }

  const text = await res.text();
  const messageId = extractMessageId(text);
  return { status: res.status, text, messageId };
}
