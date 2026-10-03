/**
 * serve.mjs — OpenAI 兼容服务（Node 侧入口），上游请求交给 bun 执行。
 *
 * 端点：
 *   GET  /v1/models
 *   POST /v1/chat/completions      （stream / 非 stream）
 *   GET  /healthz
 *
 * 与 freebuff-proxy 的关系：**独立实现，不改动它**。
 * 本目录是验证「用官方 bun 运行时承载上游请求」的可行性，
 * 结论成立后再决定如何并回主项目。
 */

import { createServer } from 'node:http';
import { callBun, loadConfig, hasBun, BUN_BIN } from './bridge.mjs';

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

let CONFIG = null;
let CATALOG = null;
let CATALOG_AT = 0;
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * 把上游的 **SSE 流式响应**聚合成一次性结果。
 *
 * 为什么需要：上游是流式的（官方链路即流式，stream=false 实测 503），
 * 而下游客户端可能要非流式。不解析的话会把 `data: {...}` 原文塞进 content，
 * 客户端拿到一堆无法使用的文本（2026-10-03 实测踩到）。
 *
 * @param {string} text SSE 原文
 * @returns {{ content: string, toolCalls: any[], id: string|null, reasoning: string }|null}
 *   不是 SSE（或无有效块）时返回 null
 */
function aggregateSse(text) {
  const src = String(text || '');
  if (!src.includes('data:') && !src.startsWith('{')) return null
  let content = ''
  let reasoning = ''
  let id = null
  /** @type {any[]} */
  const toolCalls = []
  let sawChunk = false
  for (const line of src.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let j = null
    try { j = JSON.parse(payload) } catch { continue }
    if (!j || typeof j !== 'object') continue
    sawChunk = true
    if (j.id && !id) id = j.id
    for (const c of j.choices || []) {
      const d = c.delta || {}
      if (typeof d.content === 'string') content += d.content
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? toolCalls.length
          if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (tc.id) toolCalls[i].id = tc.id
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
        }
      }
    }
  }
  if (!sawChunk) return null
  return { content, toolCalls: toolCalls.filter(Boolean), id, reasoning }
}

async function getCatalog(force = false) {
  const fresh = CATALOG && Date.now() - CATALOG_AT < CATALOG_TTL_MS;
  if (fresh && !force) return CATALOG;
  const r = await callBun({ cfg: CONFIG, action: 'catalog' });
  if (!r.catalog) throw new Error(r.error || 'catalog failed');
  CATALOG = r.catalog;
  CATALOG_AT = Date.now();
  return CATALOG;
}

function toModelId(row) {
  // 对外暴露可读 id：优先 legacy 风格名，回落到 key
  return row.displayName ? String(row.displayName).toLowerCase() : row.key;
}

function resolveRow(catalog, wanted) {
  if (!wanted) return null;
  const w = String(wanted);
  return (
    catalog.rows.find((r) => r.key === w) ||
    catalog.rows.find((r) => r.handle === w) ||
    catalog.rows.find((r) => toModelId(r) === w) ||
    catalog.rows.find((r) => String(r.displayName) === w) ||
    null
  );
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });

  if (url.pathname === '/v1/models') {
    try {
      const cat = await getCatalog();
      return json(res, 200, {
        object: 'list',
        data: cat.rows.map((r) => ({
          id: toModelId(r),
          object: 'model',
          created: Math.floor((cat.issuedAt || Date.now()) / 1000),
          owned_by: 'freebuff',
        })),
      });
    } catch (e) {
      return json(res, 502, { error: { message: String(e.message) } });
    }
  }

  if (url.pathname === '/v1/chat/completions') {
    if (req.method !== 'POST') {
      return json(res, 405, { error: { message: 'Use POST' } });
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { error: { message: 'invalid JSON body' } });
    }

    try {
      const cat = await getCatalog();
      const row = resolveRow(cat, body.model);
      if (!row) {
        return json(res, 400, {
          error: {
            message: `unknown model: ${body.model}`,
            type: 'invalid_request_error',
          },
        });
      }
      // ⚠️ 不再在这里拼 system / 补签名工具 / 指定 agent —— 那些是**副仓库**
      // 的职责（官方形态只在 cli-bridge 有一份）。这里只传原始 messages/tools。
      //
      // ⚠️ stream 恒为 true：官方链路就是流式的，实测 stream=false 会 503。
      const out = await callBun(
        {
          cfg: CONFIG,
          action: 'full',
          modelKey: row.key,
          messages: body.messages,
          tools: body.tools,
          layer: 'worker',
          stream: true,
        },
        180_000,
      );

      if (out.error) {
        return json(res, 502, {
          error: { message: out.error, type: 'upstream_error' },
        });
      }
      const chat = out.chat || {};
      const status = chat.status || 502;

      // 上游非 200：原样透传（保留业务码，便于归因）
      if (status !== 200) {
        let parsed = null;
        try {
          parsed = JSON.parse(chat.text || '');
        } catch { /* 非 JSON */ }
        return json(res, status === 502 ? 502 : status, {
          error: {
            message: parsed?.error?.message || chat.text || 'upstream error',
            code: parsed?.error?.code || parsed?.error || null,
            type: 'upstream_error',
            model: out.model,
            stages: { admit: out.admit, startRun: out.startRun },
          },
        });
      }

      // 200：转成 OpenAI 形态返回。
      // ⚠️ 上游是 SSE（stream 恒 true），非流式请求必须**先聚合**再返回，
      // 否则会把 `data: {...}` 原文塞进 content。
      const sse = aggregateSse(chat.text || '');
      if (sse) {
        const msg = { role: 'assistant', content: sse.content || '' }
        if (sse.toolCalls.length) msg.tool_calls = sse.toolCalls
        return json(res, 200, {
          id: sse.id || `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: msg,
              finish_reason: sse.toolCalls.length ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      let parsed = null;
      try {
        parsed = JSON.parse(chat.text || '');
      } catch {
        parsed = null;
      }
      if (!parsed) {
        return json(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: chat.text },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      const choice = parsed.choices?.[0] || {};
      const msg = choice.message || {};
      return json(res, 200, {
        id: parsed.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: parsed.created || Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: msg.content ?? '',
              ...(Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
                ? { tool_calls: msg.tool_calls }
                : {}),
            },
            finish_reason: choice.finish_reason || 'stop',
          },
        ],
        usage: parsed.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    } catch (e) {
      return json(res, 502, {
        error: { message: String(e.message), type: 'bridge_error' },
      });
    }
  }

  return json(res, 404, { error: { message: 'not found' } });
});

// 可用环境变量指定账号（客户端未登录 / 想用另一个号时）。
// 例：FREEBUFF_TOKEN=xxx FREEBUFF_USER_ID=xxx node serve.mjs
//
// 为什么需要：loadConfig() 默认读官方客户端的登录态，一台机器同时只有
// 一个登录账号；而多账号池场景常常要显式指定用哪个号。
const override = {}
if (process.env.FREEBUFF_TOKEN) override.token = process.env.FREEBUFF_TOKEN
if (process.env.FREEBUFF_USER_ID) override.userId = process.env.FREEBUFF_USER_ID
if (process.env.FREEBUFF_INSTALL_ID) {
  override.installId = process.env.FREEBUFF_INSTALL_ID
}
CONFIG = await loadConfig(override);
server.listen(PORT, HOST_BIND, () => {
  console.log(`[cli-bridge] listening http://${HOST_BIND}:${PORT}`);
  console.log(`[cli-bridge] credential source: ${CONFIG.source} (${CONFIG.email})`);
  console.log(`[cli-bridge] device keyId: ${CONFIG.keyId ? 'yes' : 'no'}`);
});
