/**
 - 请求处理(分流 + 三个端点)-- 从 cli-bridge/serve.ts 逐字搬出后合并.
 - 端点: GET /v1/models / POST /v1/chat/completions / GET /healthz.
 */
import { callBun } from '../../bridge.ts';
import { aggregateSse, json } from './wire.ts';
import { getCatalog, getConfig, resolveRow, toModelId } from './catalog.ts';


/**
 - 处理一个 HTTP 请求(与 createServer 回调签名一致).
 - @param {import('node:http').IncomingMessage} req 请求
 - @param {import('node:http').ServerResponse} res 响应
 - @returns {Promise<void>} 无返回值
 */
export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (url.pathname === '/v1/models') return handleModels(res);
  if (url.pathname === '/v1/chat/completions') return handleChat(req, res);

  return json(res, 404, { error: { message: 'not found' } });
}


/**
 - GET /v1/models: 列出目录里的模型(对外可读 id).
 - @param {import('node:http').ServerResponse} res 响应
 - @returns {Promise<void>} 无返回值
 */
export async function handleModels(res) {
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

/**
 - 上游非 200 时原样透传(保留业务码, 便于归因).
 - @param {import('node:http').ServerResponse} res 响应
 - @param {any} chat 上游 chat 回执
 - @param {any} out bun 回执(含 model/admit/startRun)
 * @returns {void} 无返回值
 */
function relayUpstreamError(res, chat, out) {
  const status = chat.status || 502;
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

/**
 - 把上游的 SSE / JSON 回执转成 OpenAI 非流式形态.
 -
 - 上游是 SSE(stream 恒 true), 非流式请求必须先聚合再返回,
 - 否则会把 data: {...} 原文塞进 content.
 - @param {import('node:http').ServerResponse} res 响应
 - @param {any} chat 上游 chat 回执
 - @param {string} model 客户端请求的 model
 * @returns {void} 无返回值
 */
function relayUpstreamOk(res, chat, model) {
  const sse = aggregateSse(chat.text || '');
  if (sse) {
    const msg = { role: 'assistant', content: sse.content || '' }
    if (sse.toolCalls.length) msg.tool_calls = sse.toolCalls
    return json(res, 200, {
      id: sse.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
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
      model,
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
    model,
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
}

/**
 - POST /v1/chat/completions: 转发一次 chat 并转成 OpenAI 形态.
 -
 - 不再在这里拼 system / 补签名工具 / 指定 agent -- 那些是副仓库的职责
 - (官方形态只在 cli-bridge 有一份). 这里只传原始 messages/tools.
 - stream 恒为 true: 官方链路就是流式的, 实测 stream=false 会 503.
 - @param {import('node:http').IncomingMessage} req 请求
 - @param {import('node:http').ServerResponse} res 响应
 - @returns {Promise<void>} 无返回值
 */
export async function handleChat(req, res) {
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
    const out = await callBun(
      {
        cfg: getConfig(),
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
    if ((chat.status || 502) !== 200) {
      return relayUpstreamError(res, chat, out);
    }
    return relayUpstreamOk(res, chat, body.model);
  } catch (e) {
    return json(res, 502, {
      error: { message: String(e.message), type: 'bridge_error' },
    });
  }
}
