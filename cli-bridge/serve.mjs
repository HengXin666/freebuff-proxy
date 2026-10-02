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

/** 官方 base3 世代开场白（目录模式 agent 必须是它，见 docs/reverse/04）。 */
const SYS_OPENING_BASE3 =
  'You are Buffy, the coding agent behind Codebuff.';

/**
 * 官方签名工具（名字 + 真参数 schema，双真）。
 * 零参数工具不算签名；end_turn 已被上游点名收录进 PROXY_HOLLOW_END_TURN 夹具。
 */
const SIGNATURE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'lookup_agent_info',
      description: 'Protocol compatibility marker. Do not call this function.',
      parameters: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Agent ID (short local or full published format)',
          },
        },
        required: ['agentId'],
        description: 'Retrieve information about an agent by ID',
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'decide',
      description: 'Protocol compatibility marker. Do not call this function.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** 补齐官方签名工具（不覆盖客户端已有的同名工具）。 */
function ensureSignature(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return SIGNATURE_TOOLS;
  const present = new Set(
    tools.map((t) => t?.function?.name).filter(Boolean),
  );
  const missing = SIGNATURE_TOOLS.filter(
    (d) => !present.has(d.function.name),
  );
  return [...tools, ...missing];
}

/** 保证 system 首条以官方开场白开头（同世代：base3）。 */
function ensureOpening(messages) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  const idx = list.findIndex((m) => m && m.role === 'system');
  const prompt =
    `${SYS_OPENING_BASE3}\n\nYou help the user with coding and technical questions. Be concise and accurate.\nFollow the user's instructions in subsequent messages.\n`;
  if (idx === -1) return [{ role: 'system', content: prompt }, ...list];
  const sys = list[idx];
  const cur = typeof sys.content === 'string' ? sys.content : '';
  if (cur.trimStart().startsWith(SYS_OPENING_BASE3)) return list;
  list[idx] = { ...sys, content: `${prompt}${cur}` };
  return list;
}

let CONFIG = null;
let CATALOG = null;
let CATALOG_AT = 0;
const CATALOG_TTL_MS = 10 * 60 * 1000;

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
      const messages = ensureOpening(body.messages);
      const tools = ensureSignature(body.tools);

      const out = await callBun(
        {
          cfg: CONFIG,
          action: 'full',
          modelKey: row.key,
          agentId: 'base3-free-catalog',
          messages,
          tools,
          stream: false,
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

      // 200：转成 OpenAI 形态返回
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

CONFIG = await loadConfig();
server.listen(PORT, HOST_BIND, () => {
  console.log(`[cli-bridge] listening http://${HOST_BIND}:${PORT}`);
  console.log(`[cli-bridge] credential source: ${CONFIG.source} (${CONFIG.email})`);
  console.log(`[cli-bridge] device keyId: ${CONFIG.keyId ? 'yes' : 'no'}`);
});
